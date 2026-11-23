import { Router } from 'express';
import crypto from 'node:crypto';
import { pool, query } from './db.js';
import { hashPassword, requireAuth, requireRole } from './auth.js';
import { normalizePhone } from './authRoutes.js';

const router = Router();
router.use(requireAuth, requireRole('owner', 'admin', 'supervisor', 'staff'));

// Staff look up a customer by name or phone to attach to an order.
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim().slice(0, 40);
    if (q.length < 2) return res.json({ customers: [] });
    const digits = q.replace(/\D/g, '');
    const { rows } = await query(
      `SELECT id, full_name, phone FROM users
        WHERE role = 'customer' AND is_active = true AND deleted_at IS NULL
          AND (full_name ILIKE '%' || $1 || '%' OR ($2 <> '' AND right(phone, 10) LIKE '%' || right($2, 10) || '%'))
        ORDER BY full_name LIMIT 8`,
      [q.replace(/[%_\\]/g, ''), digits.length >= 4 ? digits : '']
    );
    res.json({ customers: rows });
  } catch (err) {
    console.error('Customer search error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Staff create a customer account (e.g. a walk-in). The customer sets their own PIN later.
router.post('/', async (req, res) => {
  const name = String(req.body?.full_name ?? '').trim();
  const phone = normalizePhone(req.body?.phone);
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter the customer’s name' });
  if (!/^\+234\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid Nigerian WhatsApp number' });
  let birthday = null;
  if (req.body?.birthday) {
    birthday = String(req.body.birthday);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday) || Number.isNaN(Date.parse(birthday))) return res.status(400).json({ error: 'Birthday should look like 1999-03-27' });
  }
  const hash = await hashPassword(crypto.randomBytes(16).toString('hex'));
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const u = await c.query(
      `INSERT INTO users (role, full_name, phone, password_hash, birthday, must_change_pin)
       VALUES ('customer', $1, $2, $3, $4, true) RETURNING id, full_name, phone`,
      [name, phone, hash, birthday]
    );
    await c.query(`INSERT INTO customer_profiles (user_id, whatsapp_number) VALUES ($1, $2)`, [u.rows[0].id, phone]);
    await c.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id) VALUES ($1, 'customer.created', 'user', $2)`,
      [req.user.id, u.rows[0].id]
    );
    await c.query('COMMIT');
    res.status(201).json({ customer: u.rows[0] });
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'That number already has an account' });
    console.error('Create customer error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  } finally {
    c.release();
  }
});

export default router;
