import { Router } from 'express';
import { pool, query } from './db.js';
import { requireAuth, requireRole } from './auth.js';

const router = Router();
router.use(requireAuth, requireRole('owner', 'admin', 'supervisor', 'staff'));

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s));
const isManager = (role) => ['owner', 'admin'].includes(role);
const isSupervisorUp = (role) => ['owner', 'admin', 'supervisor'].includes(role);

class UserError extends Error {}

const h = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof UserError) return res.status(400).json({ error: err.message });
    console.error('Ops route error:', err);
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

// Owners and admins can work in every outlet; everyone else only where they are placed.
async function canUseBranch(req, branchId) {
  if (!isUuid(branchId)) return false;
  if (isManager(req.user.role)) {
    const r = await query(`SELECT 1 FROM branches WHERE id = $1 AND is_active = true`, [branchId]);
    return r.rowCount > 0;
  }
  const r = await query(`SELECT 1 FROM user_branches WHERE user_id = $1 AND branch_id = $2`, [req.user.id, branchId]);
  return r.rowCount > 0;
}

async function audit(actorId, action, targetType, targetId, details) {
  try {
    await query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [actorId, action, targetType, targetId, details ? JSON.stringify(details) : null]
    );
  } catch (e) {
    console.error('Audit error:', e);
  }
}

router.get('/branches', h(async (req, res) => {
  const { rows } = isManager(req.user.role)
    ? await query(`SELECT id, code, name FROM branches WHERE is_active = true ORDER BY name`)
    : await query(
        `SELECT b.id, b.code, b.name FROM branches b JOIN user_branches ub ON ub.branch_id = b.id
          WHERE ub.user_id = $1 AND b.is_active = true ORDER BY b.name`,
        [req.user.id]
      );
  res.json({ branches: rows });
}));

router.get('/menu', h(async (req, res) => {
  const branchId = String(req.query.branch_id ?? '');
  if (!(await canUseBranch(req, branchId))) return res.status(403).json({ error: 'You do not work at that outlet' });
  const { rows } = await query(
    `SELECT mi.id, mi.name, mi.description, c.name AS category, c.sort_order,
            COALESCE(bmi.price_kobo, mi.base_price_kobo) AS price_kobo,
            COALESCE(bmi.is_available, true) AS is_available
       FROM menu_items mi
       JOIN menu_categories c ON c.id = mi.category_id
       LEFT JOIN branch_menu_items bmi ON bmi.menu_item_id = mi.id AND bmi.branch_id = $1
      WHERE mi.is_active = true
      ORDER BY c.sort_order, mi.name`,
    [branchId]
  );
  res.json({ menu: rows });
}));

router.get('/delivery-zones', h(async (req, res) => {
  const branchId = String(req.query.branch_id ?? '');
  if (!(await canUseBranch(req, branchId))) return res.status(403).json({ error: 'You do not work at that outlet' });
  const { rows } = await query(
    `SELECT id, name, fee_kobo, min_order_kobo FROM delivery_zones WHERE branch_id = $1 AND is_active = true ORDER BY name`,
    [branchId]
  );
  res.json({ zones: rows });
}));

// Staff take an order. The staff member comes from the login, never from the request.
router.post('/orders', h(async (req, res) => {
  const b = req.body || {};
  const branchId = String(b.branch_id ?? '');
  if (!(await canUseBranch(req, branchId))) return res.status(403).json({ error: 'You do not work at that outlet' });
  const orderType = ['pickup', 'eat_in', 'delivery'].includes(b.order_type) ? b.order_type : null;
  if (!orderType) return res.status(400).json({ error: 'Choose pick-up, eat-in or delivery' });
  const items = Array.isArray(b.items) ? b.items : [];
  if (items.length === 0 || items.length > 50) return res.status(400).json({ error: 'Add between 1 and 50 items' });
  const customerId = b.customer_id ? String(b.customer_id) : null;
  const guestName = b.guest_name ? String(b.guest_name).trim().slice(0, 80) : null;
  const guestPhone = b.guest_phone ? String(b.guest_phone).trim().slice(0, 20) : null;
  const notes = b.notes ? String(b.notes).trim().slice(0, 300) : null;
  const staffId = req.user.id;

  const order = await tx(async (c) => {
    if (customerId) {
      if (!isUuid(customerId)) throw new UserError('Invalid customer');
      const cu = await c.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'customer' AND is_active = true`, [customerId]);
      if (cu.rowCount === 0) throw new UserError('Customer not found');
    }
    let subtotal = 0;
    const lines = [];
    for (const it of items) {
      const qty = Number(it.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 100) throw new UserError('Each quantity must be between 1 and 100');
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
      lines.push({ id: row.id, name: row.name, price, qty, note: it.note ? String(it.note).slice(0, 120) : null });
    }

    let fee = 0;
    let zoneId = null;
    let address = null;
    if (orderType === 'delivery') {
      address = b.delivery_address ? String(b.delivery_address).trim().slice(0, 250) : '';
      if (!address) throw new UserError('Enter the delivery address');
      if (!isUuid(b.delivery_zone_id)) throw new UserError('Choose a delivery area');
      const z = await c.query(
        `SELECT id, fee_kobo, min_order_kobo FROM delivery_zones WHERE id = $1 AND branch_id = $2 AND is_active = true`,
        [b.delivery_zone_id, branchId]
      );
      if (z.rowCount === 0) throw new UserError('That area is outside this outlet’s approved delivery range');
      if (subtotal < Number(z.rows[0].min_order_kobo)) throw new UserError('Order is below the minimum for that delivery area');
      fee = Number(z.rows[0].fee_kobo);
      zoneId = z.rows[0].id;
    }
    const total = subtotal + fee;

    const o = (await c.query(
      `INSERT INTO orders (branch_id, channel, order_type, status, customer_id, created_by, delivery_zone_id,
                           delivery_address, delivery_fee_kobo, subtotal_kobo, discount_kobo, total_kobo, notes, guest_name, guest_phone)
       VALUES ($1, 'staff', $2::order_type, 'received', $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, $12) RETURNING *`,
      [branchId, orderType, customerId, staffId, zoneId, address, fee, subtotal, total, notes, guestName, guestPhone]
    )).rows[0];
    await c.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by) VALUES ($1, NULL, 'received', $2)`,
      [o.id, staffId]
    );

    for (const l of lines) {
      await c.query(
        `INSERT INTO order_items (order_id, menu_item_id, name_snapshot, unit_price_kobo, quantity, line_total_kobo, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [o.id, l.id, l.name, l.price, l.qty, l.price * l.qty, l.note]
      );
      const recipe = await c.query(`SELECT ingredient_id, qty_per_portion FROM recipe_lines WHERE menu_item_id = $1`, [l.id]);
      for (const r of recipe.rows) {
        const used = Number(r.qty_per_portion) * l.qty;
        await c.query(
          `INSERT INTO stock_movements (branch_id, ingredient_id, delta, reason, order_id, note, created_by)
           VALUES ($1, $2, $3, 'sale', $4, $5, $6)`,
          [branchId, r.ingredient_id, -used, o.id, `Order #${o.order_no}`, staffId]
        );
        const st = await c.query(
          `UPDATE branch_stock SET quantity = quantity - $1, updated_at = now()
            WHERE branch_id = $2 AND ingredient_id = $3
        RETURNING quantity, reorder_level, low_alert_sent_at`,
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
    if (customerId) {
      const pts = Math.floor(total / 100000);
      if (pts > 0) {
        await c.query(`INSERT INTO loyalty_ledger (user_id, points, reason, order_id) VALUES ($1, $2, 'order', $3)`, [customerId, pts, o.id]);
      }
    }
    return o;
  });
  res.status(201).json({ order });
}));

// Staff see only the last three sales made on their own account.
router.get('/my-sales', h(async (req, res) => {
  const { rows } = await query(
    `SELECT o.id, o.order_no, o.placed_at, o.order_type, o.status, o.total_kobo, b.name AS branch,
            (SELECT json_agg(json_build_object('name', oi.name_snapshot, 'quantity', oi.quantity) ORDER BY oi.name_snapshot)
               FROM order_items oi WHERE oi.order_id = o.id) AS items
       FROM orders o JOIN branches b ON b.id = o.branch_id
      WHERE o.created_by = $1 ORDER BY o.placed_at DESC LIMIT 3`,
    [req.user.id]
  );
  res.json({ sales: rows });
}));

// Customer orders arriving online, for staff to attend to.
router.get('/orders/online', h(async (req, res) => {
  const branchId = String(req.query.branch_id ?? '');
  if (!(await canUseBranch(req, branchId))) return res.status(403).json({ error: 'You do not work at that outlet' });
  const { rows } = await query(
    `SELECT o.id, o.order_no, o.placed_at, o.order_type, o.status, o.total_kobo, o.guest_name, o.guest_phone,
            o.delivery_address, u.full_name AS customer_name,
            (SELECT json_agg(json_build_object('name', oi.name_snapshot, 'quantity', oi.quantity) ORDER BY oi.name_snapshot)
               FROM order_items oi WHERE oi.order_id = o.id) AS items
       FROM orders o LEFT JOIN users u ON u.id = o.customer_id
      WHERE o.branch_id = $1 AND o.channel IN ('web', 'qr')
        AND o.status IN ('pending_payment', 'received', 'preparing', 'ready', 'out_for_delivery')
      ORDER BY o.placed_at LIMIT 100`,
    [branchId]
  );
  res.json({ orders: rows });
}));

// Everything the kitchen needs on one screen: live orders from every channel, plus the last two hours of finished ones.
router.get('/orders/board', h(async (req, res) => {
  const branchId = String(req.query.branch_id ?? '');
  if (!(await canUseBranch(req, branchId))) return res.status(403).json({ error: 'You do not work at that outlet' });
  const { rows } = await query(
    `SELECT o.id, o.order_no, o.placed_at, o.channel, o.order_type, o.status, o.total_kobo, o.notes, o.guest_name,
            o.delivery_address, u.full_name AS customer_name, u.phone AS customer_phone, s.full_name AS staff_name,
            (SELECT json_agg(json_build_object('name', oi.name_snapshot, 'quantity', oi.quantity) ORDER BY oi.name_snapshot)
               FROM order_items oi WHERE oi.order_id = o.id) AS items
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_id
       LEFT JOIN users s ON s.id = o.created_by
      WHERE o.branch_id = $1
        AND (o.status IN ('pending_payment', 'received', 'preparing', 'ready', 'out_for_delivery')
             OR (o.status = 'completed' AND o.completed_at > now() - interval '2 hours'))
      ORDER BY o.placed_at LIMIT 150`,
    [branchId]
  );
  res.json({ orders: rows, server_time: new Date().toISOString() });
}));

const NEXT = {
  pending_payment: ['received', 'cancelled'],
  received: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['completed', 'out_for_delivery', 'cancelled'],
  out_for_delivery: ['completed', 'cancelled'],
};

router.post('/orders/:id/status', h(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid order' });
  const to = String(req.body?.status ?? '');
  const cur = (await query(`SELECT id, branch_id, status, order_type FROM orders WHERE id = $1`, [req.params.id])).rows[0];
  if (!cur || !(await canUseBranch(req, cur.branch_id))) return res.status(404).json({ error: 'Order not found' });
  if (!(NEXT[cur.status] || []).includes(to)) return res.status(400).json({ error: `An order that is ${cur.status.replace(/_/g, ' ')} cannot move to ${to.replace(/_/g, ' ')}` });
  if (to === 'cancelled' && !isSupervisorUp(req.user.role)) return res.status(403).json({ error: 'Only a supervisor or above can cancel an order' });
  if (to === 'out_for_delivery' && cur.order_type !== 'delivery') return res.status(400).json({ error: 'Only delivery orders go out for delivery' });
  await tx(async (c) => {
    await c.query(
      `UPDATE orders SET status = $2::order_status, updated_at = now(),
              completed_at = CASE WHEN $3 THEN now() ELSE completed_at END WHERE id = $1`,
      [cur.id, to, to === 'completed' || to === 'cancelled']
    );
    await c.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by) VALUES ($1, $2::order_status, $3::order_status, $4)`,
      [cur.id, cur.status, to, req.user.id]
    );
    if (to === 'cancelled') {
      const mv = await c.query(`SELECT ingredient_id, delta FROM stock_movements WHERE order_id = $1 AND reason = 'sale'`, [cur.id]);
      for (const m of mv.rows) {
        await c.query(
          `UPDATE branch_stock SET quantity = quantity - $1, updated_at = now() WHERE branch_id = $2 AND ingredient_id = $3`,
          [m.delta, cur.branch_id, m.ingredient_id]
        );
        await c.query(
          `INSERT INTO stock_movements (branch_id, ingredient_id, delta, reason, order_id, note, created_by)
           VALUES ($1, $2, $3, 'adjustment', $4, 'Order cancelled', $5)`,
          [cur.branch_id, m.ingredient_id, -m.delta, cur.id, req.user.id]
        );
      }
    }
  });
  res.json({ ok: true, status: to });
}));

// Supervisor and above switch a dish on or off for one outlet.
router.post('/menu/:id/availability', requireRole('owner', 'admin', 'supervisor'), h(async (req, res) => {
  const branchId = String(req.body?.branch_id ?? '');
  if (!(await canUseBranch(req, branchId))) return res.status(403).json({ error: 'You do not work at that outlet' });
  if (!isUuid(req.params.id) || typeof req.body?.is_available !== 'boolean') return res.status(400).json({ error: 'Send is_available as true or false' });
  const m = await query(`SELECT 1 FROM menu_items WHERE id = $1 AND is_active = true`, [req.params.id]);
  if (m.rowCount === 0) return res.status(404).json({ error: 'Menu item not found' });
  await query(
    `INSERT INTO branch_menu_items (branch_id, menu_item_id, is_available) VALUES ($1, $2, $3)
     ON CONFLICT (branch_id, menu_item_id) DO UPDATE SET is_available = EXCLUDED.is_available`,
    [branchId, req.params.id, req.body.is_available]
  );
  await audit(req.user.id, req.body.is_available ? 'menu.enabled' : 'menu.disabled', 'menu_item', req.params.id, { branch_id: branchId });
  res.json({ ok: true });
}));

export default router;
