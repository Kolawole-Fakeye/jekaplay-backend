import { Router } from 'express';
import { pool, query } from './db.js';
import { requireAuth, requireRole } from './auth.js';

// Menu, recipe amounts and reorder levels. Owner only.
const router = Router();
router.use(requireAuth, requireRole('owner'));

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s));
class UserError extends Error {}
const h = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof UserError) return res.status(400).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'That name already exists' });
    console.error('Menu route error:', err);
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
async function writeRecipe(c, itemId, lines) {
  if (!Array.isArray(lines) || lines.length > 20) throw new UserError('A recipe can have up to 20 ingredients');
  await c.query(`DELETE FROM recipe_lines WHERE menu_item_id = $1`, [itemId]);
  for (const l of lines) {
    const q = Number(l.qty_per_portion);
    if (!isUuid(l.ingredient_id) || !Number.isFinite(q) || q <= 0 || q > 100000) throw new UserError('Each recipe line needs an ingredient and an amount above zero');
    const ok = await c.query(`SELECT 1 FROM ingredients WHERE id = $1 AND is_active = true`, [l.ingredient_id]);
    if (ok.rowCount === 0) throw new UserError('Unknown ingredient in recipe');
    await c.query(`INSERT INTO recipe_lines (menu_item_id, ingredient_id, qty_per_portion) VALUES ($1, $2, $3)`, [itemId, l.ingredient_id, q]);
  }
}

router.get('/items', h(async (_req, res) => {
  const { rows } = await query(
    `SELECT mi.id, mi.name, mi.description, c.name AS category, mi.base_price_kobo, mi.is_active,
            COALESCE((SELECT json_agg(json_build_object('ingredient_id', rl.ingredient_id, 'ingredient', i.name, 'unit', i.unit, 'qty_per_portion', rl.qty_per_portion))
                        FROM recipe_lines rl JOIN ingredients i ON i.id = rl.ingredient_id WHERE rl.menu_item_id = mi.id), '[]'::json) AS recipe
       FROM menu_items mi LEFT JOIN menu_categories c ON c.id = mi.category_id
      ORDER BY c.sort_order NULLS LAST, mi.name`
  );
  res.json({ items: rows });
}));

router.post('/items', h(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const category = String(req.body?.category ?? '').trim();
  const price = Number(req.body?.price_kobo);
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter the dish name' });
  if (category.length < 2 || category.length > 40) return res.status(400).json({ error: 'Choose a category' });
  if (!Number.isInteger(price) || price < 0 || price > 100000000) return res.status(400).json({ error: 'Enter the price in kobo (₦1,000 is 100000)' });
  const description = req.body?.description ? String(req.body.description).trim().slice(0, 200) : null;
  const item = await tx(async (c) => {
    const cat = await c.query(
      `INSERT INTO menu_categories (name, sort_order)
       VALUES ($1, COALESCE((SELECT max(sort_order) FROM menu_categories), 0) + 1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [category]
    );
    const it = (await c.query(
      `INSERT INTO menu_items (category_id, name, description, base_price_kobo) VALUES ($1, $2, $3, $4) RETURNING id, name`,
      [cat.rows[0].id, name, description, price]
    )).rows[0];
    await c.query(
      `INSERT INTO branch_menu_items (branch_id, menu_item_id, is_available)
       SELECT id, $1, true FROM branches WHERE is_active = true ON CONFLICT DO NOTHING`,
      [it.id]
    );
    if (req.body?.recipe) await writeRecipe(c, it.id, req.body.recipe);
    return it;
  });
  await audit(req.user.id, 'menu.item_created', 'menu_item', item.id, { name, price_kobo: price });
  res.status(201).json({ item });
}));

router.patch('/items/:id', h(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid item' });
  const b = req.body || {};
  const name = b.name === undefined ? null : String(b.name).trim();
  if (name !== null && (name.length < 2 || name.length > 80)) return res.status(400).json({ error: 'Enter the dish name' });
  const price = b.price_kobo === undefined ? null : Number(b.price_kobo);
  if (price !== null && (!Number.isInteger(price) || price < 0 || price > 100000000)) return res.status(400).json({ error: 'Enter the price in kobo' });
  const active = b.is_active === undefined ? null : b.is_active === true;
  const desc = b.description === undefined ? null : String(b.description).trim().slice(0, 200);
  const r = await query(
    `UPDATE menu_items SET name = COALESCE($2, name), description = COALESCE($3, description),
            base_price_kobo = COALESCE($4, base_price_kobo), is_active = COALESCE($5, is_active), updated_at = now()
      WHERE id = $1 RETURNING id, name, base_price_kobo, is_active`,
    [req.params.id, name, desc, price, active]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
  await audit(req.user.id, 'menu.item_updated', 'menu_item', req.params.id, { changes: Object.keys(b) });
  res.json({ item: r.rows[0] });
}));

// The "variables" behind excess/shortage: how much of each ingredient goes into one portion.
router.put('/items/:id/recipe', h(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid item' });
  if ((await query(`SELECT 1 FROM menu_items WHERE id = $1`, [req.params.id])).rowCount === 0) return res.status(404).json({ error: 'Item not found' });
  await tx((c) => writeRecipe(c, req.params.id, req.body?.lines));
  await audit(req.user.id, 'menu.recipe_updated', 'menu_item', req.params.id, { lines: (req.body?.lines || []).length });
  res.json({ ok: true });
}));

router.get('/ingredients', h(async (_req, res) => {
  const { rows } = await query(`SELECT id, name, unit, is_active FROM ingredients ORDER BY name`);
  res.json({ ingredients: rows });
}));

router.post('/ingredients', h(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const unit = String(req.body?.unit ?? '').trim();
  if (name.length < 2 || name.length > 40 || unit.length < 1 || unit.length > 20) return res.status(400).json({ error: 'Enter a name and a unit such as kg or pieces' });
  const ing = await tx(async (c) => {
    const i = (await c.query(`INSERT INTO ingredients (name, unit) VALUES ($1, $2) RETURNING id, name, unit`, [name, unit])).rows[0];
    await c.query(
      `INSERT INTO branch_stock (branch_id, ingredient_id, quantity, reorder_level)
       SELECT id, $1, 0, 0 FROM branches WHERE is_active = true ON CONFLICT DO NOTHING`,
      [i.id]
    );
    return i;
  });
  await audit(req.user.id, 'menu.ingredient_created', 'ingredient', ing.id, { name, unit });
  res.status(201).json({ ingredient: ing });
}));

router.put('/reorder-level', h(async (req, res) => {
  const level = Number(req.body?.reorder_level);
  if (!isUuid(req.body?.branch_id) || !isUuid(req.body?.ingredient_id) || !Number.isFinite(level) || level < 0 || level > 100000) {
    return res.status(400).json({ error: 'Choose an outlet, an ingredient and a level of zero or more' });
  }
  const r = await query(
    `UPDATE branch_stock SET reorder_level = $3, low_alert_sent_at = CASE WHEN quantity > $3 THEN NULL ELSE low_alert_sent_at END, updated_at = now()
      WHERE branch_id = $1 AND ingredient_id = $2`,
    [req.body.branch_id, req.body.ingredient_id, level]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'That ingredient is not tracked at this outlet' });
  await audit(req.user.id, 'menu.reorder_level_set', 'ingredient', req.body.ingredient_id, { branch_id: req.body.branch_id, level });
  res.json({ ok: true });
}));

export default router;
