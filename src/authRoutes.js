import { Router } from 'express';
import { query } from './db.js';
import { hashPassword, verifyPassword, signToken, requireAuth } from './auth.js';

const router = Router();

// Simple brute-force guard: 10 failed tries per 15 minutes per person.
const attempts = new Map();
const MAX_TRIES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const blocked = (key) => {
  const a = attempts.get(key);
  return !!a && a.resetAt > Date.now() && a.count >= MAX_TRIES;
};
const recordFail = (key) => {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.resetAt < now) attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else a.count += 1;
};

router.post('/login', async (req, res) => {
  const { identifier, password } = req.body || {};
  if (typeof identifier !== 'string' || typeof password !== 'string' || !identifier.trim() || !password) {
    return res.status(400).json({ error: 'Email or phone and password are required' });
  }
  const who = identifier.trim();
  const key = `${req.ip}|${who.toLowerCase()}`;
  if (blocked(key)) {
    return res.status(429).json({ error: 'Too many attempts. Please try again in 15 minutes.' });
  }
  try {
    const { rows } = await query(
      `SELECT id, role, full_name, password_hash
         FROM users
        WHERE (email = $1 OR phone = $1) AND deleted_at IS NULL AND is_active = true
        LIMIT 1`,
      [who]
    );
    const user = rows[0];
    let ok = false;
    if (user) {
      try { ok = await verifyPassword(password, user.password_hash); } catch { ok = false; }
    }
    if (!ok) {
      recordFail(key);
      return res.status(401).json({ error: 'Incorrect email/phone or password' });
    }
    attempts.delete(key);
    res.json({
      token: signToken(user),
      user: { id: user.id, role: user.role, full_name: user.full_name },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, role, full_name, email, phone, birthday, referral_code
         FROM users WHERE id = $1 AND deleted_at IS NULL AND is_active = true`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Account not found' });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// One-time owner password setup. Reads OWNER_BOOTSTRAP_PASSWORD from the
// environment, so the password never lives in the code or in GitHub.
export async function bootstrapOwnerPassword() {
  const pw = process.env.OWNER_BOOTSTRAP_PASSWORD;
  if (!pw) return;
  if (pw.length < 10) {
    console.warn('OWNER_BOOTSTRAP_PASSWORD is shorter than 10 characters, so it was skipped.');
    return;
  }
  const hash = await hashPassword(pw);
  const r = await query(
    `UPDATE users SET password_hash = $1 WHERE role = 'owner' AND email = 'owner@jekaplayonline.com' RETURNING id`,
    [hash]
  );
  console.log(
    r.rowCount
      ? 'Owner password set. Remove OWNER_BOOTSTRAP_PASSWORD from the environment now.'
      : 'Owner account not found.'
  );
}

export default router;
