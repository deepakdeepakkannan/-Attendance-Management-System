const express = require('express');
const { EventEmitter } = require('node:events');
const { queryAll, queryGet, queryRun, db } = require('../db');
const { 
  hashPassword, 
  verifyPassword, 
  generateToken, 
  requireAuth, 
  requireRole 
} = require('../auth');
const { 
  generateSessionToken, 
  verifyScannedToken, 
  TOKEN_VALIDITY_SECONDS 
} = require('../qrEngine');

const router = express.Router();
const eventBus = new EventEmitter();

// ==========================================
// 1. AUTHENTICATION & PROFILE
// ==========================================

router.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Please provide both email and password.' });
  }

  const user = queryGet('SELECT * FROM users WHERE email = ? AND is_active = 1', [email.trim().toLowerCase()]);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  }

  // Fetch role-specific profiles
  let studentProfile = null;
  let facultyProfile = null;

  if (user.role === 'student') {
    studentProfile = queryGet(`
      SELECT s.id as student_id, s.roll_number, s.class_id, c.name as class_name, c.section as class_section, c.semester
      FROM students s
      JOIN classes c ON s.class_id = c.id
      WHERE s.user_id = ?
    `, [user.id]);
  } else if (user.role === 'faculty') {
    facultyProfile = queryGet(`
      SELECT f.id as faculty_id, f.employee_id, f.department, f.designation
      FROM faculty f
      WHERE f.user_id = ?
    `, [user.id]);
  }

  const payload = {
    id: user.id,
    email: user.email,
    role: user.role,
    full_name: user.full_name,
    student_id: studentProfile ? studentProfile.student_id : null,
    faculty_id: facultyProfile ? facultyProfile.faculty_id : null,
    roll_number: studentProfile ? studentProfile.roll_number : null,
    class_id: studentProfile ? studentProfile.class_id : null
  };

  const token = generateToken(payload);

  res.json({
    success: true,
    token,
    user: {
      ...payload,
      phone: user.phone,
      studentProfile,
      facultyProfile
    }
  });
});

router.get('/auth/me', requireAuth, (req, res) => {
  let studentProfile = null;
  let facultyProfile = null;

  if (req.user.role === 'student') {
    studentProfile = queryGet(`
      SELECT s.id as student_id, s.roll_number, s.class_id, c.name as class_name, c.section as class_section, c.semester
      FROM students s
      JOIN classes c ON s.class_id = c.id
      WHERE s.user_id = ?
    `, [req.user.id]);
  } else if (req.user.role === 'faculty') {
    facultyProfile = queryGet(`
      SELECT f.id as faculty_id, f.employee_id, f.department, f.designation
      FROM faculty f
      WHERE f.user_id = ?
    `, [req.user.id]);
  }

  res.json({
    success: true,
    user: {
      ...req.user,
      studentProfile,
      facultyProfile
    }
  });
});

// ==========================================
// 2. STUDENT PORTAL ENDPOINTS
// ==========================================

router.get('/student/dashboard', requireAuth, requireRole('student'), (req, res) => {
  const student = queryGet('SELECT * FROM students WHERE user_id = ?', [req.user.id]);
  if (!student) {
    return res.status(404).json({ success: false, message: 'Student record not found.' });
  }

  const todayStr = new Date().toISOString().split('T')[0];

  // 1. Overall stats
  const totalSessions = queryGet(`
    SELECT COUNT(*) as count 
    FROM sessions s 
    WHERE s.class_id = ? AND (s.session_date < ? OR s.status = 'closed')
  `, [student.class_id, todayStr]).count;

  const attendedSessions = queryGet(`
    SELECT COUNT(*) as count
    FROM attendance a
    JOIN sessions s ON a.session_id = s.id
    WHERE a.student_id = ? AND a.status IN ('present', 'late')
  `, [student.id]).count;

  const overallPercentage = totalSessions > 0 
    ? Math.round((attendedSessions / totalSessions) * 100) 
    : 100;

  // 2. Subject-wise percentage breakdown
  const subjects = queryAll(`
    SELECT 
      sub.id as subject_id,
      sub.code,
      sub.name,
      f_user.full_name as faculty_name,
      (
        SELECT COUNT(*) 
        FROM sessions s 
        WHERE s.subject_id = sub.id AND (s.session_date < ? OR s.status = 'closed')
      ) as total_conducted,
      (
        SELECT COUNT(*) 
        FROM attendance a
        JOIN sessions s ON a.session_id = s.id
        WHERE s.subject_id = sub.id AND a.student_id = ? AND a.status IN ('present', 'late')
      ) as attended_count
    FROM subjects sub
    JOIN faculty f ON sub.faculty_id = f.id
    JOIN users f_user ON f.user_id = f_user.id
    WHERE sub.class_id = ?
  `, [todayStr, student.id, student.class_id]);

  const subjectStats = subjects.map(s => {
    const percentage = s.total_conducted > 0 
      ? Math.round((s.attended_count / s.total_conducted) * 100) 
      : 100;
    return {
      ...s,
      percentage,
      isDefaulter: percentage < 75
    };
  });

  // 3. Today's sessions & attendance status
  const todaySessions = queryAll(`
    SELECT 
      s.id as session_id,
      s.session_type,
      s.session_date,
      s.status as session_status,
      s.topic,
      sub.code as subject_code,
      sub.name as subject_name,
      f_user.full_name as faculty_name,
      a.status as my_attendance_status,
      a.marked_at,
      a.verification_method
    FROM sessions s
    JOIN subjects sub ON s.subject_id = sub.id
    JOIN faculty f ON s.faculty_id = f.id
    JOIN users f_user ON f.user_id = f_user.id
    LEFT JOIN attendance a ON a.session_id = s.id AND a.student_id = ?
    WHERE s.class_id = ? AND s.session_date = ?
    ORDER BY s.session_type ASC, s.id DESC
  `, [student.id, student.class_id, todayStr]);

  // 4. Any live active session for scanning right now
  const activeSession = queryGet(`
    SELECT 
      s.id,
      s.session_type,
      s.topic,
      sub.code as subject_code,
      sub.name as subject_name,
      f_user.full_name as faculty_name,
      a.status as already_marked
    FROM sessions s
    JOIN subjects sub ON s.subject_id = sub.id
    JOIN faculty f ON s.faculty_id = f.id
    JOIN users f_user ON f.user_id = f_user.id
    LEFT JOIN attendance a ON a.session_id = s.id AND a.student_id = ?
    WHERE s.class_id = ? AND s.status = 'active'
    ORDER BY s.id DESC
    LIMIT 1
  `, [student.id, student.class_id]);

  // 5. Unread notifications count
  const unreadNotifs = queryGet(`
    SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0
  `, [req.user.id]).count;

  res.json({
    success: true,
    overview: {
      totalSessions,
      attendedSessions,
      overallPercentage,
      isDefaulter: overallPercentage < 75,
      unreadNotifs
    },
    todaySessions,
    activeSession,
    subjectStats
  });
});

router.post('/student/scan', requireAuth, requireRole('student'), (req, res) => {
  const { sessionId, token, rawPayload } = req.body;
  let targetSessionId = sessionId;
  let targetToken = token;

  // Support either direct { sessionId, token } or raw scanned QR payload string
  if (rawPayload && (!targetSessionId || !targetToken)) {
    try {
      const parsed = JSON.parse(rawPayload);
      targetSessionId = parsed.sId;
      targetToken = parsed.token;
    } catch (e) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid QR code format. Please scan a valid Smart Attendance QR code.' 
      });
    }
  }

  if (!targetSessionId || !targetToken) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing session ID or authentication token in QR scan.' 
    });
  }

  const student = queryGet('SELECT * FROM students WHERE user_id = ?', [req.user.id]);
  if (!student) {
    return res.status(404).json({ success: false, message: 'Student record not found.' });
  }

  // 1. Verify dynamic QR token & session state
  const verification = verifyScannedToken(targetSessionId, targetToken);
  if (!verification.valid) {
    return res.status(400).json({ 
      success: false, 
      message: verification.error 
    });
  }

  const session = verification.session;

  // 2. Class enrollment check
  if (session.class_id !== student.class_id) {
    return res.status(403).json({ 
      success: false, 
      message: 'Access Denied: You are not enrolled in the class for this session.' 
    });
  }

  // 3. Duplicate Prevention
  const existingAttendance = queryGet(`
    SELECT * FROM attendance WHERE session_id = ? AND student_id = ?
  `, [targetSessionId, student.id]);

  if (existingAttendance) {
    return res.status(409).json({ 
      success: false, 
      message: `Duplicate Scan Detected: You have already marked attendance for this session at ${existingAttendance.marked_at}.` 
    });
  }

  // 4. Mark attendance
  const markedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
  queryRun(`
    INSERT INTO attendance (session_id, student_id, status, verification_method, marked_at)
    VALUES (?, ?, 'present', 'qr_scan', ?)
  `, [targetSessionId, student.id, markedAt]);

  // 5. Create notification for student
  queryRun(`
    INSERT INTO notifications (user_id, title, message, type)
    VALUES (?, ?, ?, 'success')
  `, [
    req.user.id,
    'Attendance Verified ✓',
    `Marked PRESENT for ${session.subject_code} - ${session.subject_name} (${session.session_type.toUpperCase()} session).`
  ]);

  // 6. Broadcast Real-time event to faculty live roster
  eventBus.emit(`session:${targetSessionId}`, {
    event: 'student_scanned',
    data: {
      studentId: student.id,
      rollNumber: student.roll_number,
      fullName: req.user.full_name,
      status: 'present',
      markedAt,
      verificationMethod: 'qr_scan'
    }
  });

  res.json({
    success: true,
    message: `Attendance marked successfully for ${session.subject_name}!`,
    details: {
      sessionId: targetSessionId,
      subjectCode: session.subject_code,
      subjectName: session.subject_name,
      sessionType: session.session_type,
      markedAt,
      status: 'present'
    }
  });
});

router.get('/student/history', requireAuth, requireRole('student'), (req, res) => {
  const student = queryGet('SELECT * FROM students WHERE user_id = ?', [req.user.id]);
  if (!student) {
    return res.status(404).json({ success: false, message: 'Student record not found.' });
  }

  const { subjectId, sessionType, status, startDate, endDate } = req.query;

  let sql = `
    SELECT 
      a.id as attendance_id,
      a.status,
      a.verification_method,
      a.marked_at,
      a.remarks,
      s.id as session_id,
      s.session_date,
      s.session_type,
      s.topic,
      sub.code as subject_code,
      sub.name as subject_name,
      f_user.full_name as faculty_name
    FROM attendance a
    JOIN sessions s ON a.session_id = s.id
    JOIN subjects sub ON s.subject_id = sub.id
    JOIN faculty f ON s.faculty_id = f.id
    JOIN users f_user ON f.user_id = f_user.id
    WHERE a.student_id = ?
  `;
  const params = [student.id];

  if (subjectId) {
    sql += ' AND s.subject_id = ?';
    params.push(subjectId);
  }
  if (sessionType) {
    sql += ' AND s.session_type = ?';
    params.push(sessionType);
  }
  if (status) {
    sql += ' AND a.status = ?';
    params.push(status);
  }
  if (startDate) {
    sql += ' AND s.session_date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    sql += ' AND s.session_date <= ?';
    params.push(endDate);
  }

  sql += ' ORDER BY s.session_date DESC, s.id DESC';

  const history = queryAll(sql, params);
  res.json({ success: true, history });
});

router.get('/student/notifications', requireAuth, (req, res) => {
  const notifs = queryAll(`
    SELECT * FROM notifications 
    WHERE user_id = ? 
    ORDER BY created_at DESC 
    LIMIT 30
  `, [req.user.id]);

  res.json({ success: true, notifications: notifs });
});

router.post('/student/notifications/read-all', requireAuth, (req, res) => {
  queryRun('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
  res.json({ success: true, message: 'All notifications marked as read.' });
});

// ==========================================
// 3. FACULTY PORTAL ENDPOINTS
// ==========================================

router.get('/faculty/meta', requireAuth, requireRole('faculty'), (req, res) => {
  const faculty = queryGet('SELECT * FROM faculty WHERE user_id = ?', [req.user.id]);
  if (!faculty) {
    return res.status(404).json({ success: false, message: 'Faculty profile not found.' });
  }

  const subjects = queryAll(`
    SELECT sub.*, c.name as class_name, c.section as class_section, c.semester
    FROM subjects sub
    JOIN classes c ON sub.class_id = c.id
    WHERE sub.faculty_id = ?
    ORDER BY sub.name ASC
  `, [faculty.id]);

  const classes = queryAll(`
    SELECT DISTINCT c.*
    FROM classes c
    JOIN subjects sub ON sub.class_id = c.id
    WHERE sub.faculty_id = ?
    ORDER BY c.name ASC, c.section ASC
  `, [faculty.id]);

  res.json({ success: true, faculty, subjects, classes });
});

router.post('/faculty/sessions/start', requireAuth, requireRole('faculty'), async (req, res) => {
  const faculty = queryGet('SELECT * FROM faculty WHERE user_id = ?', [req.user.id]);
  if (!faculty) {
    return res.status(404).json({ success: false, message: 'Faculty profile not found.' });
  }

  const { classId, subjectId, sessionType, topic, durationMinutes = 30 } = req.body;
  if (!classId || !subjectId || !sessionType) {
    return res.status(400).json({ success: false, message: 'Class, Subject, and Session Type (Morning/Afternoon) are required.' });
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const durationMs = parseInt(durationMinutes, 10) * 60 * 1000;
  const sessionExpiresAt = Date.now() + durationMs;

  // Close any active session for this faculty to prevent conflicts
  queryRun(`UPDATE sessions SET status = 'closed' WHERE faculty_id = ? AND status = 'active'`, [faculty.id]);

  const insert = queryRun(`
    INSERT INTO sessions (subject_id, class_id, faculty_id, session_type, session_date, session_expires_at, status, topic)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `, [subjectId, classId, faculty.id, sessionType, todayStr, sessionExpiresAt, topic || `Lecture Session - ${sessionType.toUpperCase()}`]);

  const sessionId = Number(insert.lastInsertRowid);

  // Generate initial dynamic rotating token & QR
  const qrData = await generateSessionToken(sessionId);

  const session = queryGet(`
    SELECT s.*, sub.code as subject_code, sub.name as subject_name, c.name as class_name, c.section as class_section
    FROM sessions s
    JOIN subjects sub ON s.subject_id = sub.id
    JOIN classes c ON s.class_id = c.id
    WHERE s.id = ?
  `, [sessionId]);

  res.json({
    success: true,
    message: 'Attendance session started successfully!',
    session,
    qr: qrData
  });
});

router.get('/faculty/sessions/active', requireAuth, requireRole('faculty'), async (req, res) => {
  const faculty = queryGet('SELECT * FROM faculty WHERE user_id = ?', [req.user.id]);
  if (!faculty) {
    return res.status(404).json({ success: false, message: 'Faculty profile not found.' });
  }

  const activeSession = queryGet(`
    SELECT s.*, sub.code as subject_code, sub.name as subject_name, c.name as class_name, c.section as class_section
    FROM sessions s
    JOIN subjects sub ON s.subject_id = sub.id
    JOIN classes c ON s.class_id = c.id
    WHERE s.faculty_id = ? AND s.status = 'active'
    ORDER BY s.id DESC
    LIMIT 1
  `, [faculty.id]);

  if (!activeSession) {
    return res.json({ success: true, activeSession: null });
  }

  // Check if session has expired by duration
  if (activeSession.session_expires_at && Date.now() > activeSession.session_expires_at) {
    queryRun(`UPDATE sessions SET status = 'closed' WHERE id = ?`, [activeSession.id]);
    return res.json({ success: true, activeSession: null, message: 'Previous session expired.' });
  }

  // Generate or refresh dynamic QR code
  const qrData = await generateSessionToken(activeSession.id);

  res.json({
    success: true,
    activeSession,
    qr: qrData
  });
});

router.get('/faculty/sessions/:id/rotate-qr', requireAuth, requireRole('faculty'), async (req, res) => {
  const sessionId = req.params.id;
  try {
    const qrData = await generateSessionToken(sessionId);
    // Broadcast token update
    eventBus.emit(`session:${sessionId}`, {
      event: 'token_rotated',
      data: { expiresAt: qrData.expiresAt }
    });
    res.json({ success: true, qr: qrData });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.post('/faculty/sessions/:id/close', requireAuth, requireRole('faculty'), (req, res) => {
  const sessionId = req.params.id;
  const session = queryGet('SELECT * FROM sessions WHERE id = ?', [sessionId]);
  if (!session) {
    return res.status(404).json({ success: false, message: 'Session not found.' });
  }

  queryRun(`UPDATE sessions SET status = 'closed' WHERE id = ?`, [sessionId]);

  // Mark all enrolled students who did not scan as 'absent'
  const enrolledStudents = queryAll('SELECT id FROM students WHERE class_id = ?', [session.class_id]);
  const markedStudents = queryAll('SELECT student_id FROM attendance WHERE session_id = ?', [sessionId]);
  const markedIds = new Set(markedStudents.map(m => m.student_id));

  for (const s of enrolledStudents) {
    if (!markedIds.has(s.id)) {
      queryRun(`
        INSERT INTO attendance (session_id, student_id, status, verification_method, marked_at)
        VALUES (?, ?, 'absent', 'manual', CURRENT_TIMESTAMP)
      `, [sessionId, s.id]);
    }
  }

  // Broadcast session closed
  eventBus.emit(`session:${sessionId}`, {
    event: 'session_closed',
    data: { sessionId }
  });

  res.json({ success: true, message: 'Session closed successfully and student records finalized.' });
});

router.get('/faculty/sessions/:id/live', requireAuth, requireRole('faculty'), (req, res) => {
  const sessionId = req.params.id;
  const session = queryGet(`
    SELECT s.*, sub.code as subject_code, sub.name as subject_name, c.name as class_name, c.section as class_section
    FROM sessions s
    JOIN subjects sub ON s.subject_id = sub.id
    JOIN classes c ON s.class_id = c.id
    WHERE s.id = ?
  `, [sessionId]);

  if (!session) {
    return res.status(404).json({ success: false, message: 'Session not found.' });
  }

  // Get all enrolled students in the class and their attendance status for this session
  const roster = queryAll(`
    SELECT 
      stu.id as student_id,
      stu.roll_number,
      u.full_name,
      u.email,
      a.id as attendance_id,
      a.status as attendance_status,
      a.verification_method,
      a.marked_at,
      a.remarks
    FROM students stu
    JOIN users u ON stu.user_id = u.id
    LEFT JOIN attendance a ON a.student_id = stu.id AND a.session_id = ?
    WHERE stu.class_id = ?
    ORDER BY stu.roll_number ASC
  `, [sessionId, session.class_id]);

  const totalEnrolled = roster.length;
  const presentCount = roster.filter(r => r.attendance_status === 'present').length;
  const absentCount = roster.filter(r => r.attendance_status === 'absent').length;
  const lateCount = roster.filter(r => r.attendance_status === 'late').length;
  const pendingCount = roster.filter(r => !r.attendance_status).length;

  res.json({
    success: true,
    session,
    counts: {
      totalEnrolled,
      presentCount,
      absentCount,
      lateCount,
      pendingCount
    },
    roster
  });
});

router.post('/faculty/sessions/:id/manual-mark', requireAuth, requireRole('faculty'), (req, res) => {
  const sessionId = req.params.id;
  const { studentId, status, remarks } = req.body;

  if (!studentId || !status) {
    return res.status(400).json({ success: false, message: 'Student ID and Status (present/absent/late/excused) are required.' });
  }

  const existing = queryGet(`SELECT id FROM attendance WHERE session_id = ? AND student_id = ?`, [sessionId, studentId]);
  const markedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);

  if (existing) {
    queryRun(`
      UPDATE attendance 
      SET status = ?, verification_method = 'manual', remarks = ?, marked_at = ?
      WHERE id = ?
    `, [status, remarks || 'Manual override by faculty', markedAt, existing.id]);
  } else {
    queryRun(`
      INSERT INTO attendance (session_id, student_id, status, verification_method, marked_at, remarks)
      VALUES (?, ?, ?, 'manual', ?, ?)
    `, [sessionId, studentId, status, markedAt, remarks || 'Manual mark by faculty']);
  }

  const studentUser = queryGet(`
    SELECT stu.roll_number, u.full_name 
    FROM students stu 
    JOIN users u ON stu.user_id = u.id 
    WHERE stu.id = ?
  `, [studentId]);

  // Broadcast change
  eventBus.emit(`session:${sessionId}`, {
    event: 'student_scanned',
    data: {
      studentId: parseInt(studentId, 10),
      rollNumber: studentUser ? studentUser.roll_number : '',
      fullName: studentUser ? studentUser.full_name : '',
      status,
      markedAt,
      verificationMethod: 'manual'
    }
  });

  res.json({ success: true, message: 'Attendance status updated successfully.' });
});

router.get('/faculty/history', requireAuth, requireRole('faculty'), (req, res) => {
  const faculty = queryGet('SELECT * FROM faculty WHERE user_id = ?', [req.user.id]);
  if (!faculty) {
    return res.status(404).json({ success: false, message: 'Faculty profile not found.' });
  }

  const sessions = queryAll(`
    SELECT 
      s.id,
      s.session_date,
      s.session_type,
      s.status,
      s.topic,
      s.created_at,
      sub.code as subject_code,
      sub.name as subject_name,
      c.name as class_name,
      c.section as class_section,
      (SELECT COUNT(*) FROM students stu WHERE stu.class_id = s.class_id) as enrolled_count,
      (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id AND a.status = 'present') as present_count
    FROM sessions s
    JOIN subjects sub ON s.subject_id = sub.id
    JOIN classes c ON s.class_id = c.id
    WHERE s.faculty_id = ?
    ORDER BY s.session_date DESC, s.id DESC
  `, [faculty.id]);

  res.json({ success: true, sessions });
});

router.get('/faculty/reports', requireAuth, requireRole('faculty'), (req, res) => {
  const faculty = queryGet('SELECT * FROM faculty WHERE user_id = ?', [req.user.id]);
  if (!faculty) {
    return res.status(404).json({ success: false, message: 'Faculty profile not found.' });
  }

  const { classId, subjectId } = req.query;

  let studentsSql = `
    SELECT 
      stu.id as student_id,
      stu.roll_number,
      u.full_name,
      u.email,
      c.name as class_name,
      c.section as class_section
    FROM students stu
    JOIN users u ON stu.user_id = u.id
    JOIN classes c ON stu.class_id = c.id
    JOIN subjects sub ON sub.class_id = c.id
    WHERE sub.faculty_id = ?
  `;
  const params = [faculty.id];

  if (classId) {
    studentsSql += ' AND c.id = ?';
    params.push(classId);
  }
  if (subjectId) {
    studentsSql += ' AND sub.id = ?';
    params.push(subjectId);
  }

  studentsSql += ' GROUP BY stu.id ORDER BY stu.roll_number ASC';

  const studentList = queryAll(studentsSql, params);

  // Compute attendance stats per student
  const report = studentList.map(stu => {
    let sessFilter = `WHERE s.class_id = (SELECT class_id FROM students WHERE id = ?) AND s.faculty_id = ?`;
    let countParams = [stu.student_id, faculty.id];
    if (subjectId) {
      sessFilter += ` AND s.subject_id = ?`;
      countParams.push(subjectId);
    }

    const totalConducted = queryGet(`
      SELECT COUNT(*) as count FROM sessions s ${sessFilter}
    `, countParams).count;

    let attFilter = `
      JOIN sessions s ON a.session_id = s.id 
      WHERE a.student_id = ? AND s.faculty_id = ? AND a.status IN ('present', 'late')
    `;
    let attParams = [stu.student_id, faculty.id];
    if (subjectId) {
      attFilter += ` AND s.subject_id = ?`;
      attParams.push(subjectId);
    }

    const totalAttended = queryGet(`
      SELECT COUNT(*) as count FROM attendance a ${attFilter}
    `, attParams).count;

    const percentage = totalConducted > 0 
      ? Math.round((totalAttended / totalConducted) * 100) 
      : 100;

    return {
      ...stu,
      totalConducted,
      totalAttended,
      percentage,
      isDefaulter: percentage < 75
    };
  });

  const defaulters = report.filter(r => r.isDefaulter);

  res.json({
    success: true,
    totalStudents: report.length,
    defaultersCount: defaulters.length,
    report,
    defaulters
  });
});

// ==========================================
// 4. ADMIN PORTAL ENDPOINTS
// ==========================================

router.get('/admin/stats', requireAuth, requireRole('admin'), (req, res) => {
  const totalStudents = queryGet('SELECT COUNT(*) as count FROM students').count;
  const totalFaculty = queryGet('SELECT COUNT(*) as count FROM faculty').count;
  const totalClasses = queryGet('SELECT COUNT(*) as count FROM classes').count;
  const totalSubjects = queryGet('SELECT COUNT(*) as count FROM subjects').count;
  const totalSessions = queryGet('SELECT COUNT(*) as count FROM sessions').count;
  const totalAttendance = queryGet('SELECT COUNT(*) as count FROM attendance WHERE status = "present"').count;

  const todayStr = new Date().toISOString().split('T')[0];
  const todaySessions = queryGet('SELECT COUNT(*) as count FROM sessions WHERE session_date = ?', [todayStr]).count;
  const todayAttendance = queryGet(`
    SELECT COUNT(*) as count 
    FROM attendance a 
    JOIN sessions s ON a.session_id = s.id 
    WHERE s.session_date = ? AND a.status = 'present'
  `, [todayStr]).count;

  // Defaulters list across whole institution (< 75%)
  const allStudents = queryAll(`
    SELECT 
      stu.id as student_id,
      stu.roll_number,
      u.full_name,
      u.email,
      c.name as class_name,
      c.section as class_section,
      (SELECT COUNT(*) FROM sessions s WHERE s.class_id = stu.class_id) as total_sessions,
      (SELECT COUNT(*) FROM attendance a WHERE a.student_id = stu.id AND a.status IN ('present', 'late')) as attended_sessions
    FROM students stu
    JOIN users u ON stu.user_id = u.id
    JOIN classes c ON stu.class_id = c.id
  `);

  const defaulters = allStudents
    .map(s => {
      const percentage = s.total_sessions > 0 ? Math.round((s.attended_sessions / s.total_sessions) * 100) : 100;
      return { ...s, percentage };
    })
    .filter(s => s.total_sessions > 0 && s.percentage < 75);

  res.json({
    success: true,
    stats: {
      totalStudents,
      totalFaculty,
      totalClasses,
      totalSubjects,
      totalSessions,
      totalAttendance,
      todaySessions,
      todayAttendance,
      defaultersCount: defaulters.length
    },
    defaulters
  });
});

// Student Management
router.get('/admin/students', requireAuth, requireRole('admin'), (req, res) => {
  const students = queryAll(`
    SELECT 
      stu.id as student_id,
      stu.roll_number,
      stu.batch_year,
      stu.class_id,
      u.id as user_id,
      u.full_name,
      u.email,
      u.phone,
      c.name as class_name,
      c.section as class_section,
      c.semester
    FROM students stu
    JOIN users u ON stu.user_id = u.id
    JOIN classes c ON stu.class_id = c.id
    ORDER BY stu.roll_number ASC
  `);
  res.json({ success: true, students });
});

router.post('/admin/students', requireAuth, requireRole('admin'), (req, res) => {
  const { fullName, email, password, rollNumber, classId, phone, batchYear } = req.body;
  if (!fullName || !email || !password || !rollNumber || !classId) {
    return res.status(400).json({ success: false, message: 'All fields (Name, Email, Password, Roll Number, Class) are required.' });
  }

  try {
    const pHash = hashPassword(password);
    const userInsert = queryRun(`
      INSERT INTO users (email, password_hash, role, full_name, phone)
      VALUES (?, ?, 'student', ?, ?)
    `, [email.trim().toLowerCase(), pHash, fullName, phone || null]);

    const userId = Number(userInsert.lastInsertRowid);
    const stuInsert = queryRun(`
      INSERT INTO students (user_id, roll_number, class_id, batch_year)
      VALUES (?, ?, ?, ?)
    `, [userId, rollNumber.trim().toUpperCase(), classId, batchYear || '2024-2028']);

    res.json({ success: true, message: 'Student created successfully!', studentId: Number(stuInsert.lastInsertRowid) });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ success: false, message: 'A user with this email or roll number already exists.' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/admin/students/:id', requireAuth, requireRole('admin'), (req, res) => {
  const studentId = req.params.id;
  const { fullName, email, rollNumber, classId, phone } = req.body;

  const stu = queryGet('SELECT * FROM students WHERE id = ?', [studentId]);
  if (!stu) return res.status(404).json({ success: false, message: 'Student not found.' });

  queryRun(`UPDATE users SET full_name = ?, email = ?, phone = ? WHERE id = ?`, [fullName, email.trim().toLowerCase(), phone || null, stu.user_id]);
  queryRun(`UPDATE students SET roll_number = ?, class_id = ? WHERE id = ?`, [rollNumber.trim().toUpperCase(), classId, studentId]);

  res.json({ success: true, message: 'Student updated successfully.' });
});

router.delete('/admin/students/:id', requireAuth, requireRole('admin'), (req, res) => {
  const studentId = req.params.id;
  const stu = queryGet('SELECT user_id FROM students WHERE id = ?', [studentId]);
  if (!stu) return res.status(404).json({ success: false, message: 'Student not found.' });

  queryRun('DELETE FROM users WHERE id = ?', [stu.user_id]);
  res.json({ success: true, message: 'Student deleted successfully.' });
});

// Faculty Management
router.get('/admin/faculty', requireAuth, requireRole('admin'), (req, res) => {
  const faculty = queryAll(`
    SELECT 
      f.id as faculty_id,
      f.employee_id,
      f.department,
      f.designation,
      u.id as user_id,
      u.full_name,
      u.email,
      u.phone
    FROM faculty f
    JOIN users u ON f.user_id = u.id AND u.is_active = 1
    ORDER BY u.full_name ASC
  `);
  res.json({ success: true, faculty });
});

router.post('/admin/faculty', requireAuth, requireRole('admin'), (req, res) => {
  const { fullName, email, password, employeeId, department, designation, phone } = req.body;
  if (!fullName || !email || !password || !employeeId || !department) {
    return res.status(400).json({ success: false, message: 'Name, Email, Password, Employee ID, and Department are required.' });
  }

  try {
    const pHash = hashPassword(password);
    const userInsert = queryRun(`
      INSERT INTO users (email, password_hash, role, full_name, phone)
      VALUES (?, ?, 'faculty', ?, ?)
    `, [email.trim().toLowerCase(), pHash, fullName, phone || null]);

    const userId = Number(userInsert.lastInsertRowid);
    const facInsert = queryRun(`
      INSERT INTO faculty (user_id, employee_id, department, designation)
      VALUES (?, ?, ?, ?)
    `, [userId, employeeId.trim().toUpperCase(), department, designation || 'Assistant Professor']);

    res.json({ success: true, message: 'Faculty created successfully!', facultyId: Number(facInsert.lastInsertRowid) });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ success: false, message: 'A user with this email or Employee ID already exists.' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/admin/faculty/:id', requireAuth, requireRole('admin'), (req, res) => {
  const facultyId = req.params.id;
  const fac = queryGet('SELECT user_id FROM faculty WHERE id = ?', [facultyId]);
  if (!fac) return res.status(404).json({ success: false, message: 'Faculty not found.' });

  queryRun('DELETE FROM users WHERE id = ?', [fac.user_id]);
  res.json({ success: true, message: 'Faculty and related subjects, sessions, and attendance data deleted successfully.' });
});

// Class Management
router.get('/admin/classes', requireAuth, (req, res) => {
  const classes = queryAll(`
    SELECT 
      c.*,
      (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) as student_count,
      (SELECT COUNT(*) FROM subjects sub WHERE sub.class_id = c.id) as subject_count
    FROM classes c
    ORDER BY c.name ASC, c.section ASC
  `);
  res.json({ success: true, classes });
});

router.post('/admin/classes', requireAuth, requireRole('admin'), (req, res) => {
  const { name, section, semester, academicYear } = req.body;
  if (!name || !section || !semester) {
    return res.status(400).json({ success: false, message: 'Class Name, Section, and Semester are required.' });
  }

  const insert = queryRun(`
    INSERT INTO classes (name, section, semester, academic_year)
    VALUES (?, ?, ?, ?)
  `, [name, section.toUpperCase(), semester, academicYear || '2025-2026']);

  res.json({ success: true, message: 'Class created successfully!', classId: Number(insert.lastInsertRowid) });
});

router.delete('/admin/classes/:id', requireAuth, requireRole('admin'), (req, res) => {
  const classId = req.params.id;
  queryRun('DELETE FROM classes WHERE id = ?', [classId]);
  res.json({ success: true, message: 'Class deleted successfully.' });
});

// Subject Management
router.get('/admin/subjects', requireAuth, (req, res) => {
  const subjects = queryAll(`
    SELECT 
      sub.*,
      c.name as class_name,
      c.section as class_section,
      c.semester,
      u.full_name as faculty_name,
      f.employee_id
    FROM subjects sub
    JOIN classes c ON sub.class_id = c.id
    JOIN faculty f ON sub.faculty_id = f.id
    JOIN users u ON f.user_id = u.id
    ORDER BY sub.code ASC
  `);
  res.json({ success: true, subjects });
});

router.post('/admin/subjects', requireAuth, requireRole('admin'), (req, res) => {
  const { code, name, classId, facultyId, credits = 4 } = req.body;
  if (!code || !name || !classId || !facultyId) {
    return res.status(400).json({ success: false, message: 'Subject Code, Name, Class, and Faculty are required.' });
  }

  try {
    const insert = queryRun(`
      INSERT INTO subjects (code, name, class_id, faculty_id, credits)
      VALUES (?, ?, ?, ?, ?)
    `, [code.trim().toUpperCase(), name, classId, facultyId, credits]);

    res.json({ success: true, message: 'Subject created successfully!', subjectId: Number(insert.lastInsertRowid) });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ success: false, message: 'Subject with this code already exists.' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/admin/subjects/:id', requireAuth, requireRole('admin'), (req, res) => {
  const subjectId = req.params.id;
  queryRun('DELETE FROM subjects WHERE id = ?', [subjectId]);
  res.json({ success: true, message: 'Subject deleted successfully.' });
});

// ==========================================
// 5. REAL-TIME SERVER-SENT EVENTS (SSE)
// ==========================================

router.get('/live/stream/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ event: 'connected', sessionId })}\n\n`);

  const onSessionEvent = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const channel = `session:${sessionId}`;
  eventBus.on(channel, onSessionEvent);

  // Heartbeat every 20 seconds
  const heartbeat = setInterval(() => {
    res.write(`:heartbeat\n\n`);
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    eventBus.off(channel, onSessionEvent);
  });
});

// ==========================================
// 6. HELPER ENDPOINTS
// ==========================================

// Simulation scan helper: get current token for a session (used by student simulator)
router.get('/live/token/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = queryGet('SELECT current_token, token_expires_at, id FROM sessions WHERE id = ? AND status = ?', [sessionId, 'active']);
  if (!session || !session.current_token) {
    return res.status(404).json({ success: false, message: 'No active token for this session.' });
  }
  const payload = JSON.stringify({ sId: session.id, token: session.current_token, exp: session.token_expires_at, nonce: 'sim' });
  res.json({ success: true, token: session.current_token, payload });
});

// Student can get their active class's live session (without needing faculty endpoint)
router.get('/student/active-session', requireAuth, requireRole('student'), (req, res) => {
  const student = queryGet('SELECT * FROM students WHERE user_id = ?', [req.user.id]);
  if (!student) return res.status(404).json({ success: false, message: 'Student not found.' });

  const activeSession = queryGet(`
    SELECT s.id, s.current_token, s.session_type, sub.name as subject_name, sub.code as subject_code
    FROM sessions s
    JOIN subjects sub ON s.subject_id = sub.id
    WHERE s.class_id = ? AND s.status = 'active'
    ORDER BY s.id DESC LIMIT 1
  `, [student.class_id]);

  if (!activeSession || !activeSession.current_token) {
    return res.json({ success: true, activeSession: null });
  }

  const payload = JSON.stringify({ sId: activeSession.id, token: activeSession.current_token, nonce: 'sim' });
  res.json({ success: true, activeSession, payload });
});

module.exports = router;
