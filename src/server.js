import express from 'express';
import cors from 'cors';
import { query } from './db.js';
import authRoutes, { bootstrapOwnerPassword } from './authRoutes.js';
import adminRoutes from './adminRoutes.js';
import opsRoutes from './opsRoutes.js';
import manageRoutes from './manageRoutes.js';
import menuRoutes from './menuRoutes.js';
import customerRoutes from './customerRoutes.js';
import publicRoutes from './publicRoutes.js';
import customerOrderRoutes from './customerOrderRoutes.js';

const app = express();
const PORT = process.env.PORT || 10000;

// Render sits behind a proxy; this makes req.ip the real visitor (needed for login rate limits).
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Only the Jekaplay website may call this API from a browser.
// Set ALLOWED_ORIGINS in Render to the frontend address(es), separated by commas, with no trailing slash.
const allowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);
if (allowed.length === 0) {
  console.warn('ALLOWED_ORIGINS is not set, so any website can call this API. Set it to your frontend address.');
}
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || allowed.length === 0 || allowed.includes(origin)),
  })
);

app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
    'Cache-Control': 'no-store',
  });
  next();
});
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, server_time: new Date().toISOString() });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(500).json({ ok: false });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ops', opsRoutes);
app.use('/api/manage', manageRoutes);
app.use('/api/menu-admin', menuRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/me', customerOrderRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Never show internal error details to the outside world.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong' });
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

app.listen(PORT, async () => {
  console.log(`Jekaplay API running on port ${PORT}`);
  try {
    await bootstrapOwnerPassword();
  } catch (err) {
    console.error('Owner setup failed:', err);
  }
});
