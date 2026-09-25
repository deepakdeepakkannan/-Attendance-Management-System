const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { queryGet } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'smart_attendance_super_secret_jwt_key_2026_xyz';
const JWT_EXPIRES_IN = '12h';

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(plain, hashed) {
  return bcrypt.compareSync(plain, hashed);
}

function generateToken(userPayload) {
  return jwt.sign(userPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// Authentication middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Authentication required. Missing or invalid Bearer token.' });
  }

  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ success: false, message: 'Session expired or invalid token. Please log in again.' });
  }

  // Refresh user details from DB to ensure active state
  const user = queryGet('SELECT id, email, role, full_name, is_active FROM users WHERE id = ?', [decoded.id]);
  if (!user || !user.is_active) {
    return res.status(401).json({ success: false, message: 'User account is inactive.' });
  }

  req.user = {
    ...decoded,
    ...user
  };

  next();
}

// Role-based access control middleware
function requireRole(allowedRoles) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden: Access restricted to roles [${roles.join(', ')}]. Your role is ${req.user ? req.user.role : 'none'}.`
      });
    }
    next();
  };
}

module.exports = {
  JWT_SECRET,
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  requireAuth,
  requireRole
};
