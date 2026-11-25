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

// Forgot PIN: a supervisor, admin or the owner issues a temporary 4-digit PIN that the customer must change at next login.
router.post('/:id/reset-pin', requireRole('owner', 'admin', 'supervisor'), async (req, res) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return res.status(400).json({ error: 'Invalid customer' });
  try {
    const c = (await query(`SELECT id, full_name FROM users WHERE id = $1 AND role = 'customer' AND is_active = true AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    let temp;
    do {
      temp = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    } while (/^(\d)\1{3}$/.test(temp) || ['1234', '4321', '2580', '0000'].includes(temp));
    const hash = await hashPassword(temp);
    const cl = await pool.connect();
    try {
      await cl.query('BEGIN');
      await cl.query(`UPDATE users SET password_hash = $2, must_change_pin = true, failed_pin_attempts = 0, locked_until = NULL WHERE id = $1`, [id, hash]);
      await cl.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      await cl.query(`INSERT INTO audit_log (actor_id, action, target_type, target_id) VALUES ($1, 'customer.pin_reset', 'user', $2)`, [req.user.id, id]);
      await cl.query('COMMIT');
    } catch (e) {
      await cl.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      cl.release();
    }
    res.json({ temp_pin: temp, customer: c.full_name });
  } catch (err) {
    console.error('Customer PIN reset error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;
