import { Router } from 'express';
import { pool, query } from './db.js';
import { requireAuth, requireRole } from './auth.js';

const router = Router();
router.use(requireAuth, requireRole('owner', 'admin', 'supervisor'));

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s));
const isManager = (role) => ['owner', 'admin'].includes(role);
const TOLERANCE = 0.05; // 5% difference counts as "on track"

class UserError extends Error {}
const h = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof UserError) return res.status(400).json({ error: err.message });
    console.error('Manage route error:', err);
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

async function canUseBranch(req, branchId) {
  if (!isUuid(branchId)) return false;
  if (isManager(req.user.role)) {
    return (await query(`SELECT 1 FROM branches WHERE id = $1 AND is_active = true`, [branchId])).rowCount > 0;
  }
  return (await query(`SELECT 1 FROM user_branches WHERE user_id = $1 AND branch_id = $2`, [req.user.id, branchId])).rowCount > 0;
}

function lagosToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}
function pickDate(v) {
  const d = String(v || '').trim();
  if (!d) return lagosToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new UserError('Use a date like 2026-11-24');
  return d;
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

async function dayRows(branchId, date) {
  const { rows } = await query(
    `SELECT i.id AS ingredient_id, i.name, i.unit, bs.quantity AS stock, bs.reorder_level,
            dp.quantity AS entered_qty, dp.status, dp.review_note
       FROM branch_stock bs
       JOIN ingredients i ON i.id = bs.ingredient_id
       LEFT JOIN daily_prep dp ON dp.branch_id = bs.branch_id AND dp.ingredient_id = bs.ingredient_id AND dp.prep_date = $2::date
      WHERE bs.branch_id = $1
      ORDER BY i.name`,
    [branchId, date]
  );
  const total = rows.length;
  const filled = rows.filter((r) => r.entered_qty !== null).length;
  return {
    rows,
    summary: {
      total,
      filled,
      complete: total > 0 && filled === total,
      confirmed: rows.filter((r) => r.status === 'confirmed').length,
      disputed: rows.filter((r) => r.status === 'disputed').length,
    },
  };
}

// ---- Daily inventory ----
router.get('/inventory/day', h(async (req, res) => {
  const branchId = String(req.query.branch_id ?? '');
  if (!(await canUseBranch(req, branchId))) return res.status(403).json({ error: 'You do not work at that outlet' });
  const date = pickDate(req.query.date);
  const d = await dayRows(branchId, date);
  res.json({ date, ingredients: d.rows, summary: d.summary });
}));

// Owner and admins enter the day's quantities. Confirmed entries are locked (the owner can override).
router.put('/inventory/day', requireRole('owner', 'admin'), h(async (req, res) => {
  const branchId = String(req.body?.branch_id ?? '');
  if (!(await canUseBranch(req, branchId))) return res.status(403).json({ error: 'You do not work at that outlet' });
  const date = pickDate(req.body?.date);
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  if (entries.length === 0 || entries.length > 100) return res.status(400).json({ error: 'Send between 1 and 100 entries' });
  await tx(async (c) => {
    for (const e of entries) {
      const qty = Number(e.quantity);
      if (!isUuid(e.ingredient_id) || !Number.isFinite(qty) || qty < 0 || qty > 100000) throw new UserError('Check the ingredient and quantity');
      const t = await c.query(`SELECT i.name FROM branch_stock bs JOIN ingredients i ON i.id = bs.ingredient_id WHERE bs.branch_id = $1 AND bs.ingredient_id = $2`, [branchId, e.ingredient_id]);
      if (t.rowCount === 0) throw new UserError('That ingredient is not tracked at this outlet');
      const ex = await c.query(`SELECT status FROM daily_prep WHERE branch_id = $1 AND prep_date = $2::date AND ingredient_id = $3`, [branchId, date, e.ingredient_id]);
      if (ex.rows[0]?.status === 'confirmed' && req.user.role !== 'owner') {
        throw new UserError(`${t.rows[0].name} is already confirmed and locked`);
      }
      await c.query(
        `INSERT INTO daily_prep (branch_id, prep_date, ingredient_id, quantity, recorded_by, status)
         VALUES ($1, $2::date, $3, $4, $5, 'submitted')
         ON CONFLICT (branch_id, prep_date, ingredient_id)
         DO UPDATE SET quantity = EXCLUDED.quantity, recorded_by = EXCLUDED.recorded_by, status = 'submitted',
                       reviewed_by = NULL, reviewed_at = NULL, review_note = NULL`,
        [branchId, date, e.ingredient_id, qty, req.user.id]
      );
    }
  });
  await audit(req.user.id, 'inventory.entered', 'branch', branchId, { date, count: entries.length });
  const d = await dayRows(branchId, date);
  res.json({ ok: true, date, summary: d.summary });
}));

// Supervisors (or the owner) confirm or dispute entries. Nobody reviews their own entries.
router.post('/inventory/day/review', requireRole('owner', 'supervisor'), h(async (req, res) => {
  const branchId = String(req.body?.branch_id ?? '');
  if (!(await canUseBranch(req, branchId))) return res.status(403).json({ error: 'You do not work at that outlet' });
  const date = pickDate(req.body?.date);
  const action = req.body?.action;
  if (!['confirm', 'dispute'].includes(action)) return res.status(400).json({ error: 'Choose confirm or dispute' });
  const note = String(req.body?.note ?? '').trim().slice(0, 300);
  if (action === 'dispute' && note.length < 3) return res.status(400).json({ error: 'Say what looks wrong when you dispute' });
  const ing = req.body?.ingredient_id ? String(req.body.ingredient_id) : null;
  if (ing && !isUuid(ing)) return res.status(400).json({ error: 'Invalid ingredient' });
  const r = await query(
    `UPDATE daily_prep SET status = $5, reviewed_by = $4, reviewed_at = now(), review_note = $6
      WHERE branch_id = $1 AND prep_date = $2::date AND ($3::uuid IS NULL OR ingredient_id = $3::uuid)
        AND status IN ('submitted', 'disputed') AND recorded_by IS DISTINCT FROM $4`,
    [branchId, date, ing, req.user.id, action === 'confirm' ? 'confirmed' : 'disputed', note || null]
  );
  if (r.rowCount === 0) return res.status(400).json({ error: 'Nothing to review. Entries may be missing, already confirmed, or your own.' });
  await audit(req.user.id, action === 'confirm' ? 'inventory.confirmed' : 'inventory.disputed', 'branch', branchId, { date, count: r.rowCount, note: note || null });
  const d = await dayRows(branchId, date);
  res.json({ ok: true, reviewed: r.rowCount, summary: d.summary });
}));

// Stock coming in (restocking). Raises the level and clears the low-stock flag when it is back above the reorder level.
router.post('/inventory/restock', requireRole('owner', 'admin'), h(async (req, res) => {
  const branchId = String(req.body?.branch_id ?? '');
  if (!(await canUseBranch(req, branchId))) return res.status(403).json({ error: 'You do not work at that outlet' });
  const qty = Number(req.body?.quantity);
  if (!isUuid(req.body?.ingredient_id) || !Number.isFinite(qty) || qty <= 0 || qty > 100000) {
    return res.status(400).json({ error: 'Choose an ingredient and a quantity above zero' });
  }
  const note = String(req.body?.note ?? '').trim().slice(0, 200) || null;
  const out = await tx(async (c) => {
    const s = await c.query(
      `UPDATE branch_stock SET quantity = quantity + $3, updated_at = now(),
              low_alert_sent_at = CASE WHEN quantity + $3 > reorder_level THEN NULL ELSE low_alert_sent_at END
        WHERE branch_id = $1 AND ingredient_id = $2 RETURNING quantity`,
      [branchId, req.body.ingredient_id, qty]
    );
    if (s.rowCount === 0) throw new UserError('That ingredient is not tracked at this outlet');
    await c.query(
      `INSERT INTO stock_movements (branch_id, ingredient_id, delta, reason, note, created_by) VALUES ($1, $2, $3, 'restock', $4, $5)`,
      [branchId, req.body.ingredient_id, qty, note, req.user.id]
    );
    return s.rows[0].quantity;
  });
  await audit(req.user.id, 'inventory.restocked', 'branch', branchId, { ingredient_id: req.body.ingredient_id, quantity: qty });
  res.json({ ok: true, quantity: out });
}));

router.get('/inventory/stock', h(async (req, res) => {
  const branchId = String(req.query.branch_id ?? '');
  if (!(await canUseBranch(req, branchId))) return res.status(403).json({ error: 'You do not work at that outlet' });
  const stock = await query(
    `SELECT i.id AS ingredient_id, i.name, i.unit, bs.quantity, bs.reorder_level, (bs.quantity <= bs.reorder_level) AS is_low
       FROM branch_stock bs JOIN ingredients i ON i.id = bs.ingredient_id WHERE bs.branch_id = $1 ORDER BY i.name`,
    [branchId]
  );
  const moves = await query(
    `SELECT sm.created_at, i.name, sm.delta, sm.reason, sm.note, u.full_name AS by
       FROM stock_movements sm JOIN ingredients i ON i.id = sm.ingredient_id LEFT JOIN users u ON u.id = sm.created_by
      WHERE sm.branch_id = $1 AND sm.reason IN ('restock', 'waste', 'adjustment', 'opening')
      ORDER BY sm.created_at DESC LIMIT 30`,
    [branchId]
  );
  res.json({ stock: stock.rows, recent_changes: moves.rows });
}));

// ---- Sales report ----
// Supervisors get it only once the day's inventory has been completely filled.
router.get('/reports/sales', h(async (req, res) => {
  const branchId = String(req.query.branch_id ?? '');
  if (!(await canUseBranch(req, branchId))) return res.status(403).json({ error: 'You do not work at that outlet' });
  const date = pickDate(req.query.date);
  const day = await dayRows(branchId, date);
  if (req.user.role === 'supervisor' && !day.summary.complete) {
    return res.status(403).json({
      error: 'Sales reports open once the day’s inventory is completely filled in.',
      missing: day.rows.filter((r) => r.entered_qty === null).map((r) => r.name),
    });
  }
  const dateMatch = `(o.placed_at AT TIME ZONE 'Africa/Lagos')::date = $2::date`;
  const totals = await query(
    `SELECT count(*)::int AS orders, COALESCE(sum(o.total_kobo), 0)::int AS revenue_kobo
       FROM orders o WHERE o.branch_id = $1 AND o.status <> 'cancelled' AND ${dateMatch}`,
    [branchId, date]
  );
  const byStaff = await query(
    `SELECT COALESCE(u.full_name, 'Online / customer') AS staff, count(*)::int AS orders, sum(o.total_kobo)::int AS revenue_kobo
       FROM orders o LEFT JOIN users u ON u.id = o.created_by
      WHERE o.branch_id = $1 AND o.status <> 'cancelled' AND ${dateMatch}
      GROUP BY 1 ORDER BY revenue_kobo DESC`,
    [branchId, date]
  );
  const items = await query(
    `SELECT oi.name_snapshot AS name, sum(oi.quantity)::int AS quantity, sum(oi.line_total_kobo)::int AS revenue_kobo
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.branch_id = $1 AND o.status <> 'cancelled' AND ${dateMatch}
      GROUP BY 1 ORDER BY revenue_kobo DESC`,
    [branchId, date]
  );
  // Ingredient check: what the kitchen says it used vs what the day's sales should have used.
  const variance = await query(
    `SELECT i.name, i.unit, dp.quantity::float8 AS used,
            COALESCE((SELECT sum(-sm.delta) FROM stock_movements sm JOIN orders o ON o.id = sm.order_id
                       WHERE sm.branch_id = $1 AND sm.ingredient_id = i.id AND sm.reason IN ('sale', 'adjustment')
                         AND ${dateMatch}), 0)::float8 AS accounted_for_by_sales
       FROM daily_prep dp JOIN ingredients i ON i.id = dp.ingredient_id
      WHERE dp.branch_id = $1 AND dp.prep_date = $2::date ORDER BY i.name`,
    [branchId, date]
  );
  const check = variance.rows.map((v) => {
    const diff = v.accounted_for_by_sales - v.used;
    const pct = v.used > 0 ? diff / v.used : 0;
    const status = Math.abs(pct) <= TOLERANCE ? 'on_track' : diff < 0 ? 'shortfall' : 'excess';
    return { ...v, difference: Math.round(diff * 1000) / 1000, difference_pct: Math.round(pct * 1000) / 10, status };
  });
  res.json({ date, inventory: day.summary, totals: totals.rows[0], by_staff: byStaff.rows, items_sold: items.rows, ingredient_check: check });
}));

export default router;
