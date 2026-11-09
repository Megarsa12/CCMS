'use strict';
/**
 * CCMS — Express Application Entry Point
 * Wires middleware, routes, and error handler.
 */

require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const path         = require('path');
const os           = require('os');

const errorHandler = require('./shared/errorHandler');

/* ---- Module routes ---- */
const authRoutes         = require('./modules/auth/authRoutes');
const complaintRoutes    = require('./modules/complaint/complaintRoutes');
const notificationRoutes = require('./modules/notification/notificationRoutes');
const userRoutes         = require('./modules/user/userRoutes');
const departmentRoutes   = require('./modules/department/departmentRoutes');
const reportRoutes       = require('./modules/report/reportRoutes');
const publicContentRoutes = require('./modules/publicContent/publicContentRoutes');
const supportRequestRoutes = require('./modules/supportRequest/supportRequestRoutes');
const backupRoutes       = require('./modules/backup/backupRoutes');
const { UPLOAD_DIR } = require('./shared/uploadMiddleware');

/* ---- Auto-close job ---- */
const { startAutoCloseJob } = require('./shared/autoCloseJob');

const app = express();
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0) {
  throw new Error('TRUST_PROXY_HOPS must be a non-negative integer.');
}
app.set('trust proxy', trustProxyHops);

/* =============================================================
   SECURITY HEADERS (Req 18.1)
   helmet() sets X-Frame-Options, X-Content-Type-Options, etc.
============================================================= */
app.use(helmet());
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc:  ["'self'", "https://cdn.jsdelivr.net"],
    styleSrc:   ["'self'", "https://cdn.jsdelivr.net", "'unsafe-inline'"],
    imgSrc:     ["'self'", "data:"],
    connectSrc: ["'self'"],
  },
}));

/* =============================================================
   CORS
============================================================= */
app.use(cors({
  origin:      process.env.APP_URL || 'http://localhost:3000',
  credentials: true,
}));

/* =============================================================
   BODY PARSERS & COOKIE
============================================================= */
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

/* =============================================================
   RATE LIMITERS (Req 18.2 — 10 req per 15 min on auth endpoints)
============================================================= */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders:   false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again in 15 minutes.' },
  },
});

app.use('/api/auth/login',           authLimiter);
app.use('/api/auth/forgot-password', authLimiter);

/* =============================================================
   STATIC FILES
   Legacy HTML pages are no longer used because the React app is the active frontend.
============================================================= */
app.use('/uploads', express.static(UPLOAD_DIR));

/* =============================================================
   API ROUTES
============================================================= */
app.use('/api/auth',          authRoutes);
app.use('/api/complaints',    complaintRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/users',         userRoutes);
app.use('/api/departments',   departmentRoutes);
app.use('/api/reports',       reportRoutes);
app.use('/api/public-content', publicContentRoutes);
app.use('/api/support-requests', supportRequestRoutes);
app.use('/api/admin/backup', backupRoutes);

/* =============================================================
   API 404 HANDLER (Req 22.4)
   Only fires for /api/* routes — SPA catch-all is below.
============================================================= */
app.use('/api/*', (req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `API endpoint ${req.originalUrl} was not found.` },
  });
});

/* =============================================================
  REACT FRONTEND
  Serve the production build and let React Router handle UI routes.
============================================================= */
const frontendBuild = path.join(__dirname, '..', '..', 'frontend', 'build');
app.use(express.static(frontendBuild));
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendBuild, 'index.html'));
});

/* =============================================================
   GLOBAL ERROR HANDLER (Req 22.1–22.4) — must be last
============================================================= */
app.use(errorHandler);

/* =============================================================
   START SERVER
============================================================= */
const startServer = () => {
  if (app.listening) {
    return app;
  }

  const PORT = parseInt(process.env.PORT || '3000', 10);
  const HOST = '0.0.0.0';
  const lanAddress = Object.values(os.networkInterfaces())
    .flat()
    .find(address => address && address.family === 'IPv4' && !address.internal)?.address || 'YOUR-COMPUTER-IP';

  return app.listen(PORT, HOST, () => {
    console.log(`[${new Date().toISOString()}] CCMS server running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
    console.log(`Phone access: http://${lanAddress}:${PORT}`);

    // Start auto-close job for resolved complaints older than 7 days (Req 6.4)
    if (process.env.NODE_ENV !== 'test') {
      startAutoCloseJob();
    }
  });
};

if (require.main === module) {
  startServer();
}

module.exports = app; // exported for Supertest integration tests
module.exports.startServer = startServer;
