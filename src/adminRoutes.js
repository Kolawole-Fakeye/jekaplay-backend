import { Router } from 'express';
import { pool, query } from './db.js';
import { hashPassword, requireAuth, requireRole } from './auth.js';
import { normalizePhone } from './authRoutes.js';

const router = Router();
router.use(requireAuth, requireRole('owner', 'admin'));

// Who may manage which accounts: the owner manages everyone below; admins manage plain staff.
const CAN_MANAGE = { owner: ['admin', 'supervisor', 'staff'], admin: ['staff'] };
const WEAK = new Set(['123456', '654321', '123123', '112233', '121212']);
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s));

function tempPinProblem(pin) {
  const p = String(pin ?? '');
  if (!/^\d{6}$/.test(p)) return 'Temporary PIN must be exactly 6 digits';
  if (/^(\d)\1+$/.test(p) || WEAK.has(p)) return 'That PIN is too easy to guess';
  return null;
}

const h = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error('Admin route error:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'That phone number is already registered' });
    res.status(500).json({ error: 'Something went wrong' });
  }
};

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function audit(actorId, action, targetId, details) {
  try {
    await query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, details)
       VALUES ($1, $2, 'user', $3, $4::jsonb)`,
      [actorId, action, targetId, details ? JSON.stringify(details) : null]
    );
  } catch (e) {
    console.error('Audit error:', e);
  }
}

async function loadManageable(req, res) {
  if (!isUuid(req.params.id)) {
    res.status(400).json({ error: 'Invalid staff id' });
    return null;
  }
  const { rows } = await query(
    `SELECT id, role, full_name, is_active FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  const t = rows[0];
  if (!t || !CAN_MANAGE[req.user.role].includes(t.role)) {
    res.status(404).json({ error: 'Staff member not found' });
    return null;
  }
  return t;
}

router.get('/branches', h(async (_req, res) => {
  const { rows } = await query(`SELECT id, code, name FROM branches WHERE is_active = true ORDER BY name`);
  res.json({ branches: rows });
}));

router.get('/staff', h(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.role, u.full_name, u.phone, u.is_active, u.last_login_at, u.must_change_pin,
            b.id AS branch_id, b.code AS branch_code, b.name AS branch_name
       FROM users u
       LEFT JOIN staff_assignments sa ON sa.user_id = u.id AND sa.ended_at IS NULL
       LEFT JOIN branches b ON b.id = sa.branch_id
      WHERE u.role::text = ANY($1::text[]) AND u.deleted_at IS NULL
      ORDER BY u.is_active DESC, u.role, u.full_name`,
    [CAN_MANAGE[req.user.role]]
  );
  res.json({ staff: rows });
}));

router.post('/staff', h(async (req, res) => {
  const { full_name, role, branch_id, temp_pin } = req.body || {};
  const phone = normalizePhone(req.body?.phone);
  const name = String(full_name ?? '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Enter the staff member’s full name' });
  if (!/^\+234\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid Nigerian WhatsApp number' });
  if (!CAN_MANAGE[req.user.role].includes(role)) return res.status(403).json({ error: 'You cannot create that kind of account' });
  const pinErr = tempPinProblem(temp_pin);
  if (pinErr) return res.status(400).json({ error: pinErr });
  if (!isUuid(branch_id)) return res.status(400).json({ error: 'Choose an outlet' });
  const b = await query(`SELECT id, name FROM branches WHERE id = $1 AND is_active = true`, [branch_id]);
  if (!b.rows[0]) return res.status(400).json({ error: 'Outlet not found' });
  const hash = await hashPassword(String(temp_pin));
  const created = await tx(async (c) => {
    const u = await c.query(
      `INSERT INTO users (role, full_name, phone, password_hash, must_change_pin)
       VALUES ($1::user_role, $2, $3, $4, true) RETURNING id, role, full_name, phone`,
      [role, name, phone, hash]
    );
    await c.query(`INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)`, [u.rows[0].id, branch_id]);
    await c.query(
      `INSERT INTO staff_assignments (user_id, branch_id, assigned_by, note) VALUES ($1, $2, $3, 'Account created')`,
      [u.rows[0].id, branch_id, req.user.id]
    );
    return u.rows[0];
  });
  await audit(req.user.id, 'staff.created', created.id, { role, branch_id });
  res.status(201).json({ staff: { ...created, branch: b.rows[0].name } });
}));

router.post('/staff/:id/assign', h(async (req, res) => {
  const t = await loadManageable(req, res);
  if (!t) return;
  if (!t.is_active) return res.status(400).json({ error: 'Reactivate this account before placing it at an outlet' });
  const bid = String(req.body?.branch_id ?? '');
  if (!isUuid(bid)) return res.status(400).json({ error: 'Choose an outlet' });
  const b = await query(`SELECT id, name FROM branches WHERE id = $1 AND is_active = true`, [bid]);
  if (!b.rows[0]) return res.status(400).json({ error: 'Outlet not found' });
  const note = String(req.body?.note ?? '').slice(0, 200) || null;
  const from = await tx(async (c) => {
    const e = await c.query(
      `UPDATE staff_assignments SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL RETURNING branch_id`,
      [t.id]
    );
    await c.query(
      `INSERT INTO staff_assignments (user_id, branch_id, assigned_by, note) VALUES ($1, $2, $3, $4)`,
      [t.id, bid, req.user.id, note]
    );
    await c.query(`DELETE FROM user_branches WHERE user_id = $1`, [t.id]);
    await c.query(`INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)`, [t.id, bid]);
    return e.rows[0]?.branch_id || null;
  });
  await audit(req.user.id, 'staff.assigned', t.id, { from, to: bid, note });
  res.json({ ok: true, branch: b.rows[0].name });
}));

router.post('/staff/:id/deactivate', h(async (req, res) => {
  const t = await loadManageable(req, res);
  if (!t) return;
  await tx(async (c) => {
    await c.query(`UPDATE users SET is_active = false WHERE id = $1`, [t.id]);
    await c.query(`UPDATE staff_assignments SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL`, [t.id]);
    await c.query(`DELETE FROM user_branches WHERE user_id = $1`, [t.id]);
    await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [t.id]);
  });
  await audit(req.user.id, 'staff.deactivated', t.id, null);
  res.json({ ok: true });
}));

router.post('/staff/:id/reactivate', h(async (req, res) => {
  const t = await loadManageable(req, res);
  if (!t) return;
  await query(`UPDATE users SET is_active = true WHERE id = $1`, [t.id]);
  await audit(req.user.id, 'staff.reactivated', t.id, null);
  res.json({ ok: true, note: 'Place this person at an outlet so they can work' });
}));

router.post('/staff/:id/reset-pin', h(async (req, res) => {
  const t = await loadManageable(req, res);
  if (!t) return;
  const pinErr = tempPinProblem(req.body?.temp_pin);
  if (pinErr) return res.status(400).json({ error: pinErr });
  const hash = await hashPassword(String(req.body.temp_pin));
  await tx(async (c) => {
    await c.query(
      `UPDATE users SET password_hash = $2, must_change_pin = true, failed_pin_attempts = 0, locked_until = NULL WHERE id = $1`,
      [t.id, hash]
    );
    await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [t.id]);
  });
  await audit(req.user.id, 'staff.pin_reset', t.id, null);
  res.json({ ok: true });
}));

router.get('/staff/:id/history', h(async (req, res) => {
  const t = await loadManageable(req, res);
  if (!t) return;
  const a = await query(
    `SELECT sa.started_at, sa.ended_at, sa.note, b.name AS branch
       FROM staff_assignments sa JOIN branches b ON b.id = sa.branch_id
      WHERE sa.user_id = $1 ORDER BY sa.started_at DESC LIMIT 50`,
    [t.id]
  );
  const l = await query(
    `SELECT action, details, created_at FROM audit_log WHERE target_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [t.id]
  );
  res.json({ staff: t, assignments: a.rows, activity: l.rows });
}));

export default router;
