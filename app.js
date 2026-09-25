/* ==========================================================================
   SMART QR ATTENDANCE SYSTEM - SPA JavaScript Engine
   ========================================================================== */

// ============================================================
// Global State
// ============================================================
const API = '/api';
let currentUser = null;
let authToken = null;
let activeSessionId = null;
let qrRotationTimer = null;
let qrCountdownInterval = null;
let sseSource = null;
let html5QrCode = null;
let facMeta = { subjects: [], classes: [] };
let facActiveSessionData = null;

// ============================================================
// Utilities
// ============================================================

function api(endpoint, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  return fetch(`${API}${endpoint}`, { headers, ...options })
    .then(async r => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || 'API error');
      return data;
    });
}

function showToast(title, msg, type = 'info', duration = 4500) {
  const tc = document.getElementById('toastContainer');
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `
    <span style="font-size: 1.3rem; flex-shrink: 0;">${icons[type] || '💬'}</span>
    <div>
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${msg}</div>
    </div>`;
  tc.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(100%)';
    setTimeout(() => t.remove(), 300);
  }, duration);
}

function setLoading(btnId, loading, text = '') {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  if (text) btn.textContent = loading ? '⏳ ' + text : text;
}

function showView(viewId) {
  const views = ['loginView', 'studentPortal', 'facultyPortal', 'adminPortal'];
  views.forEach(v => {
    const el = document.getElementById(v);
    if (el) el.style.display = v === viewId ? '' : 'none';
  });
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric'
    });
  } catch { return dateStr; }
}

function formatDateTime(dtStr) {
  if (!dtStr) return '—';
  try {
    return new Date(dtStr).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });
  } catch { return dtStr; }
}

function downloadCSV(filename, rows, headers) {
  const lines = [headers.join(','), ...rows.map(r => headers.map(h => `"${(r[h] || '').toString().replace(/"/g, '""')}"`).join(','))];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// ============================================================
// Theme Toggle
// ============================================================

document.getElementById('themeToggleBtn').addEventListener('click', () => {
  const html = document.documentElement;
  const isLight = html.getAttribute('data-theme') === 'light';
  html.setAttribute('data-theme', isLight ? 'dark' : 'light');
  document.getElementById('themeIcon').textContent = isLight ? '☀️' : '🌙';
});

// ============================================================
// AUTH FLOWS
// ============================================================

function selectLoginRole(role) {
  if (!['student', 'faculty', 'admin'].includes(role)) return;
  document.querySelectorAll('.login-role-button').forEach(button => {
    button.classList.toggle('active', button.textContent.trim().toLowerCase() === role);
  });
  const emailInput = document.getElementById('loginEmail');
  const emailGroup = document.getElementById('loginEmailGroup');
  const passwordInput = document.getElementById('loginPassword');
  const adminLogin = role === 'admin';
  emailInput.value = adminLogin ? 'admin@college.edu' : '';
  emailInput.disabled = adminLogin;
  emailInput.required = !adminLogin;
  emailGroup.style.display = adminLogin ? 'none' : '';
  passwordInput.value = '';
}

function togglePasswordVisibility(inputId, button) {
  const input = document.getElementById(inputId);
  const showing = input.type === 'password';
  input.type = showing ? 'text' : 'password';
  button.textContent = showing ? 'Hide' : 'Show';
  button.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
  button.setAttribute('aria-pressed', String(showing));
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('loginSubmitBtn');

  btn.disabled = true;
  btn.textContent = '⏳ Authenticating...';

  try {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.message);

    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem('att_token', authToken);

    initNavbar();
    routeToPortal();
    showToast('Welcome back!', `Logged in as ${data.user.full_name}`, 'success');
  } catch (err) {
    showToast('Login Failed', err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In Securely →';
  }
}

function initNavbar() {
  if (!currentUser) return;
  document.getElementById('navUserBadge').style.display = 'flex';
  document.getElementById('navUserName').textContent = currentUser.full_name.split(' ').slice(0, 2).join(' ');
  document.getElementById('navUserRole').textContent = currentUser.role.toUpperCase();
  const initials = currentUser.full_name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('navAvatar').textContent = initials;
}

document.getElementById('logoutBtn').addEventListener('click', () => {
  authToken = null;
  currentUser = null;
  activeSessionId = null;
  facActiveSessionData = null;
  localStorage.removeItem('att_token');
  stopQrScanner();
  clearQrTimers();
  closeSseStream();
  showView('loginView');
  document.getElementById('navUserBadge').style.display = 'none';
  showToast('Logged out', 'See you next time!', 'info');
});

function routeToPortal() {
  if (!currentUser) { showView('loginView'); return; }
  const { role } = currentUser;
  if (role === 'student') {
    showView('studentPortal');
    loadStudentPortal();
  } else if (role === 'faculty') {
    showView('facultyPortal');
    loadFacultyPortal();
  } else if (role === 'admin') {
    showView('adminPortal');
    loadAdminPortal();
  }
}

// ============================================================
// AUTO-LOGIN FROM STORAGE
// ============================================================

(async () => {
  const saved = localStorage.getItem('att_token');
  if (!saved) return;
  try {
    authToken = saved;
    const res = await api('/auth/me');
    currentUser = res.user;
    initNavbar();
    routeToPortal();
  } catch {
    localStorage.removeItem('att_token');
    authToken = null;
  }
})();

// ============================================================
// STUDENT PORTAL
// ============================================================

async function loadStudentPortal() {
  // Fill student header
  const sProf = currentUser.studentProfile;
  document.getElementById('studentFullName').textContent = currentUser.full_name;
  document.getElementById('studentRoll').textContent = sProf ? sProf.roll_number : '—';
  document.getElementById('studentClass').textContent = sProf
    ? `${sProf.class_name} ${sProf.semester} (Sec ${sProf.class_section})`
    : '—';

  try {
    const data = await api('/student/dashboard');
    renderStudentDashboard(data);
    // Notifications badge
    if (data.overview.unreadNotifs > 0) {
      const badge = document.getElementById('stuNotifBadge');
      badge.style.display = 'inline';
      badge.textContent = data.overview.unreadNotifs;
    }
  } catch (err) {
    showToast('Error', err.message, 'error');
  }

  // Populate history subject filter
  try {
    const classes = await api('/admin/classes');
    // We get subjects from dashboard subjectStats
  } catch {}
}

function renderStudentDashboard(data) {
  const { overview, todaySessions, activeSession, subjectStats } = data;

  // Stats
  const pct = overview.overallPercentage;
  const pctColor = pct >= 75 ? 'var(--success)' : pct >= 65 ? 'var(--warning)' : 'var(--danger)';
  document.getElementById('stuOverallPercentage').textContent = `${pct}%`;
  document.getElementById('stuOverallPercentage').style.color = pctColor;
  document.getElementById('stuAttendedRatio').textContent = `${overview.attendedSessions} / ${overview.totalSessions}`;

  // Today's sessions status
  const morning = todaySessions.find(s => s.session_type === 'morning');
  const afternoon = todaySessions.find(s => s.session_type === 'afternoon');
  const renderStatus = (s) => {
    if (!s) return '—';
    if (s.my_attendance_status === 'present') return '✅ Present';
    if (s.my_attendance_status === 'absent') return '❌ Absent';
    if (s.session_status === 'active') return '⚡ Active';
    return '⏳ Pending';
  };
  document.getElementById('stuTodayMorningStatus').textContent = renderStatus(morning);
  document.getElementById('stuTodayAfternoonStatus').textContent = renderStatus(afternoon);

  // Date string
  document.getElementById('stuTodayDateStr').textContent = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  // Defaulter alert
  const alert = document.getElementById('stuDefaulterAlert');
  alert.style.display = overview.isDefaulter ? 'block' : 'none';

  // Active session now prompt
  const activeCard = document.getElementById('stuActiveSessionCard');
  if (activeSession && !activeSession.already_marked) {
    activeCard.style.display = 'block';
    document.getElementById('stuActiveSessTitle').textContent =
      `${activeSession.subject_code} - ${activeSession.subject_name}`;
    document.getElementById('stuActiveSessSub').textContent =
      `Faculty: ${activeSession.faculty_name} | Session: ${activeSession.session_type.toUpperCase()}`;
    document.getElementById('stuActiveSessAction').innerHTML =
      `<button class="btn btn-primary" onclick="showStudentTab('scan')">⚡ Scan QR Now</button>`;
    window._activeSessionForScan = activeSession;
  } else {
    activeCard.style.display = 'none';
  }

  // Today's session cards
  const todayList = document.getElementById('stuTodaySessionsList');
  if (todaySessions.length === 0) {
    todayList.innerHTML = `
      <div style="text-align:center; color: var(--text-muted); padding: 2rem; grid-column: 1/-1;">
        <div style="font-size:2rem; margin-bottom:0.5rem;">📭</div>
        No sessions scheduled for today yet.
      </div>`;
  } else {
    todayList.innerHTML = todaySessions.map(s => {
      const st = s.my_attendance_status;
      const badge = st === 'present'
        ? '<span class="status-badge present">✓ Present</span>'
        : st === 'absent'
        ? '<span class="status-badge absent">✗ Absent</span>'
        : s.session_status === 'active'
        ? '<span class="status-badge pending">⚡ Ongoing</span>'
        : '<span class="status-badge pending">⏳ Pending</span>';

      return `
        <div class="glass-card" style="padding: 1.25rem; border-left: 3px solid ${s.session_type === 'morning' ? 'var(--warning)' : 'var(--primary)'};">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.75rem;">
            <span class="session-badge ${s.session_type}">${s.session_type === 'morning' ? '🌅 Morning' : '🌇 Afternoon'}</span>
            ${badge}
          </div>
          <h4 style="font-size: 1rem; margin-bottom: 0.25rem;">${s.subject_code} — ${s.subject_name}</h4>
          <div style="font-size: 0.8rem; color: var(--text-muted);">👨‍🏫 ${s.faculty_name}</div>
          ${s.topic ? `<div style="font-size: 0.78rem; color: var(--text-dim); margin-top: 0.35rem;">📝 ${s.topic}</div>` : ''}
          ${st === 'present' ? `<div style="font-size: 0.75rem; color: var(--success); margin-top: 0.5rem;">✓ Marked at ${s.marked_at ? s.marked_at.substring(11, 16) : ''} via ${s.verification_method || 'qr_scan'}</div>` : ''}
        </div>`;
    }).join('');
  }

  // Subject progress summary
  const subGrid = document.getElementById('stuSubjectProgressGrid');
  subGrid.innerHTML = subjectStats.map(s => {
    const pct = s.total_conducted > 0 ? Math.round((s.attended_count / s.total_conducted) * 100) : 100;
    const gaugeClass = pct >= 75 ? 'good' : pct >= 65 ? 'warning' : 'danger';
    const gaugeColor = pct >= 75 ? 'var(--success)' : pct >= 65 ? 'var(--warning)' : 'var(--danger)';
    const circumference = 2 * Math.PI * 44;
    const offset = circumference - (pct / 100) * circumference;

    return `
      <div class="glass-card" style="text-align: center; padding: 1.5rem;">
        <div class="progress-gauge-container">
          <svg class="gauge-svg" width="130" height="130" viewBox="0 0 100 100">
            <circle class="gauge-track" cx="50" cy="50" r="44" />
            <circle class="gauge-fill ${gaugeClass}" cx="50" cy="50" r="44"
              stroke-dasharray="${circumference}"
              stroke-dashoffset="${offset}" />
          </svg>
          <div class="gauge-text-wrap">
            <span class="gauge-percentage" style="color: ${gaugeColor};">${pct}%</span>
            <span class="gauge-label">Attend.</span>
          </div>
        </div>
        <h4 style="margin-top: 0.75rem; font-size: 0.9rem;">${s.name}</h4>
        <div style="font-size: 0.75rem; color: var(--text-muted);">${s.code} • ${s.attended_count}/${s.total_conducted} classes</div>
        ${s.isDefaulter
          ? '<div style="font-size: 0.72rem; color: var(--danger); margin-top: 0.4rem; font-weight: 700;">⚠️ BELOW CUTOFF</div>'
          : '<div style="font-size: 0.72rem; color: var(--success); margin-top: 0.4rem; font-weight: 600;">✓ Eligible</div>'}
      </div>`;
  }).join('');

  // Save subjectStats for history filter
  window._subjectStats = subjectStats;
  const subSelect = document.getElementById('stuHistoryFilterSubject');
  subjectStats.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.subject_id;
    opt.textContent = `${s.code} - ${s.name}`;
    subSelect.appendChild(opt);
  });

  // Render detailed subjects tab
  renderDetailedSubjectView(subjectStats);
}

function renderDetailedSubjectView(subjectStats) {
  const container = document.getElementById('stuDetailedSubjectsList');
  container.innerHTML = subjectStats.map(s => {
    const pct = s.total_conducted > 0 ? Math.round((s.attended_count / s.total_conducted) * 100) : 100;
    const gaugeColor = pct >= 75 ? 'var(--success)' : pct >= 65 ? 'var(--warning)' : 'var(--danger)';
    const circumference = 2 * Math.PI * 44;
    const offset = circumference - (pct / 100) * circumference;
    const gaugeClass = pct >= 75 ? 'good' : pct >= 65 ? 'warning' : 'danger';
    const absNeeded = pct < 75 && s.total_conducted > 0
      ? (() => {
          // Calculate lectures needed to reach 75%
          let n = 0;
          while (Math.round(((s.attended_count + n) / (s.total_conducted + n)) * 100) < 75 && n < 100) n++;
          return n;
        })()
      : 0;

    return `
      <div class="glass-card" style="display: flex; gap: 1.25rem; align-items: center;">
        <div class="progress-gauge-container" style="flex-shrink: 0;">
          <svg class="gauge-svg" width="130" height="130" viewBox="0 0 100 100">
            <circle class="gauge-track" cx="50" cy="50" r="44" />
            <circle class="gauge-fill ${gaugeClass}" cx="50" cy="50" r="44"
              stroke-dasharray="${circumference}"
              stroke-dashoffset="${offset}" />
          </svg>
          <div class="gauge-text-wrap">
            <span class="gauge-percentage" style="color: ${gaugeColor};">${pct}%</span>
            <span class="gauge-label">Attend.</span>
          </div>
        </div>

        <div style="flex: 1;">
          <div style="font-size: 0.7rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.08em;">${s.code}</div>
          <h3 style="font-size: 1.05rem; margin: 0.2rem 0;">${s.name}</h3>
          <div style="font-size: 0.78rem; color: var(--text-muted);">Faculty: ${s.faculty_name}</div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.85rem;">
            <div style="background: rgba(255,255,255,0.04); padding: 0.5rem; border-radius: 8px; text-align: center;">
              <div style="font-size: 1.2rem; font-weight: 800; color: var(--success);">${s.attended_count}</div>
              <div style="font-size: 0.68rem; color: var(--text-muted); text-transform: uppercase;">Present</div>
            </div>
            <div style="background: rgba(255,255,255,0.04); padding: 0.5rem; border-radius: 8px; text-align: center;">
              <div style="font-size: 1.2rem; font-weight: 800; color: var(--danger);">${s.total_conducted - s.attended_count}</div>
              <div style="font-size: 0.68rem; color: var(--text-muted); text-transform: uppercase;">Absent</div>
            </div>
          </div>

          ${pct >= 75
            ? `<div style="margin-top: 0.75rem; padding: 0.5rem 0.75rem; background: var(--success-bg); border-radius: 8px; font-size: 0.8rem; color: var(--success); font-weight: 600;">✓ Exam Eligible (≥ 75% Threshold)</div>`
            : `<div style="margin-top: 0.75rem; padding: 0.5rem 0.75rem; background: var(--danger-bg); border-radius: 8px; font-size: 0.8rem; color: #fca5a5; font-weight: 600;">⚠️ Defaulter — Need ${absNeeded} more consecutive class${absNeeded > 1 ? 'es' : ''}</div>`
          }
        </div>
      </div>`;
  }).join('');
}

async function loadStudentHistory() {
  const subjectId = document.getElementById('stuHistoryFilterSubject').value;
  const sessionType = document.getElementById('stuHistoryFilterSession').value;
  const status = document.getElementById('stuHistoryFilterStatus').value;

  const params = new URLSearchParams();
  if (subjectId) params.set('subjectId', subjectId);
  if (sessionType) params.set('sessionType', sessionType);
  if (status) params.set('status', status);

  try {
    const data = await api(`/student/history?${params}`);
    const tbody = document.getElementById('stuHistoryTableBody');

    if (data.history.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color: var(--text-muted); padding: 2rem;">No attendance records found for selected filters.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.history.map(r => `
      <tr>
        <td><strong>${formatDate(r.session_date)}</strong></td>
        <td><span class="session-badge ${r.session_type}">${r.session_type === 'morning' ? '🌅 Morning' : '🌇 Afternoon'}</span></td>
        <td><strong>${r.subject_code}</strong><br><span style="font-size:0.78rem; color: var(--text-muted);">${r.subject_name}</span></td>
        <td style="font-size: 0.82rem;">${r.faculty_name}</td>
        <td style="font-size: 0.78rem; color: var(--text-muted);">${r.topic || '—'}</td>
        <td><span class="status-badge ${r.status}">${r.status.toUpperCase()}</span></td>
        <td style="font-size: 0.8rem;">${r.marked_at ? r.marked_at.substring(0, 16) : '—'}</td>
        <td style="font-size: 0.78rem; color: var(--text-dim);">${r.verification_method === 'qr_scan' ? '📷 QR Scan' : '✍️ Manual'}</td>
      </tr>`).join('');
  } catch (err) {
    showToast('Error loading history', err.message, 'error');
  }
}

async function loadStudentNotifications() {
  try {
    const data = await api('/student/notifications');
    const list = document.getElementById('stuNotificationsList');

    if (!data.notifications.length) {
      list.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:2rem;">No notifications yet.</div>`;
      return;
    }

    const icons = { info: 'ℹ️', success: '✅', warning: '⚠️', urgent: '🚨' };
    list.innerHTML = data.notifications.map(n => `
      <div class="glass-card" style="padding: 1rem 1.25rem; border-left: 3px solid ${n.type === 'urgent' ? 'var(--danger)' : n.type === 'success' ? 'var(--success)' : n.type === 'warning' ? 'var(--warning)' : 'var(--primary)'}; opacity: ${n.is_read ? '0.65' : '1'};">
        <div style="display: flex; gap: 0.75rem; align-items: flex-start;">
          <span style="font-size: 1.4rem;">${icons[n.type] || 'ℹ️'}</span>
          <div style="flex: 1;">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem;">
              <strong style="font-size: 0.88rem;">${n.title}</strong>
              <span style="font-size: 0.72rem; color: var(--text-dim);">${formatDateTime(n.created_at)}</span>
            </div>
            <p style="font-size: 0.82rem; color: var(--text-muted); margin-top: 0.3rem;">${n.message}</p>
          </div>
          ${!n.is_read ? '<span style="width: 8px; height: 8px; border-radius: 50%; background: var(--primary); flex-shrink: 0; margin-top: 4px;"></span>' : ''}
        </div>
      </div>`).join('');
  } catch (err) {
    showToast('Error', err.message, 'error');
  }
}

async function markAllNotificationsRead() {
  try {
    await api('/student/notifications/read-all', { method: 'POST' });
    document.getElementById('stuNotifBadge').style.display = 'none';
    showToast('Done', 'All notifications marked as read.', 'success');
    loadStudentNotifications();
  } catch {}
}

function showStudentTab(tab) {
  const tabs = ['dashboard', 'scan', 'history', 'subjects', 'notifications'];
  tabs.forEach(t => {
    const panel = document.getElementById(`stuTab-${t}`);
    const btn = document.getElementById(`stuTabBtn-${t}`);
    if (!panel || !btn) return;
    const active = t === tab;
    panel.style.display = active ? '' : 'none';
    btn.classList.toggle('active', active);
  });

  if (tab === 'history') loadStudentHistory();
  if (tab === 'notifications') loadStudentNotifications();
}

// ============================================================
// QR SCANNER (Student)
// ============================================================

async function startQrScanner() {
  const startBtn = document.getElementById('startCameraBtn');
  const stopBtn = document.getElementById('stopCameraBtn');
  const laser = document.getElementById('scannerLaser');

  if (html5QrCode) {
    try { await html5QrCode.stop(); } catch {}
  }

  html5QrCode = new Html5Qrcode('qr-reader');

  try {
    await html5QrCode.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      async (rawPayload) => {
        await html5QrCode.stop().catch(() => {});
        startBtn.style.display = '';
        stopBtn.style.display = 'none';
        laser.style.display = 'none';
        await processQrScan(rawPayload);
      },
      () => {} // ignore errors
    );
    startBtn.style.display = 'none';
    stopBtn.style.display = '';
    laser.style.display = 'block';
  } catch (err) {
    showToast('Camera Error', 'Could not access camera. Use the simulator below.', 'warning');
  }
}

async function stopQrScanner() {
  if (html5QrCode) {
    try { await html5QrCode.stop(); } catch {}
    html5QrCode = null;
  }
  document.getElementById('startCameraBtn').style.display = '';
  document.getElementById('stopCameraBtn').style.display = 'none';
  document.getElementById('scannerLaser').style.display = 'none';
}

async function simulateFastScan() {
  try {
    const data = await api('/student/active-session');
    if (!data.activeSession) {
      showToast('No Active Session', 'Faculty has not started a session yet. Ask faculty to start one from their portal.', 'warning');
      return;
    }
    showToast('⏳ Auto-scanning...', `Simulating QR scan for ${data.activeSession.subject_name}...`, 'info', 2000);
    await processQrScan(data.payload);
  } catch (err) {
    showToast('Simulation Error', err.message || 'Ask faculty to start a session first.', 'error');
  }
}

async function doScanRequest(payload) {
  try {
    const res = await api('/student/scan', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    showScanResult(true, res.message, res.details);
    showToast('Attendance Marked! ✅', res.message, 'success', 6000);
    loadStudentPortal();
  } catch (err) {
    showScanResult(false, err.message);
    showToast('Scan Failed', err.message, 'error');
  }
}

async function processQrScan(rawPayload) {
  try {
    const res = await api('/student/scan', {
      method: 'POST',
      body: JSON.stringify({ rawPayload })
    });
    showScanResult(true, res.message, res.details);
    showToast('Attendance Marked! ✅', res.message, 'success', 6000);
    setTimeout(loadStudentPortal, 1000);
  } catch (err) {
    showScanResult(false, err.message);
    showToast('Scan Failed', err.message, 'error');
  }
}

function showScanResult(success, message, details = null) {
  const el = document.getElementById('scanResultAlert');
  el.style.display = 'block';
  el.innerHTML = `
    <div class="glass-card" style="border-left: 4px solid ${success ? 'var(--success)' : 'var(--danger)'}; text-align: left;">
      <div style="display: flex; align-items: center; gap: 0.75rem;">
        <span style="font-size: 2rem;">${success ? '✅' : '❌'}</span>
        <div>
          <strong style="color: ${success ? 'var(--success)' : 'var(--danger)'};">${success ? 'Attendance Verified!' : 'Scan Failed'}</strong>
          <p style="font-size: 0.82rem; color: var(--text-muted); margin-top: 0.2rem;">${message}</p>
          ${details ? `
          <div style="margin-top: 0.75rem; display: flex; gap: 0.75rem; flex-wrap: wrap;">
            <span style="font-size: 0.75rem; background: var(--success-bg); color: var(--success); padding: 0.25rem 0.6rem; border-radius: 99px;">${details.subjectCode}</span>
            <span style="font-size: 0.75rem; background: rgba(99,102,241,0.15); color: var(--primary-light); padding: 0.25rem 0.6rem; border-radius: 99px;">${details.sessionType?.toUpperCase()}</span>
            <span style="font-size: 0.75rem; color: var(--text-dim);">${details.markedAt}</span>
          </div>` : ''}
        </div>
      </div>
    </div>`;
}

function showManualCodePrompt() {
  const code = prompt('Paste the raw QR payload (JSON string) from the QR code:');
  if (code) processQrScan(code.trim());
}

// ============================================================
// FACULTY PORTAL
// ============================================================

async function loadFacultyPortal() {
  const u = currentUser;
  document.getElementById('facultyFullName').textContent = u.full_name;
  if (u.facultyProfile) {
    document.getElementById('facultyDept').textContent = u.facultyProfile.department;
    document.getElementById('facultyEmpId').textContent = u.facultyProfile.employee_id;
  }

  try {
    const meta = await api('/faculty/meta');
    facMeta = meta;
    populateSessionForm(meta);
  } catch (err) {
    showToast('Error', err.message, 'error');
  }

  // Check if faculty already has an active session
  await checkAndDisplayActiveSession();
}

function populateSessionForm(meta) {
  const classSelect = document.getElementById('sessClassSelect');
  const subjSelect = document.getElementById('sessSubjectSelect');

  classSelect.innerHTML = '<option value="">Select Class...</option>';
  meta.classes.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.name} — Sec ${c.section} (${c.semester})`;
    classSelect.appendChild(opt);
  });
  setupClassCombobox('sessClassSelect');

  window._allFacSubjects = meta.subjects;
  filterSubjectsByClass();
}

function filterSubjectsByClass() {
  const classId = parseInt(document.getElementById('sessClassSelect').value, 10);
  const subjSelect = document.getElementById('sessSubjectSelect');
  const allSubs = window._allFacSubjects || [];

  subjSelect.innerHTML = '<option value="">Select Subject...</option>';
  const filtered = classId ? allSubs.filter(s => s.class_id === classId) : allSubs;
  filtered.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.code} — ${s.name}`;
    subjSelect.appendChild(opt);
  });
}

function filterSelectOptions(searchInput, selectId) {
  const select = document.getElementById(selectId);
  if (!searchInput || !select) return;
  const query = searchInput.value.trim().toLocaleLowerCase();
  Array.from(select.options).forEach((option, index) => {
    option.hidden = index !== 0 && !option.textContent.toLocaleLowerCase().includes(query);
  });
  if (select.selectedOptions[0]?.hidden) select.value = '';
}

function setupClassCombobox(selectId) {
  const select = document.getElementById(selectId);
  const combobox = document.querySelector(`[data-class-combobox="${selectId}"]`);
  if (!select || !combobox) return;

  const input = combobox.querySelector('.class-combobox-input');
  const options = combobox.querySelector('.class-combobox-options');
  if (combobox.dataset.ready === 'true') {
    renderClassComboboxOptions(combobox);
    return;
  }
  combobox.dataset.ready = 'true';

  const close = () => {
    combobox.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    renderClassComboboxOptions(combobox);
    combobox.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
  };

  input.addEventListener('focus', open);
  input.addEventListener('input', () => {
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    open();
  });
  input.addEventListener('keydown', event => {
    const visibleOptions = [...options.querySelectorAll('[role="option"]')];
    const highlighted = options.querySelector('[aria-selected="true"]');
    const currentIndex = visibleOptions.indexOf(highlighted);
    if (event.key === 'ArrowDown' && visibleOptions.length) {
      event.preventDefault();
      const next = visibleOptions[Math.min(currentIndex + 1, visibleOptions.length - 1)];
      visibleOptions.forEach(option => option.setAttribute('aria-selected', 'false'));
      next.setAttribute('aria-selected', 'true');
      next.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'ArrowUp' && visibleOptions.length) {
      event.preventDefault();
      const previous = visibleOptions[Math.max(currentIndex - 1, 0)];
      visibleOptions.forEach(option => option.setAttribute('aria-selected', 'false'));
      previous.setAttribute('aria-selected', 'true');
      previous.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && highlighted) {
      event.preventDefault();
      selectClassComboboxOption(combobox, highlighted.dataset.value);
    } else if (event.key === 'Escape') {
      close();
    }
  });
  options.addEventListener('mousedown', event => {
    const option = event.target.closest('[role="option"]');
    if (option) {
      event.preventDefault();
      selectClassComboboxOption(combobox, option.dataset.value);
    }
  });
  renderClassComboboxOptions(combobox);
}

function renderClassComboboxOptions(combobox) {
  const select = document.getElementById(combobox.dataset.classCombobox);
  const input = combobox.querySelector('.class-combobox-input');
  const options = combobox.querySelector('.class-combobox-options');
  const query = input.value.trim().toLocaleLowerCase();
  const matches = [...select.options].filter(option => option.value && option.textContent.toLocaleLowerCase().includes(query));
  options.innerHTML = matches.length
    ? matches.map(option => `<div class="class-combobox-option" role="option" data-value="${option.value}">${option.textContent}</div>`).join('')
    : '<div class="class-combobox-empty">No matching classes</div>';
}

function selectClassComboboxOption(combobox, value) {
  const select = document.getElementById(combobox.dataset.classCombobox);
  const option = [...select.options].find(item => item.value === value);
  if (!option) return;
  select.value = value;
  combobox.querySelector('.class-combobox-input').value = option.textContent;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  combobox.classList.remove('open');
  combobox.querySelector('.class-combobox-input').setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', event => {
  document.querySelectorAll('.class-combobox.open').forEach(combobox => {
    if (!combobox.contains(event.target)) {
      combobox.classList.remove('open');
      combobox.querySelector('.class-combobox-input').setAttribute('aria-expanded', 'false');
    }
  });
});

const engineeringPrograms = [
  'Computer Science and Engineering (CSE)', 'Information Technology (IT)',
  'Artificial Intelligence and Machine Learning (AIML)', 'Artificial Intelligence and Data Science (AIDS)',
  'Cyber Security', 'Computer Science and Business Systems (CSBS)',
  'Electronics and Communication Engineering (ECE)', 'Electrical and Electronics Engineering (EEE)',
  'Mechanical Engineering (MECH)', 'Civil Engineering (CIVIL)', 'Automobile Engineering',
  'Mechatronics Engineering', 'Robotics and Automation', 'Aerospace Engineering',
  'Aeronautical Engineering', 'Biomedical Engineering', 'Biotechnology', 'Pharmaceutical Technology',
  'Chemical Engineering', 'Agricultural Engineering', 'Food Technology', 'Industrial Engineering',
  'Manufacturing Engineering', 'Production Engineering', 'Instrumentation and Control Engineering (ICE)',
  'Electronics and Instrumentation Engineering (EIE)', 'Electronics and Telecommunication Engineering',
  'Marine Engineering', 'Mining Engineering', 'Petroleum Engineering', 'Textile Technology',
  'Fashion Technology', 'Environmental Engineering', 'Metallurgical Engineering',
  'Materials Science and Engineering', 'Polymer Engineering', 'Printing Technology',
  'Electronics Engineering', 'VLSI Design and Technology', 'Internet of Things (IoT)',
  'Computer Engineering', 'Software Engineering', 'Cloud Computing', 'Data Engineering',
  'Information Science and Engineering (ISE)', 'Other'
];

function buildEngineeringClassOptions() {
  return engineeringPrograms.flatMap(program => ['B.E.', 'B.Tech'].map(degree =>
    `<option value="${degree} ${program.replace(/&/g, '&amp;')}"></option>`
  )).join('');
}

function buildDepartmentOptions() {
  return engineeringPrograms.map(program => `<option value="${program.replace(/&/g, '&amp;')}">${program.replace(/&/g, '&amp;')}</option>`).join('');
}

function buildSectionOptions() {
  const letters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
  const doubleLetters = letters.map(letter => `A${letter}`);
  const numbers = Array.from({ length: 20 }, (_, index) => String(index + 1));
  return [...letters, ...doubleLetters, ...numbers].map(section => `<option value="${section}"></option>`).join('');
}

async function checkAndDisplayActiveSession() {
  try {
    const data = await api('/faculty/sessions/active');
    if (data.activeSession) {
      facActiveSessionData = data;
      activeSessionId = data.activeSession.id;
      displayActiveFacultySession(data);
      startQrAutoRotation(data.qr);
      subscribeToLiveRoster(activeSessionId);
    } else {
      document.getElementById('facNoActiveSessionMsg').style.display = 'block';
      document.getElementById('facActiveSessionContainer').style.display = 'none';
    }
  } catch {}
}

function displayActiveFacultySession(data) {
  const { activeSession, qr } = data;
  document.getElementById('facNoActiveSessionMsg').style.display = 'none';
  document.getElementById('facActiveSessionContainer').style.display = '';

  document.getElementById('facActiveSubjectTitle').textContent =
    `${activeSession.subject_code} — ${activeSession.subject_name}`;
  document.getElementById('facActiveClassInfo').textContent =
    `${activeSession.class_name} (Sec ${activeSession.class_section})`;
  const typeBadge = document.getElementById('facActiveSessionTypeBadge');
  typeBadge.className = `session-badge ${activeSession.session_type}`;
  typeBadge.textContent = activeSession.session_type === 'morning' ? '🌅 Morning' : '🌇 Afternoon';

  if (qr) displayQrCode(qr);
  loadFacultyLiveRoster();
}

function displayQrCode(qr) {
  const img = document.getElementById('facQrImage');
  if (qr.qrDataUrl) {
    img.src = qr.qrDataUrl;
    img.style.display = 'block';
  }
  startCountdownDisplay(qr);
}

function startQrAutoRotation(initialQr) {
  clearQrTimers();
  if (initialQr) {
    startCountdownDisplay(initialQr);
  }

  // Auto-rotate every TOKEN_VALIDITY_SECONDS
  qrRotationTimer = setInterval(async () => {
    if (!activeSessionId) return;
    try {
      const res = await api(`/faculty/sessions/${activeSessionId}/rotate-qr`);
      displayQrCode(res.qr);
    } catch {}
  }, 20000); // Rotate every 20 seconds matching server
}

function startCountdownDisplay(qr) {
  clearInterval(qrCountdownInterval);
  const totalMs = 20000;
  const expiresAt = qr.expiresAt;

  qrCountdownInterval = setInterval(() => {
    const remaining = Math.max(0, expiresAt - Date.now());
    const secs = Math.ceil(remaining / 1000);
    const pct = (remaining / totalMs) * 100;

    const countEl = document.getElementById('qrCountdownSeconds');
    if (countEl) {
      countEl.textContent = secs;
      countEl.style.color = secs <= 5 ? 'var(--danger)' : 'var(--accent-cyan)';
    }

    const circle = document.getElementById('qrProgressCircle');
    if (circle) {
      const circumference = 100;
      const offset = circumference - (pct / 100) * circumference;
      circle.style.strokeDashoffset = offset;
      circle.style.stroke = secs <= 5 ? 'var(--danger)' : 'var(--accent-cyan)';
    }

    if (remaining <= 0) {
      clearInterval(qrCountdownInterval);
    }
  }, 200);
}

function clearQrTimers() {
  clearInterval(qrRotationTimer);
  clearInterval(qrCountdownInterval);
}

async function forceRotateQr() {
  if (!activeSessionId) { showToast('No Session', 'No active session to rotate QR for.', 'warning'); return; }
  try {
    const res = await api(`/faculty/sessions/${activeSessionId}/rotate-qr`);
    displayQrCode(res.qr);
    showToast('QR Rotated', 'New dynamic token generated!', 'success', 2000);
  } catch (err) {
    showToast('Error', err.message, 'error');
  }
}

async function closeActiveSession() {
  if (!activeSessionId) return;
  if (!confirm('Close session and finalize attendance? All absent students will be auto-marked.')) return;
  try {
    await api(`/faculty/sessions/${activeSessionId}/close`, { method: 'POST' });
    clearQrTimers();
    closeSseStream();
    activeSessionId = null;
    facActiveSessionData = null;
    document.getElementById('facNoActiveSessionMsg').style.display = 'block';
    document.getElementById('facActiveSessionContainer').style.display = 'none';
    showToast('Session Closed ✅', 'Attendance finalized and students marked.', 'success');
    loadFacultySessionHistory();
  } catch (err) {
    showToast('Error', err.message, 'error');
  }
}

async function handleStartSession(e) {
  e.preventDefault();
  const classId = document.getElementById('sessClassSelect').value;
  const subjectId = document.getElementById('sessSubjectSelect').value;
  const sessionType = document.getElementById('sessTypeSelect').value;
  const duration = document.getElementById('sessDurationSelect').value;
  const topic = document.getElementById('sessTopicInput').value;

  try {
    const res = await api('/faculty/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ classId, subjectId, sessionType, durationMinutes: duration, topic })
    });

    activeSessionId = res.session.id;
    facActiveSessionData = res;
    displayActiveFacultySession({ activeSession: res.session, qr: res.qr });
    startQrAutoRotation(res.qr);
    subscribeToLiveRoster(activeSessionId);
    showFacultyTab('active');
    showToast('Session Started! 🚀', `Dynamic QR active for ${res.session.subject_name}`, 'success');
  } catch (err) {
    showToast('Error starting session', err.message, 'error');
  }
}

async function loadFacultyLiveRoster() {
  if (!activeSessionId) return;
  try {
    const data = await api(`/faculty/sessions/${activeSessionId}/live`);
    renderLiveRoster(data);
  } catch {}
}

function renderLiveRoster(data) {
  const { roster, counts, session } = data;

  // Mini count in QR panel
  const liveCount = document.getElementById('facLiveCountRatio');
  if (liveCount) liveCount.textContent = `${counts.presentCount} / ${counts.totalEnrolled}`;

  // Mini roster in QR panel
  const miniBody = document.getElementById('facLiveRosterBody');
  if (miniBody) {
    miniBody.innerHTML = roster.map((r, idx) => `
      <tr id="rosterRow_${r.student_id}" class="${r.attendance_status === 'present' ? '' : ''}">
        <td><strong style="font-size: 0.82rem;">${r.roll_number}</strong></td>
        <td style="font-size: 0.85rem;">${r.full_name}</td>
        <td>${r.attendance_status
          ? `<span class="status-badge ${r.attendance_status}">${r.attendance_status.toUpperCase()}</span>`
          : '<span class="status-badge pending">PENDING</span>'}</td>
        <td style="font-size: 0.75rem; color: var(--text-dim);">${r.marked_at ? r.marked_at.substring(11, 16) : '—'}</td>
        <td>
          <div style="display: flex; gap: 4px;">
            <button class="btn btn-sm" onclick="quickMark(${r.student_id}, 'present')" style="background: var(--success-bg); color: var(--success); padding: 3px 8px; font-size: 0.7rem;">✓</button>
            <button class="btn btn-sm" onclick="quickMark(${r.student_id}, 'absent')" style="background: var(--danger-bg); color: #fca5a5; padding: 3px 8px; font-size: 0.7rem;">✗</button>
          </div>
        </td>
      </tr>`).join('');
  }

  // Full roster in roster tab
  const fullBody = document.getElementById('facFullRosterBody');
  if (fullBody) {
    fullBody.innerHTML = roster.map(r => `
      <tr id="fullRosterRow_${r.student_id}">
        <td><strong>${r.roll_number}</strong></td>
        <td>${r.full_name}</td>
        <td style="font-size: 0.8rem;">${r.email}</td>
        <td>${r.attendance_status
          ? `<span class="status-badge ${r.attendance_status}">${r.attendance_status.toUpperCase()}</span>`
          : '<span class="status-badge pending">PENDING</span>'}</td>
        <td style="font-size: 0.78rem;">${r.verification_method === 'qr_scan' ? '📷 QR Scan' : r.verification_method === 'manual' ? '✍️ Manual' : '—'}</td>
        <td style="font-size: 0.8rem;">${r.marked_at ? r.marked_at.substring(0, 16) : '—'}</td>
        <td>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-sm btn-success" onclick="quickMark(${r.student_id}, 'present')">✓ Present</button>
            <button class="btn btn-sm btn-danger" onclick="quickMark(${r.student_id}, 'absent')">✗ Absent</button>
            <button class="btn btn-sm" style="background: var(--warning-bg); color: var(--warning);" onclick="quickMark(${r.student_id}, 'late')">⏰ Late</button>
          </div>
        </td>
      </tr>`).join('');
  }
}

async function quickMark(studentId, status) {
  if (!activeSessionId) { showToast('No Session', 'No active session.', 'warning'); return; }
  try {
    await api(`/faculty/sessions/${activeSessionId}/manual-mark`, {
      method: 'POST',
      body: JSON.stringify({ studentId, status })
    });
    showToast('Updated', `Marked student as ${status.toUpperCase()}.`, 'success', 2000);
    loadFacultyLiveRoster();
  } catch (err) {
    showToast('Error', err.message, 'error');
  }
}

// SSE - live real-time attendance
function subscribeToLiveRoster(sessionId) {
  closeSseStream();
  sseSource = new EventSource(`/api/live/stream/${sessionId}`);
  sseSource.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      if (payload.event === 'student_scanned') {
        // Highlight row
        const rowId = `rosterRow_${payload.data.studentId}`;
        loadFacultyLiveRoster();
        setTimeout(() => {
          const row = document.getElementById(rowId);
          if (row) row.classList.add('row-scanned-new');
        }, 300);
        showToast(`🎉 ${payload.data.fullName}`, `${payload.data.rollNumber} marked ${payload.data.status?.toUpperCase()}`, 'success', 3000);
      } else if (payload.event === 'session_closed') {
        showToast('Session Closed', 'The faculty has closed this attendance session.', 'info');
      }
    } catch {}
  };
  sseSource.onerror = () => {};
}

function closeSseStream() {
  if (sseSource) { sseSource.close(); sseSource = null; }
}

async function loadFacultySessionHistory() {
  try {
    const data = await api('/faculty/history');
    const tbody = document.getElementById('facHistoryTableBody');
    if (!data.sessions.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:2rem;">No sessions recorded yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.sessions.map(s => `
      <tr>
        <td><strong>${formatDate(s.session_date)}</strong></td>
        <td><span class="session-badge ${s.session_type}">${s.session_type === 'morning' ? '🌅 Morning' : '🌇 Afternoon'}</span></td>
        <td><strong>${s.subject_code}</strong><br><span style="font-size:0.78rem; color: var(--text-muted);">${s.subject_name}</span></td>
        <td style="font-size:0.82rem;">${s.class_name} (${s.class_section})</td>
        <td style="font-size:0.78rem; color:var(--text-dim);">${s.topic || '—'}</td>
        <td>
          <div style="font-weight:700; color: var(--success);">${s.present_count} / ${s.enrolled_count}</div>
          <div style="font-size:0.72rem; color: var(--text-muted);">
            ${s.enrolled_count > 0 ? Math.round((s.present_count / s.enrolled_count) * 100) : 0}% Present
          </div>
        </td>
        <td>
          <span class="${s.status === 'active' ? 'pulse-badge' : ''}" style="${s.status === 'closed' ? 'color: var(--text-dim); font-size:0.78rem;' : ''}">
            ${s.status === 'active' ? '🔴 LIVE' : '✓ Closed'}
          </span>
        </td>
      </tr>`).join('');
  } catch (err) {
    showToast('Error', err.message, 'error');
  }
}

async function loadFacultyReports() {
  try {
    const data = await api('/faculty/reports');
    const tbody = document.getElementById('facReportsTableBody');
    tbody.innerHTML = data.report.map(r => {
      const pctColor = r.percentage >= 75 ? 'var(--success)' : r.percentage >= 65 ? 'var(--warning)' : 'var(--danger)';
      return `
        <tr>
          <td><strong>${r.roll_number}</strong></td>
          <td>${r.full_name}</td>
          <td style="font-size:0.82rem;">${r.class_name} (${r.class_section})</td>
          <td style="font-weight: 700;">${r.totalAttended} / ${r.totalConducted}</td>
          <td>
            <span style="font-size: 1.1rem; font-weight: 800; color: ${pctColor};">${r.percentage}%</span>
          </td>
          <td>
            ${r.isDefaulter
              ? '<span class="status-badge absent">⚠️ DEFAULTER</span>'
              : '<span class="status-badge present">✓ ELIGIBLE</span>'}
          </td>
        </tr>`;
    }).join('');
  } catch (err) {
    showToast('Error', err.message, 'error');
  }
}

function exportFacultyReportCSV() {
  const rows = Array.from(document.querySelectorAll('#facReportsTableBody tr')).map(row => {
    const cells = row.querySelectorAll('td');
    return {
      roll_number: cells[0]?.textContent.trim(),
      full_name: cells[1]?.textContent.trim(),
      class: cells[2]?.textContent.trim(),
      attended_total: cells[3]?.textContent.trim(),
      percentage: cells[4]?.textContent.trim(),
      eligibility: cells[5]?.textContent.trim()
    };
  });
  downloadCSV('faculty_attendance_report.csv', rows, ['roll_number', 'full_name', 'class', 'attended_total', 'percentage', 'eligibility']);
}

function showFacultyTab(tab) {
  const tabs = ['active', 'start-session', 'roster', 'history', 'reports'];
  const tabMap = { 'active': 'active', 'start-session': 'start', 'roster': 'roster', 'history': 'history', 'reports': 'reports' };

  tabs.forEach(t => {
    const panel = document.getElementById(`facTab-${t}`);
    const btnKey = tabMap[t];
    const btn = document.getElementById(`facTabBtn-${btnKey}`);
    if (!panel || !btn) return;
    const active = t === tab;
    panel.style.display = active ? '' : 'none';
    btn.classList.toggle('active', active);
  });

  if (tab === 'history') loadFacultySessionHistory();
  if (tab === 'reports') loadFacultyReports();
  if (tab === 'roster') loadFacultyLiveRoster();
}

// ============================================================
// ADMIN PORTAL
// ============================================================

async function loadAdminPortal() {
  document.getElementById('adminFullName').textContent = currentUser.full_name;
  try {
    const stats = await api('/admin/stats');
    document.getElementById('adminTotalStudents').textContent = stats.stats.totalStudents;
    document.getElementById('adminTotalFaculty').textContent = stats.stats.totalFaculty;
    document.getElementById('adminTotalClasses').textContent = stats.stats.totalClasses;
    document.getElementById('adminDefaultersCount').textContent = stats.stats.defaultersCount;
  } catch {}

  loadAdminStudents();
}

async function loadAdminStudents() {
  try {
    const data = await api('/admin/students');
    const tbody = document.getElementById('adminStudentsTableBody');
    if (!data.students.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:2rem;">No students found.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.students.map(s => `
      <tr>
        <td><strong style="color: var(--primary-light);">${s.roll_number}</strong></td>
        <td><strong>${s.full_name}</strong></td>
        <td style="font-size:0.82rem;">${s.email}</td>
        <td style="font-size:0.82rem;">${s.class_name} — Sec ${s.class_section}</td>
        <td style="font-size:0.82rem;">${s.semester}</td>
        <td style="font-size:0.82rem;">${s.batch_year || '2024-2028'}</td>
        <td>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-sm btn-secondary" onclick="openAdminEditStudent(${JSON.stringify(s).split('"').join("'")})">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteEntity('students', ${s.student_id}, 'student')">Del</button>
          </div>
        </td>
      </tr>`).join('');
  } catch (err) {
    showToast('Error', err.message, 'error');
  }
}

async function loadAdminFaculty() {
  try {
    const data = await api('/admin/faculty');
    const tbody = document.getElementById('adminFacultyTableBody');
    if (!data.faculty.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:2rem;">No faculty found.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.faculty.map(f => `
      <tr>
        <td><strong style="color: var(--accent-cyan);">${f.employee_id}</strong></td>
        <td><strong>${f.full_name}</strong></td>
        <td style="font-size:0.82rem;">${f.email}</td>
        <td style="font-size:0.82rem;">${f.department}</td>
        <td style="font-size:0.82rem;">${f.designation}</td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="deleteEntity('faculty', ${f.faculty_id}, 'faculty member')">Delete</button>
        </td>
      </tr>`).join('');
  } catch (err) {
    showToast('Error', err.message, 'error');
  }
}

async function loadAdminClasses() {
  try {
    const data = await api('/admin/classes');
    const tbody = document.getElementById('adminClassesTableBody');
    if (!data.classes.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:2rem;">No classes found.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.classes.map(c => `
      <tr>
        <td><strong>${c.name}</strong></td>
        <td><span style="background: var(--primary-glow); color: var(--primary-light); padding: 0.2rem 0.6rem; border-radius: 6px; font-size: 0.8rem; font-weight: 700;">${c.section}</span></td>
        <td style="font-size:0.82rem;">${c.semester}</td>
        <td style="font-size:0.82rem;">${c.academic_year}</td>
        <td style="font-weight:700;">${c.student_count}</td>
        <td style="font-weight:700;">${c.subject_count}</td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="deleteEntity('classes', ${c.id}, 'class')">Delete</button>
        </td>
      </tr>`).join('');
  } catch (err) {
    showToast('Error', err.message, 'error');
  }
}

async function loadAdminSubjects() {
  try {
    const data = await api('/admin/subjects');
    const tbody = document.getElementById('adminSubjectsTableBody');
    if (!data.subjects.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:2rem;">No subjects found.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.subjects.map(s => `
      <tr>
        <td><strong style="color: var(--warning);">${s.code}</strong></td>
        <td><strong>${s.name}</strong></td>
        <td style="font-size:0.82rem;">${s.class_name} — ${s.class_section} (${s.semester})</td>
        <td style="font-size:0.82rem;">${s.faculty_name}<br><span style="color:var(--text-dim);">${s.employee_id}</span></td>
        <td style="font-weight:700;">${s.credits}</td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="deleteEntity('subjects', ${s.id}, 'subject')">Delete</button>
        </td>
      </tr>`).join('');
  } catch (err) {
    showToast('Error', err.message, 'error');
  }
}

async function loadAdminDefaulterReport() {
  try {
    const data = await api('/admin/stats');
    const tbody = document.getElementById('adminDefaultersTableBody');
    if (!data.defaulters.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:2rem;">🎉 No defaulters found! All students above 75% threshold.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.defaulters.map(d => `
      <tr>
        <td><strong style="color: var(--primary-light);">${d.roll_number}</strong></td>
        <td><strong>${d.full_name}</strong></td>
        <td style="font-size:0.82rem;">${d.email}</td>
        <td style="font-size:0.82rem;">${d.class_name} (${d.class_section})</td>
        <td>
          <span style="font-size:1.15rem; font-weight:800; color:var(--danger);">${d.percentage}%</span>
          <div style="font-size:0.72rem; color:var(--text-dim);">${d.attended_sessions}/${d.total_sessions} classes</div>
        </td>
        <td><span class="status-badge absent">⚠️ DEFAULTER</span></td>
      </tr>`).join('');
  } catch (err) {
    showToast('Error', err.message, 'error');
  }
}

function exportAdminDefaulterCSV() {
  const rows = Array.from(document.querySelectorAll('#adminDefaultersTableBody tr')).map(row => {
    const cells = row.querySelectorAll('td');
    return {
      roll_number: cells[0]?.textContent.trim(),
      full_name: cells[1]?.textContent.trim(),
      email: cells[2]?.textContent.trim(),
      class: cells[3]?.textContent.trim(),
      percentage: cells[4]?.textContent.trim(),
    };
  });
  downloadCSV('defaulter_report.csv', rows, ['roll_number', 'full_name', 'email', 'class', 'percentage']);
}

function showAdminTab(tab) {
  const tabs = ['students', 'faculty', 'classes', 'subjects', 'reports'];
  tabs.forEach(t => {
    const panel = document.getElementById(`admTab-${t}`);
    const btn = document.getElementById(`admTabBtn-${t}`);
    if (!panel || !btn) return;
    const active = t === tab;
    panel.style.display = active ? '' : 'none';
    btn.classList.toggle('active', active);
  });

  if (tab === 'students') loadAdminStudents();
  else if (tab === 'faculty') loadAdminFaculty();
  else if (tab === 'classes') loadAdminClasses();
  else if (tab === 'subjects') loadAdminSubjects();
  else if (tab === 'reports') loadAdminDefaulterReport();
}

// ============================================================
// ADMIN MODALS - CRUD
// ============================================================

let currentModalContext = null;
let editingId = null;

async function openAdminCreateModal(type) {
  currentModalContext = type;
  editingId = null;
  const modal = document.getElementById('adminModal');
  const title = document.getElementById('adminModalTitle');
  const body = document.getElementById('adminModalBody');
  const submitBtn = document.getElementById('adminModalSubmitBtn');

  submitBtn.textContent = `Create ${type.charAt(0).toUpperCase() + type.slice(1)}`;

  if (type === 'student') {
    title.textContent = '➕ Add New Student';
    body.innerHTML = `
      <div class="form-row">
        <div class="form-group"><label class="form-label">Full Name *</label><input class="form-control" id="m_fullName" placeholder="Arjun Mehta" required></div>
        <div class="form-group"><label class="form-label">Roll Number *</label><input class="form-control" id="m_rollNumber" placeholder="24CS107" required></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Email *</label><input type="email" class="form-control" id="m_email" placeholder="arjun@college.edu" required></div>
        <div class="form-group"><label class="form-label">Password *</label><div class="password-input-wrap"><input type="password" class="form-control" id="m_password" placeholder="Create a password" required><button type="button" class="password-toggle" aria-label="Show password" aria-pressed="false" onclick="togglePasswordVisibility('m_password', this)">Show</button></div></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Engineering Department *</label>
          <input type="search" class="form-control select-search" placeholder="Search departments..." aria-label="Search departments" oninput="filterSelectOptions(this, 'm_studentDepartment')">
          <select class="form-control" id="m_studentDepartment" required><option value="">Select Department...</option>${buildDepartmentOptions()}</select>
        </div>
        <div class="form-group"><label class="form-label">Class / Degree *</label>
          <select class="form-control" id="m_studentDegree" required><option value="">Select Degree...</option><option>B.E.</option><option>B.Tech</option></select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Section *</label><input type="search" class="form-control" id="m_studentSection" placeholder="Search or enter section" list="studentSectionOptions" required><datalist id="studentSectionOptions">${buildSectionOptions()}</datalist></div>
        <div class="form-group"><label class="form-label">Semester *</label><select class="form-control" id="m_studentSemester" required><option value="">Select Semester...</option>${[1,2,3,4,5,6,7,8].map(n => `<option>${n}${['st','nd','rd','th','th','th','th','th'][n-1]} Semester</option>`).join('')}</select></div>
      </div>
      <div class="form-group"><label class="form-label">Phone</label><input class="form-control" id="m_phone" placeholder="+91 98xxx xxxxx"></div>`;

  } else if (type === 'faculty') {
    title.textContent = '➕ Add New Faculty';
    body.innerHTML = `
      <div class="form-row">
        <div class="form-group"><label class="form-label">Full Name *</label><input class="form-control" id="m_fullName" placeholder="Dr. Ravi Kumar" required></div>
        <div class="form-group"><label class="form-label">Employee ID *</label><input class="form-control" id="m_employeeId" placeholder="FAC-CS-203" required></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Email *</label><input type="email" class="form-control" id="m_email" placeholder="ravi@college.edu" required></div>
        <div class="form-group"><label class="form-label">Password *</label><div class="password-input-wrap"><input type="password" class="form-control" id="m_password" placeholder="Create a password" required><button type="button" class="password-toggle" aria-label="Show password" aria-pressed="false" onclick="togglePasswordVisibility('m_password', this)">Show</button></div></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Department *</label>
          <input type="search" class="form-control select-search" placeholder="Search departments..." aria-label="Search departments" oninput="filterSelectOptions(this, 'm_department')">
          <select class="form-control" id="m_department" required>
            <option value="">Select...</option>
            <option>Computer Science and Engineering (CSE)</option>
            <option>Information Technology (IT)</option>
            <option>Artificial Intelligence and Machine Learning (AI &amp; ML / AIML)</option>
            <option>Artificial Intelligence and Data Science (AI &amp; DS / AIDS)</option>
            <option>Cyber Security</option>
            <option>Computer Science and Business Systems (CSBS)</option>
            <option>Electronics and Communication Engineering (ECE)</option>
            <option>Electrical and Electronics Engineering (EEE)</option>
            <option>Mechanical Engineering (MECH)</option>
            <option>Civil Engineering (CIVIL)</option>
            <option>Automobile Engineering</option>
            <option>Mechatronics Engineering</option>
            <option>Robotics and Automation</option>
            <option>Aerospace Engineering</option>
            <option>Aeronautical Engineering</option>
            <option>Biomedical Engineering</option>
            <option>Biotechnology</option>
            <option>Pharmaceutical Technology</option>
            <option>Chemical Engineering</option>
            <option>Agricultural Engineering</option>
            <option>Food Technology</option>
            <option>Industrial Engineering</option>
            <option>Manufacturing Engineering</option>
            <option>Production Engineering</option>
            <option>Instrumentation and Control Engineering (ICE)</option>
            <option>Electronics and Instrumentation Engineering (EIE)</option>
            <option>Electronics and Telecommunication Engineering</option>
            <option>Marine Engineering</option>
            <option>Mining Engineering</option>
            <option>Petroleum Engineering</option>
            <option>Textile Technology</option>
            <option>Fashion Technology</option>
            <option>Environmental Engineering</option>
            <option>Metallurgical Engineering</option>
            <option>Materials Science and Engineering</option>
            <option>Polymer Engineering</option>
            <option>Printing Technology</option>
            <option>Electronics Engineering</option>
            <option>VLSI Design and Technology</option>
            <option>Internet of Things (IoT)</option>
            <option>Computer Engineering</option>
            <option>Software Engineering</option>
            <option>Cloud Computing</option>
            <option>Data Engineering</option>
            <option>Information Science and Engineering (ISE)</option>
            <option>Other</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Designation</label>
          <select class="form-control" id="m_designation">
            <option>Assistant Professor</option>
            <option>Associate Professor</option>
            <option>Professor</option>
            <option>HOD</option>
          </select>
        </div>
      </div>`;

  } else if (type === 'class') {
    title.textContent = '➕ Add New Class';
    body.innerHTML = `
      <div class="form-group"><label class="form-label">Program / Degree *</label><input type="search" class="form-control" id="m_name" placeholder="Search or enter an engineering program" list="engineeringClassOptions" required><datalist id="engineeringClassOptions">${buildEngineeringClassOptions()}</datalist></div>
        <div class="form-row">
      <div class="form-group"><label class="form-label">Section *</label><input type="search" class="form-control" id="m_section" placeholder="Search or enter section" list="sectionOptions" maxlength="10" required><datalist id="sectionOptions">${buildSectionOptions()}</datalist></div>
        <div class="form-group"><label class="form-label">Semester *</label>
          <select class="form-control" id="m_semester" required>
            ${[1,2,3,4,5,6,7,8].map(n => `<option>${n}${['st','nd','rd','th','th','th','th','th'][n-1]} Semester</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Academic Year</label><input class="form-control" id="m_academicYear" value="2025-2026" placeholder="2025-2026"></div>`;

  } else if (type === 'subject') {
    title.textContent = '➕ Add New Subject';
    const [classes, faculty] = await Promise.all([api('/admin/classes'), api('/admin/faculty')]);
    body.innerHTML = `
      <div class="form-row">
        <div class="form-group"><label class="form-label">Subject Code *</label><input class="form-control" id="m_code" placeholder="CS501" required></div>
        <div class="form-group"><label class="form-label">Subject Name *</label><input class="form-control" id="m_name" placeholder="Operating Systems" required></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Class *</label>
          <div class="class-combobox" data-class-combobox="m_classId">
            <span class="class-combobox-icon" aria-hidden="true">⌕</span>
            <input type="search" class="form-control class-combobox-input" id="m_classSearch" placeholder="Search or select class" aria-label="Search or select class" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="m_classOptions">
            <div class="class-combobox-options" id="m_classOptions" role="listbox"></div>
          </div>
          <select class="class-combobox-value" id="m_classId" required tabindex="-1" aria-hidden="true">
            <option value="">Select Class...</option>
            ${classes.classes.map(c => `<option value="${c.id}">${c.name} — Sec ${c.section}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label class="form-label">Faculty In-Charge *</label>
          <select class="form-control" id="m_facultyId" required>
            <option value="">Select Faculty...</option>
            ${faculty.faculty.map(f => `<option value="${f.faculty_id}">${f.full_name} (${f.department})</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Credits</label>
        <select class="form-control" id="m_credits">
          <option value="1">1 Credit</option><option value="2">2 Credits</option>
          <option value="3">3 Credits</option><option value="4" selected>4 Credits</option>
        </select>
      </div>`;
    setupClassCombobox('m_classId');
  }

  modal.classList.add('open');
}

function closeAdminModal() {
  document.getElementById('adminModal').classList.remove('open');
  currentModalContext = null;
  editingId = null;
}

async function handleAdminModalSubmit(e) {
  e.preventDefault();
  const submitBtn = document.getElementById('adminModalSubmitBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = '⏳ Saving...';

  try {
    const type = currentModalContext;
    let body = {};

    if (type === 'student') {
      const programName = `${document.getElementById('m_studentDegree').value} ${document.getElementById('m_studentDepartment').value}`;
      const section = document.getElementById('m_studentSection').value.trim().toUpperCase();
      const semester = document.getElementById('m_studentSemester').value;
      const existingClasses = await api('/admin/classes');
      const matchingClass = existingClasses.classes.find(c => c.name === programName && c.section.toUpperCase() === section && c.semester === semester);
      const classId = matchingClass ? matchingClass.id : (await api('/admin/classes', {
        method: 'POST',
        body: JSON.stringify({ name: programName, section, semester, academicYear: '2025-2026' })
      })).classId;
      body = {
        fullName: document.getElementById('m_fullName').value,
        email: document.getElementById('m_email').value,
        password: document.getElementById('m_password').value,
        rollNumber: document.getElementById('m_rollNumber').value,
        classId,
        phone: document.getElementById('m_phone')?.value
      };
      if (editingId) {
        await api(`/admin/students/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await api('/admin/students', { method: 'POST', body: JSON.stringify(body) });
      }
    } else if (type === 'faculty') {
      body = {
        fullName: document.getElementById('m_fullName').value,
        email: document.getElementById('m_email').value,
        password: document.getElementById('m_password')?.value,
        employeeId: document.getElementById('m_employeeId').value,
        department: document.getElementById('m_department').value,
        designation: document.getElementById('m_designation').value,
      };
      await api('/admin/faculty', { method: 'POST', body: JSON.stringify(body) });
    } else if (type === 'class') {
      body = {
        name: document.getElementById('m_name').value,
        section: document.getElementById('m_section').value,
        semester: document.getElementById('m_semester').value,
        academicYear: document.getElementById('m_academicYear').value
      };
      await api('/admin/classes', { method: 'POST', body: JSON.stringify(body) });
    } else if (type === 'subject') {
      body = {
        code: document.getElementById('m_code').value,
        name: document.getElementById('m_name').value,
        classId: document.getElementById('m_classId').value,
        facultyId: document.getElementById('m_facultyId').value,
        credits: document.getElementById('m_credits').value
      };
      await api('/admin/subjects', { method: 'POST', body: JSON.stringify(body) });
    }

    showToast('Saved! ✅', `${type.charAt(0).toUpperCase() + type.slice(1)} record saved successfully.`, 'success');
    closeAdminModal();
    // Reload current admin tab
    const activeBtn = document.querySelector('.portal-nav .portal-tab-btn.active');
    if (activeBtn) activeBtn.click();
  } catch (err) {
    showToast('Error', err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save';
  }
}

async function deleteEntity(type, id, label) {
  if (!confirm(`Are you sure you want to delete this ${label}? This action cannot be undone.`)) return;
  try {
    await api(`/admin/${type}/${id}`, { method: 'DELETE' });
    showToast('Deleted ✅', `${label.charAt(0).toUpperCase() + label.slice(1)} removed successfully.`, 'success');
    if (type === 'students') loadAdminStudents();
    else if (type === 'faculty') loadAdminFaculty();
    else if (type === 'classes') loadAdminClasses();
    else if (type === 'subjects') loadAdminSubjects();
  } catch (err) {
    showToast('Error', err.message, 'error');
  }
}

// Close modal on backdrop click
document.getElementById('adminModal').addEventListener('click', function(e) {
  if (e.target === this) closeAdminModal();
});

// ============================================================
// Add a helper API endpoint for student simulation scan
// (We add a quick-scan token endpoint to the express routes)
// ============================================================
// The simulateFastScan uses /api/live/token/:sessionId to get current token
// We add this to API routes from the server side too.
// For now it's handled by the fallback useCurrentToken path in server.
