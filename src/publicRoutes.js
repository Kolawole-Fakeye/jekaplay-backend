import { Router } from 'express';
import { pool, query } from './db.js';
import { hashPassword } from './auth.js';
import { normalizePhone } from './authRoutes.js';

const router = Router();

const TERMS_VERSION = '2026-11-26';
const COMMON = new Set(['1234', '4321', '1212', '2580', '0852', '1004', '2000', '6969', '1122', '1313']);
function isRun(p) {
  const d = p.split('').map(Number);
  return d.every((x, i) => i === 0 || x - d[i - 1] === 1) || d.every((x, i) => i === 0 || d[i - 1] - x === 1);
}
function pinProblem(pin) {
  const p = String(pin ?? '');
  if (!/^\d{4}$/.test(p)) return 'Your PIN must be exactly 4 digits';
  if (/^(\d)\1{3}$/.test(p) || COMMON.has(p) || isRun(p)) return 'That PIN is too easy to guess. Pick another.';
  return null;
}

// Light per-visitor limit on sign-ups: 10 per hour.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const e = hits.get(ip);
  if (!e || e.resetAt < now) {
    hits.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return false;
  }
  e.count += 1;
  return e.count > 10;
}

router.get('/branches', async (_req, res) => {
  try {
    const { rows } = await query(`SELECT id, code, name FROM branches WHERE is_active = true ORDER BY name`);
    res.json({ branches: rows });
  } catch (err) {
    console.error('Public branches error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

router.get('/menu', async (req, res) => {
  try {
    const code = String(req.query.branch_code ?? '').toUpperCase().slice(0, 20);
    const b = (await query(`SELECT id, code, name FROM branches WHERE code = $1 AND is_active = true`, [code])).rows[0];
    if (!b) return res.status(404).json({ error: 'Outlet not found' });
    const { rows } = await query(
      `SELECT mi.id, mi.name, mi.description, mi.tags, c.name AS category, c.sort_order,
              COALESCE(bmi.price_kobo, mi.base_price_kobo) AS price_kobo,
              COALESCE(bmi.is_available, true) AS is_available
         FROM menu_items mi
         JOIN menu_categories c ON c.id = mi.category_id AND c.is_active = true
         LEFT JOIN branch_menu_items bmi ON bmi.menu_item_id = mi.id AND bmi.branch_id = $1
        WHERE mi.is_active = true
        ORDER BY c.sort_order, mi.name`,
      [b.id]
    );
    res.json({ branch: b, menu: rows });
  } catch (err) {
    console.error('Public menu error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Customer sign-up: name, WhatsApp number and a PIN. No email.
router.post('/signup', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many sign-ups from this connection. Try again later.' });
  const name = String(req.body?.full_name ?? '').trim();
  const phone = normalizePhone(req.body?.phone);
  const displayName = name.length >= 2 ? name.slice(0, 80) : 'Jekaplay customer';
  if (req.body?.accepted_terms !== true) return res.status(400).json({ error: 'Please accept the Terms and Privacy Policy to continue' });
  if (!/^\+234\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid Nigerian WhatsApp number' });
  const problem = pinProblem(req.body?.pin);
  if (problem) return res.status(400).json({ error: problem });
  const marketing = req.body?.marketing_consent === true;
  const hash = await hashPassword(String(req.body.pin));
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let branchId = null;
    if (req.body?.preferred_branch_code) {
      const b = await c.query(`SELECT id FROM branches WHERE code = $1 AND is_active = true`, [String(req.body.preferred_branch_code).toUpperCase()]);
      branchId = b.rows[0]?.id || null;
    }
    const u = await c.query(
      `INSERT INTO users (role, full_name, phone, password_hash, terms_accepted_at, terms_version)
       VALUES ('customer', $1, $2, $3, now(), $4) RETURNING id`,
      [displayName, phone, hash, TERMS_VERSION]
    );
    const id = u.rows[0].id;
    await c.query(`INSERT INTO customer_profiles (user_id, preferred_branch, whatsapp_number) VALUES ($1, $2, $3)`, [id, branchId, phone]);
    await c.query(
      `INSERT INTO consents (user_id, channel, purpose, granted, source) VALUES
         ($1, 'whatsapp', 'transactional', true, 'signup'),
         ($1, 'whatsapp', 'promotional', $2, 'signup')`,
      [id, marketing]
    );
    await c.query('COMMIT');
    res.status(201).json({ ok: true });
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'This number already has an account. Please log in.' });
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    c.release();
  }
});

export default router;
