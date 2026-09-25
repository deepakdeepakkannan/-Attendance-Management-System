const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { queryGet, queryRun } = require('./db');

const TOKEN_VALIDITY_SECONDS = 20; // Rotates every 20 seconds
const GRACE_PERIOD_MS = 6000; // 6 seconds grace for scan latency
const QR_SECRET = process.env.QR_SECRET || 'dynamic_qr_hmac_secret_2026';

/**
 * Generate a dynamic cryptographic token for a session
 */
async function generateSessionToken(sessionId) {
  const session = queryGet('SELECT * FROM sessions WHERE id = ?', [sessionId]);
  if (!session || session.status !== 'active') {
    throw new Error('Session not found or is closed.');
  }

  const now = Date.now();
  const expiresAt = now + (TOKEN_VALIDITY_SECONDS * 1000);
  const nonce = crypto.randomBytes(8).toString('hex');
  
  // HMAC generation for anti-tampering
  const hmac = crypto.createHmac('sha256', QR_SECRET)
    .update(`${sessionId}:${now}:${nonce}`)
    .digest('hex')
    .slice(0, 32);

  const payload = {
    sId: sessionId,
    token: hmac,
    exp: expiresAt,
    nonce
  };

  const payloadString = JSON.stringify(payload);

  // Store in DB
  queryRun(`
    UPDATE sessions 
    SET current_token = ?, token_expires_at = ?
    WHERE id = ?
  `, [hmac, expiresAt, sessionId]);

  // Generate QR Code as DataURL with high contrast styling
  const qrDataUrl = await QRCode.toDataURL(payloadString, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
    color: {
      dark: '#0f172a',
      light: '#ffffff'
    }
  });

  return {
    sessionId,
    token: hmac,
    expiresAt,
    validitySeconds: TOKEN_VALIDITY_SECONDS,
    qrDataUrl,
    rawPayload: payloadString
  };
}

/**
 * Verify a scanned QR payload against the database session
 */
function verifyScannedToken(sessionId, token) {
  const session = queryGet(`
    SELECT s.*, sub.code as subject_code, sub.name as subject_name, c.name as class_name, c.section as class_section
    FROM sessions s
    JOIN subjects sub ON s.subject_id = sub.id
    JOIN classes c ON s.class_id = c.id
    WHERE s.id = ?
  `, [sessionId]);

  if (!session) {
    return { valid: false, error: 'Session does not exist.' };
  }

  if (session.status !== 'active') {
    return { valid: false, error: 'This attendance session has already been closed by faculty.' };
  }

  const now = Date.now();

  // Check overall session expiry if defined
  if (session.session_expires_at && now > session.session_expires_at) {
    queryRun(`UPDATE sessions SET status = 'closed' WHERE id = ?`, [sessionId]);
    return { valid: false, error: 'The scheduled session duration has expired.' };
  }

  // Verify dynamic token
  if (!session.current_token || session.current_token !== token) {
    return { 
      valid: false, 
      error: 'Invalid or old QR code! The QR code updates dynamically every 20 seconds. Please scan the current code.' 
    };
  }

  // Verify token expiry with grace period
  if (session.token_expires_at && (now > session.token_expires_at + GRACE_PERIOD_MS)) {
    return { 
      valid: false, 
      error: 'QR token has expired! A new QR code has already generated. Please scan the current code on screen.' 
    };
  }

  return {
    valid: true,
    session
  };
}

module.exports = {
  TOKEN_VALIDITY_SECONDS,
  generateSessionToken,
  verifyScannedToken
};
