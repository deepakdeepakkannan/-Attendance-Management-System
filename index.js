const express = require('express');
const path = require('path');
const cors = require('cors');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend assets
const publicPath = path.join(__dirname, '..', 'public');
const indexPath = path.join(publicPath, 'index.html');
app.use(express.static(publicPath));

// API routes
app.use('/api', apiRoutes);

// Serve the frontend entry point at the site root.
app.get('/', (req, res) => {
  res.sendFile(indexPath);
});

// Fallback to SPA index.html for frontend routes.
app.get('*', (req, res) => {
  res.sendFile(indexPath);
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🎓 Smart QR Attendance System running on port ${PORT}`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`====================================================`);
  console.log(`Login Credentials:`);
  console.log(`  👨💼 Admin:   admin@college.edu       / SVHEC`);
  console.log(`====================================================`);
});
