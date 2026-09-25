const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

// Render sets DB_PATH to a mounted persistent disk path. Locally, keep using
// the database file in the project root.
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'attendance.db');
const db = new DatabaseSync(dbPath);

// Enable WAL mode & foreign keys
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT CHECK(role IN ('student', 'faculty', 'admin')) NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      section TEXT NOT NULL,
      semester TEXT NOT NULL,
      academic_year TEXT DEFAULT '2025-2026',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS faculty (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      employee_id TEXT UNIQUE NOT NULL,
      department TEXT NOT NULL,
      designation TEXT DEFAULT 'Assistant Professor',
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      roll_number TEXT UNIQUE NOT NULL,
      class_id INTEGER NOT NULL,
      batch_year TEXT DEFAULT '2024-2028',
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      class_id INTEGER NOT NULL,
      faculty_id INTEGER NOT NULL,
      credits INTEGER DEFAULT 4,
      FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY(faculty_id) REFERENCES faculty(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      faculty_id INTEGER NOT NULL,
      session_type TEXT CHECK(session_type IN ('morning', 'afternoon')) NOT NULL,
      session_date TEXT NOT NULL,
      current_token TEXT,
      token_expires_at INTEGER,
      session_expires_at INTEGER,
      status TEXT CHECK(status IN ('active', 'closed')) DEFAULT 'active',
      topic TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
      FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY(faculty_id) REFERENCES faculty(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      status TEXT CHECK(status IN ('present', 'absent', 'late', 'excused')) DEFAULT 'present',
      verification_method TEXT CHECK(verification_method IN ('qr_scan', 'manual')) DEFAULT 'qr_scan',
      marked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      remarks TEXT,
      UNIQUE(session_id, student_id),
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT CHECK(type IN ('info', 'warning', 'success', 'urgent')) DEFAULT 'info',
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Migrate databases created before account archiving was added.
  try { db.exec('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1'); } catch {}

  seedDataIfEmpty();
}

function seedDataIfEmpty() {
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount > 0) {
    return; // Already initialized
  }

  console.log('Initializing database with starter records...');

  const adminHash = bcrypt.hashSync('SVHEC', 10);
  const disabledSeedPasswordHash = () => bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);

  // 1. Admin
  const adminInsert = db.prepare(`
    INSERT INTO users (email, password_hash, role, full_name, phone)
    VALUES (?, ?, 'admin', ?, ?)
  `).run('admin@college.edu', adminHash, 'svhec', '+91 98765 43210');

  // 2. Classes
  const classA = db.prepare(`
    INSERT INTO classes (name, section, semester, academic_year)
    VALUES (?, ?, ?, ?)
  `).run('B.Tech Computer Science', 'A', '4th Semester', '2025-2026');

  const classB = db.prepare(`
    INSERT INTO classes (name, section, semester, academic_year)
    VALUES (?, ?, ?, ?)
  `).run('B.Tech Computer Science', 'B', '4th Semester', '2025-2026');

  const classC = db.prepare(`
    INSERT INTO classes (name, section, semester, academic_year)
    VALUES (?, ?, ?, ?)
  `).run('B.Tech Information Technology', 'A', '4th Semester', '2025-2026');

  const classIdA = Number(classA.lastInsertRowid);
  const classIdB = Number(classB.lastInsertRowid);

  // 3. Faculty
  const fac1User = db.prepare(`
    INSERT INTO users (email, password_hash, role, full_name, phone)
    VALUES (?, ?, 'faculty', ?, ?)
  `).run('prof.sharma@college.edu', disabledSeedPasswordHash(), 'Prof. Rajesh Sharma', '+91 98111 22334');
  const fac1UserId = Number(fac1User.lastInsertRowid);

  const fac1 = db.prepare(`
    INSERT INTO faculty (user_id, employee_id, department, designation)
    VALUES (?, ?, ?, ?)
  `).run(fac1UserId, 'FAC-CS-101', 'Computer Science & Engineering', 'Associate Professor');
  const fac1Id = Number(fac1.lastInsertRowid);

  const fac2User = db.prepare(`
    INSERT INTO users (email, password_hash, role, full_name, phone)
    VALUES (?, ?, 'faculty', ?, ?)
  `).run('prof.gupta@college.edu', disabledSeedPasswordHash(), 'Dr. Ananya Gupta', '+91 98222 33445');
  const fac2UserId = Number(fac2User.lastInsertRowid);

  const fac2 = db.prepare(`
    INSERT INTO faculty (user_id, employee_id, department, designation)
    VALUES (?, ?, ?, ?)
  `).run(fac2UserId, 'FAC-MATH-202', 'Applied Mathematics', 'Assistant Professor');
  const fac2Id = Number(fac2.lastInsertRowid);

  // 4. Subjects
  const sub1 = db.prepare(`
    INSERT INTO subjects (code, name, class_id, faculty_id, credits)
    VALUES (?, ?, ?, ?, ?)
  `).run('CS401', 'Data Structures & Algorithms', classIdA, fac1Id, 4);
  const sub1Id = Number(sub1.lastInsertRowid);

  const sub2 = db.prepare(`
    INSERT INTO subjects (code, name, class_id, faculty_id, credits)
    VALUES (?, ?, ?, ?, ?)
  `).run('CS402', 'Database Management Systems', classIdA, fac1Id, 4);
  const sub2Id = Number(sub2.lastInsertRowid);

  const sub3 = db.prepare(`
    INSERT INTO subjects (code, name, class_id, faculty_id, credits)
    VALUES (?, ?, ?, ?, ?)
  `).run('CS403', 'Web Technologies & Cloud', classIdA, fac1Id, 3);
  const sub3Id = Number(sub3.lastInsertRowid);

  const sub4 = db.prepare(`
    INSERT INTO subjects (code, name, class_id, faculty_id, credits)
    VALUES (?, ?, ?, ?, ?)
  `).run('MA401', 'Discrete Mathematics', classIdA, fac2Id, 4);
  const sub4Id = Number(sub4.lastInsertRowid);

  // 5. Students
  const studentData = [
    { email: 'student1@college.edu', name: 'Rahul Verma', roll: '24CS101' },
    { email: 'student2@college.edu', name: 'Priya Patel', roll: '24CS102' },
    { email: 'student3@college.edu', name: 'Amit Kumar', roll: '24CS103' },
    { email: 'student4@college.edu', name: 'Sneha Sharma', roll: '24CS104' },
    { email: 'student5@college.edu', name: 'Vikram Singh', roll: '24CS105' },
    { email: 'student6@college.edu', name: 'Neha Gupta', roll: '24CS106' },
  ];

  const studentIds = [];
  const studentUserIds = [];

  for (const s of studentData) {
    const sUser = db.prepare(`
      INSERT INTO users (email, password_hash, role, full_name)
      VALUES (?, ?, 'student', ?)
    `).run(s.email, disabledSeedPasswordHash(), s.name);
    const sUserId = Number(sUser.lastInsertRowid);
    studentUserIds.push(sUserId);

    const sRecord = db.prepare(`
      INSERT INTO students (user_id, roll_number, class_id, batch_year)
      VALUES (?, ?, ?, '2024-2028')
    `).run(sUserId, s.roll, classIdA);
    studentIds.push(Number(sRecord.lastInsertRowid));

    // Welcome notification
    db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      VALUES (?, ?, ?, ?)
    `).run(
      sUserId,
      'Welcome to Smart QR Attendance Portal',
      'Your digital student identity is active. Make sure to scan QR codes during active morning/afternoon sessions.',
      'info'
    );
  }

  // Defaulter warning for student 3 (Amit Kumar)
  db.prepare(`
    INSERT INTO notifications (user_id, title, message, type)
    VALUES (?, ?, ?, ?)
  `).run(
    studentUserIds[2],
    '⚠️ Attendance Below 75% Cutoff',
    'Your attendance in CS401 & CS402 is currently below the mandatory 75% threshold. Please attend upcoming sessions to remain eligible for exams.',
    'urgent'
  );

  // 6. Generate Realistic Past Sessions & Attendance (Last 10 days)
  const today = new Date();
  const pastSessions = [];

  for (let d = 9; d >= 1; d--) {
    const dateObj = new Date(today);
    dateObj.setDate(today.getDate() - d);
    // skip weekends
    if (dateObj.getDay() === 0 || dateObj.getDay() === 6) continue;

    const dateStr = dateObj.toISOString().split('T')[0];

    // Morning Session: CS401 Data Structures
    const mSess = db.prepare(`
      INSERT INTO sessions (subject_id, class_id, faculty_id, session_type, session_date, status, topic)
      VALUES (?, ?, ?, 'morning', ?, 'closed', ?)
    `).run(sub1Id, classIdA, fac1Id, dateStr, `Lecture: Module ${10 - d} - Trees & Graphs`);
    const mSessId = Number(mSess.lastInsertRowid);
    pastSessions.push({ id: mSessId, subjectId: sub1Id, type: 'morning', date: dateStr });

    // Afternoon Session: CS402 or MA401
    const subChoice = d % 2 === 0 ? sub2Id : sub4Id;
    const facChoice = d % 2 === 0 ? fac1Id : fac2Id;
    const topicText = d % 2 === 0 ? `SQL Queries & Normalization Part ${d}` : `Combinatorics & Set Logic ${d}`;
    const aSess = db.prepare(`
      INSERT INTO sessions (subject_id, class_id, faculty_id, session_type, session_date, status, topic)
      VALUES (?, ?, ?, 'afternoon', ?, 'closed', ?)
    `).run(subChoice, classIdA, facChoice, dateStr, topicText);
    const aSessId = Number(aSess.lastInsertRowid);
    pastSessions.push({ id: aSessId, subjectId: subChoice, type: 'afternoon', date: dateStr });
  }

  // Populate Attendance Records for past sessions
  for (const sess of pastSessions) {
    studentIds.forEach((stuId, index) => {
      // Create realistic attendance pattern:
      // Student 1 (Rahul): 90% attendance
      // Student 2 (Priya): 95% attendance
      // Student 3 (Amit): 60% attendance (Defaulter)
      // Student 4 (Sneha): 85% attendance
      // Student 5 (Vikram): 80% attendance
      // Student 6 (Neha): 92% attendance
      let isPresent = true;
      if (index === 2) {
        // Amit Kumar misses ~40% of classes
        isPresent = (sess.id % 5) !== 0 && (sess.id % 3) !== 0;
      } else if (index === 0) {
        isPresent = (sess.id % 9) !== 0;
      } else if (index === 4) {
        isPresent = (sess.id % 6) !== 0;
      } else if (index === 3) {
        isPresent = (sess.id % 7) !== 0;
      }

      const status = isPresent ? 'present' : 'absent';
      const markedAt = `${sess.date} ${sess.type === 'morning' ? '09:15:20' : '14:05:40'}`;

      db.prepare(`
        INSERT INTO attendance (session_id, student_id, status, verification_method, marked_at)
        VALUES (?, ?, ?, 'qr_scan', ?)
      `).run(sess.id, stuId, status, markedAt);
    });
  }

  console.log('Database seeded successfully with realistic data!');
}

// Helper query wrappers
function queryAll(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function queryGet(sql, params = []) {
  return db.prepare(sql).get(...params);
}

function queryRun(sql, params = []) {
  return db.prepare(sql).run(...params);
}

// Initialize on require
initDatabase();

module.exports = {
  db,
  queryAll,
  queryGet,
  queryRun
};
