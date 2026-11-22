import { Router } from 'express';
import crypto from 'node:crypto';
import { query } from './db.js';
import { hashPassword, verifyPassword, signToken, requireAuth } from './auth.js';

const router = Router();

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const STAFF_ROLES = ['owner', 'admin', 'supervisor', 'staff'];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Accepts 0801..., 234801... or +234801... and stores +234801...
export function normalizePhone(input) {
  let p = String(input || '').replace(/[\s\-()]/g, '');
  if (/^0\d{10}$/.test(p)) p = '+234' + p.slice(1);
  else if (/^234\d{10}$/.test(p)) p = '+' + p;
  return p;
}

// Light per-IP limit, on top of the per-account lockout in the database.
const ipHits = new Map();
function ipLimited(ip) {
  const now = Date.now();
  const h = ipHits.get(ip);
  if (!h || h.resetAt < now) {
    ipHits.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  h.count += 1;
  return h.count > 40;
}

let dummyHash;
const getDummy = async () => (dummyHash ??= await hashPassword('000000'));

const WEAK = new Set(['1234', '4321', '123456', '654321', '123123', '112233']);
function pinProblem(pin, isStaff) {
  const p = String(pin ?? '');
  if (isStaff ? !/^\d{6}$/.test(p) : !/^\d{4,6}$/.test(p)) {
    return isStaff ? 'Staff PINs must be exactly 6 digits' : 'PIN must be 4 to 6 digits';
  }
  if (/^(\d)\1+$/.test(p) || WEAK.has(p)) return 'That PIN is too easy to guess. Pick another.';
  return null;
}

// Creates a stay-signed-in session: short access token + long refresh token.
async function issueSession(user) {
  const days = user.role === 'customer' ? 90 : 30;
  const refreshToken = crypto.randomBytes(32).toString('hex');
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [user.id, sha(refreshToken), days]
  );
  return {
    accessToken: signToken(user),
    refreshToken,
    user: { id: user.id, role: user.role, full_name: user.full_name },
  };
}

router.post('/login', async (req, res) => {
  if (ipLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });
  }
  const phone = normalizePhone(req.body?.phone);
  const pin = String(req.body?.pin ?? '');
  if (!phone || !/^\d{4,6}$/.test(pin)) {
    return res.status(400).json({ error: 'Enter your WhatsApp number and PIN' });
  }
  try {
    const { rows } = await query(
      `SELECT id, role, full_name, password_hash, failed_pin_attempts, locked_until
         FROM users
        WHERE phone = $1 AND is_active = true AND deleted_at IS NULL
        LIMIT 1`,
      [phone]
    );
    const user = rows[0];
    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
      return res.status(429).json({ error: `Too many wrong PINs. Try again in ${mins} minute(s).` });
    }
    let ok = false;
    try {
      ok = await verifyPassword(pin, user ? user.password_hash : await getDummy());
    } catch {
      ok = false;
    }
    if (!user || !ok) {
      if (user) {
        const fails = user.failed_pin_attempts + 1;
        if (fails >= MAX_FAILS) {
          await query(
            `UPDATE users SET failed_pin_attempts = 0, locked_until = now() + make_interval(mins => $2) WHERE id = $1`,
            [user.id, LOCK_MINUTES]
          );
        } else {
          await query(`UPDATE users SET failed_pin_attempts = $2 WHERE id = $1`, [user.id, fails]);
        }
      }
      return res.status(401).json({ error: 'Wrong number or PIN' });
    }
    await query(
      `UPDATE users SET failed_pin_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
      [user.id]
    );
    res.json(await issueSession(user));
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Trades a valid refresh token for a fresh session (keeps people signed in).
router.post('/refresh', async (req, res) => {
  const token = String(req.body?.refreshToken ?? '');
  if (!token) return res.status(400).json({ error: 'Missing session' });
  try {
    const { rows } = await query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
              u.role, u.full_name, u.is_active, u.deleted_at
         FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1`,
      [sha(token)]
    );
    const row = rows[0];
    if (!row) return res.status(401).json({ error: 'Please log in again' });
    if (row.revoked_at) {
      // A used token came back: treat it as stolen and end all sessions.
      await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [row.user_id]);
      return res.status(401).json({ error: 'Please log in again' });
    }
    if (new Date(row.expires_at) < new Date() || !row.is_active || row.deleted_at) {
      return res.status(401).json({ error: 'Please log in again' });
    }
    await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);
    res.json(await issueSession({ id: row.user_id, role: row.role, full_name: row.full_name }));
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

router.post('/logout', async (req, res) => {
  const token = String(req.body?.refreshToken ?? '');
  if (token) {
    try {
      await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [sha(token)]);
    } catch (err) {
      console.error('Logout error:', err);
    }
  }
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, role, full_name, phone, birthday, referral_code
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

router.post('/set-pin', requireAuth, async (req, res) => {
  const { currentPin, newPin } = req.body || {};
  const problem = pinProblem(newPin, STAFF_ROLES.includes(req.user.role));
  if (problem) return res.status(400).json({ error: problem });
  try {
    const { rows } = await query(`SELECT id, role, full_name, password_hash FROM users WHERE id = $1`, [req.user.id]);
    const user = rows[0];
    let ok = false;
    try {
      ok = !!user && (await verifyPassword(String(currentPin ?? ''), user.password_hash));
    } catch {
      ok = false;
    }
    if (!ok) return res.status(401).json({ error: 'Current PIN is wrong' });
    await query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [user.id, await hashPassword(String(newPin))]);
    await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
    res.json(await issueSession(user));
  } catch (err) {
    console.error('Set PIN error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// One-time owner setup. Reads OWNER_BOOTSTRAP_PHONE and OWNER_BOOTSTRAP_PIN
// from Render's environment, so neither lives in the code or in GitHub.
export async function bootstrapOwnerPassword() {
  const pin = process.env.OWNER_BOOTSTRAP_PIN;
  if (!pin) return;
  const phone = normalizePhone(process.env.OWNER_BOOTSTRAP_PHONE);
  if (!/^\d{6}$/.test(pin) || !/^\+234\d{10}$/.test(phone)) {
    console.warn('Owner setup skipped: PIN must be 6 digits and the phone a Nigerian number.');
    return;
  }
  const r = await query(
    `UPDATE users
        SET password_hash = $1, phone = $2, failed_pin_attempts = 0, locked_until = NULL
      WHERE role = 'owner' AND email = 'owner@jekaplayonline.com'
  RETURNING id`,
    [await hashPassword(pin), phone]
  );
  console.log(r.rowCount ? 'Owner PIN and phone set. Remove OWNER_BOOTSTRAP_PIN now.' : 'Owner account not found.');
}

export default router;
