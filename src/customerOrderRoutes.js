import { Router } from 'express';
import { pool, query } from './db.js';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword, requireAuth, requireRole } from './auth.js';

// A signed-in customer places and follows their own orders.
const router = Router();
router.use(requireAuth, requireRole('customer'));

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s));
class UserError extends Error {}

// At most 5 orders per 10 minutes per customer.
const recent = new Map();
function tooMany(id) {
  const now = Date.now();
  const list = (recent.get(id) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 5) {
    recent.set(id, list);
    return true;
  }
  list.push(now);
  recent.set(id, list);
  return false;
}

router.post('/orders', async (req, res) => {
  const b = req.body || {};
  const branchId = String(b.branch_id ?? '');
  const orderType = ['pickup', 'eat_in'].includes(b.order_type) ? b.order_type : null;
  const items = Array.isArray(b.items) ? b.items : [];
  if (!isUuid(branchId)) return res.status(400).json({ error: 'Choose an outlet' });
  if (!orderType) return res.status(400).json({ error: 'Choose pick-up or eat-in' });
  if (items.length === 0 || items.length > 50) return res.status(400).json({ error: 'Add at least one item' });
  if (tooMany(req.user.id)) return res.status(429).json({ error: 'You have placed several orders just now. Please wait a few minutes.' });
  const note = b.notes ? String(b.notes).trim().slice(0, 250) : '';
  const notes = (note ? note + ' | ' : '') + 'Online order: pay at the outlet';
  const customerId = req.user.id;

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const br = await c.query(`SELECT 1 FROM branches WHERE id = $1 AND is_active = true`, [branchId]);
    if (br.rowCount === 0) throw new UserError('That outlet is not available');
    let subtotal = 0;
    const lines = [];
    for (const it of items) {
      const qty = Number(it.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 30) throw new UserError('Each quantity must be between 1 and 30');
      if (!isUuid(it.menu_item_id)) throw new UserError('Invalid menu item');
      const m = await c.query(
        `SELECT mi.id, mi.name, COALESCE(bmi.price_kobo, mi.base_price_kobo) AS unit_price_kobo,
                COALESCE(bmi.is_available, true) AS is_available
           FROM menu_items mi
           LEFT JOIN branch_menu_items bmi ON bmi.menu_item_id = mi.id AND bmi.branch_id = $1
          WHERE mi.id = $2 AND mi.is_active = true`,
        [branchId, it.menu_item_id]
      );
      if (m.rowCount === 0) throw new UserError('That item is no longer on the menu');
      const row = m.rows[0];
      if (!row.is_available) throw new UserError(`${row.name} is not available right now`);
      const price = Number(row.unit_price_kobo);
      subtotal += price * qty;
      lines.push({ id: row.id, name: row.name, price, qty });
    }

    const o = (await c.query(
      `INSERT INTO orders (branch_id, channel, order_type, status, customer_id, created_by, delivery_fee_kobo,
                           subtotal_kobo, discount_kobo, total_kobo, notes)
       VALUES ($1, 'web', $2::order_type, 'received', $3, NULL, 0, $4, 0, $4, $5) RETURNING id, order_no, total_kobo, status`,
      [branchId, orderType, customerId, subtotal, notes]
    )).rows[0];
    await c.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by) VALUES ($1, NULL, 'received', $2)`,
      [o.id, customerId]
    );

    for (const l of lines) {
      await c.query(
        `INSERT INTO order_items (order_id, menu_item_id, name_snapshot, unit_price_kobo, quantity, line_total_kobo)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [o.id, l.id, l.name, l.price, l.qty, l.price * l.qty]
      );
      const recipe = await c.query(`SELECT ingredient_id, qty_per_portion FROM recipe_lines WHERE menu_item_id = $1`, [l.id]);
      for (const r of recipe.rows) {
        const used = Number(r.qty_per_portion) * l.qty;
        await c.query(
          `INSERT INTO stock_movements (branch_id, ingredient_id, delta, reason, order_id, note, created_by)
           VALUES ($1, $2, $3, 'sale', $4, $5, $6)`,
          [branchId, r.ingredient_id, -used, o.id, `Order #${o.order_no}`, customerId]
        );
        const st = await c.query(
          `UPDATE branch_stock SET quantity = quantity - $1, updated_at = now()
            WHERE branch_id = $2 AND ingredient_id = $3 RETURNING quantity, reorder_level, low_alert_sent_at`,
          [used, branchId, r.ingredient_id]
        );
        const s = st.rows[0];
        if (s && Number(s.quantity) <= Number(s.reorder_level) && !s.low_alert_sent_at) {
          const ing = (await c.query(`SELECT name, unit FROM ingredients WHERE id = $1`, [r.ingredient_id])).rows[0] || { name: 'Item', unit: '' };
          await c.query(
            `INSERT INTO alerts (branch_id, kind, ingredient_id, message) VALUES ($1, 'low_stock', $2, $3)`,
            [branchId, r.ingredient_id, `Restock alert: ${ing.name} at ${s.quantity} ${ing.unit} (reorder level: ${s.reorder_level} ${ing.unit})`]
          );
          await c.query(`UPDATE branch_stock SET low_alert_sent_at = now() WHERE branch_id = $1 AND ingredient_id = $2`, [branchId, r.ingredient_id]);
        }
      }
    }
    const pts = Math.floor(subtotal / 100000);
    if (pts > 0) await c.query(`INSERT INTO loyalty_ledger (user_id, points, reason, order_id) VALUES ($1, $2, 'order', $3)`, [customerId, pts, o.id]);
    await c.query('COMMIT');
    res.status(201).json({ order: o });
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    if (err instanceof UserError) return res.status(400).json({ error: err.message });
    console.error('Customer order error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    c.release();
  }
});

router.get('/orders', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT o.id, o.order_no, o.placed_at, o.order_type, o.status, o.total_kobo, b.name AS branch,
              (SELECT json_agg(json_build_object('menu_item_id', oi.menu_item_id, 'name', oi.name_snapshot, 'quantity', oi.quantity) ORDER BY oi.name_snapshot)
                 FROM order_items oi WHERE oi.order_id = o.id) AS items
         FROM orders o JOIN branches b ON b.id = o.branch_id
        WHERE o.customer_id = $1 ORDER BY o.placed_at DESC LIMIT 10`,
      [req.user.id]
    );
    res.json({ orders: rows });
  } catch (err) {
    console.error('Customer orders error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

router.get('/profile', async (req, res) => {
  try {
    const { rows } = await query(`SELECT id, full_name, phone, birthday FROM users WHERE id = $1 AND deleted_at IS NULL`, [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Account not found' });
    res.json({ profile: rows[0] });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Name and birthday are optional extras (the birthday unlocks birthday offers).
router.patch('/profile', async (req, res) => {
  try {
    const name = req.body?.full_name === undefined ? null : String(req.body.full_name).trim();
    if (name !== null && (name.length < 2 || name.length > 80)) return res.status(400).json({ error: 'Enter your name' });
    let birthday = null;
    if (req.body?.birthday) {
      birthday = String(req.body.birthday);
      const t = Date.parse(birthday);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday) || Number.isNaN(t) || t > Date.now() || t < Date.parse('1920-01-01')) {
        return res.status(400).json({ error: 'Check the birthday date' });
      }
    }
    const { rows } = await query(
      `UPDATE users SET full_name = COALESCE($2, full_name), birthday = COALESCE($3::date, birthday), updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL RETURNING id, full_name, phone, birthday`,
      [req.user.id, name, birthday]
    );
    res.json({ profile: rows[0] });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Delete my account: personal details are erased; order records stay, no longer linked to a person.
router.post('/delete-account', async (req, res) => {
  const pin = String(req.body?.pin ?? '');
  try {
    const u = (await query(`SELECT id, password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`, [req.user.id])).rows[0];
    let ok = false;
    try {
      ok = !!u && (await verifyPassword(pin, u.password_hash));
    } catch {
      ok = false;
    }
    if (!ok) return res.status(401).json({ error: 'That PIN is not correct' });
    const scrambled = await hashPassword(crypto.randomBytes(24).toString('hex'));
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `UPDATE users SET is_active = false, deleted_at = now(), full_name = 'Deleted customer', email = NULL, phone = NULL,
                birthday = NULL, referral_code = NULL, password_hash = $2, updated_at = now() WHERE id = $1`,
        [u.id, scrambled]
      );
      await c.query(`DELETE FROM customer_profiles WHERE user_id = $1`, [u.id]);
      await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [u.id]);
      await c.query(`INSERT INTO audit_log (actor_id, action, target_type, target_id) VALUES ($1, 'customer.deleted_account', 'user', $1)`, [u.id]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;
