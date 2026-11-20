import express from 'express';
import cors from 'cors';
import { pool, query } from './db.js';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// 1. Health check
app.get('/api/health', async (_req, res) => {
  try {
    const { rows } = await query('SELECT NOW() AS server_time, count(*)::int AS branch_count FROM branches');
    res.json({ ok: true, ...rows[0] });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 2. Bootstrap data for UI (branches, menu, zones, users, stock, variance, alerts)
app.get('/api/bootstrap', async (req, res) => {
  try {
    const branchCode = (req.query.branch || 'UNILAG').toUpperCase();

    const [branchesRes, zonesRes, menuRes, usersRes, stockRes, alertsRes, ordersRes, varianceRes] =
      await Promise.all([
        query('SELECT id, code, name, accepts_delivery FROM branches WHERE is_active = true ORDER BY code'),
        query(
          `SELECT dz.id, dz.branch_id, b.code AS branch_code, dz.name, dz.fee_kobo, dz.min_order_kobo, dz.est_minutes
           FROM delivery_zones dz
           JOIN branches b ON b.id = dz.branch_id
           WHERE dz.is_active = true`
        ),
        query(
          `SELECT id, name, description, base_price_kobo, tags
           FROM menu_items
           WHERE is_active = true
           ORDER BY name`
        ),
        query(
          `SELECT id, role, full_name, email, phone, birthday, referral_code
           FROM users
           WHERE deleted_at IS NULL AND is_active = true
           ORDER BY role, full_name`
        ),
        query(
          `SELECT bs.branch_id, b.code AS branch_code, i.id AS ingredient_id, i.name, i.unit,
                  bs.quantity, bs.reorder_level, bs.low_alert_sent_at
           FROM branch_stock bs
           JOIN branches b ON b.id = bs.branch_id
           JOIN ingredients i ON i.id = bs.ingredient_id
           WHERE i.is_active = true
           ORDER BY i.name`
        ),
        query(
          `SELECT a.id, a.branch_id, b.code AS branch_code, a.kind, a.message, a.created_at
           FROM alerts a
           JOIN branches b ON b.id = a.branch_id
           WHERE a.resolved_at IS NULL
           ORDER BY a.created_at DESC
           LIMIT 25`
        ),
        query(
          `SELECT o.id, o.order_no, b.code AS branch_code, o.channel, o.order_type, o.status,
                  o.subtotal_kobo, o.delivery_fee_kobo, o.discount_kobo, o.total_kobo,
                  o.delivery_address, o.guest_name, o.placed_at,
                  u_staff.full_name AS staff_name,
                  u_cust.full_name AS customer_name
           FROM orders o
           JOIN branches b ON b.id = o.branch_id
           LEFT JOIN users u_staff ON u_staff.id = o.created_by
           LEFT JOIN users u_cust ON u_cust.id = o.customer_id
           ORDER BY o.placed_at DESC
           LIMIT 20`
        ),
        query(
          `WITH daily_projected AS (
             SELECT
               b.code AS branch_code,
               mi.id AS menu_item_id,
               mi.name AS menu_item_name,
               mi.base_price_kobo,
               MIN(FLOOR(dp.quantity * py.portions_per_unit))::int AS projected_portions
             FROM daily_prep dp
             JOIN branches b ON b.id = dp.branch_id
             JOIN portion_yields py ON py.ingredient_id = dp.ingredient_id
             JOIN menu_items mi ON mi.id = py.menu_item_id
             WHERE dp.prep_date = CURRENT_DATE AND mi.is_active = true
             GROUP BY b.code, mi.id, mi.name, mi.base_price_kobo
           ),
           actual_sold AS (
             SELECT
               b.code AS branch_code,
               oi.menu_item_id,
               COALESCE(SUM(oi.quantity), 0)::int AS actual_portions,
               COALESCE(SUM(oi.line_total_kobo), 0)::bigint AS actual_revenue_kobo
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             JOIN branches b ON b.id = o.branch_id
             WHERE o.placed_at::date = CURRENT_DATE AND o.status <> 'cancelled'
             GROUP BY b.code, oi.menu_item_id
           )
           SELECT
             COALESCE(p.branch_code, a.branch_code) AS branch_code,
             COALESCE(p.menu_item_id, a.menu_item_id) AS menu_item_id,
             p.menu_item_name,
             COALESCE(p.projected_portions, 0)::int AS projected_portions,
             COALESCE(a.actual_portions, 0)::int AS actual_portions,
             (COALESCE(a.actual_portions, 0) - COALESCE(p.projected_portions, 0))::int AS variance_portions,
             (COALESCE(p.projected_portions, 0) * COALESCE(p.base_price_kobo, 0))::bigint AS projected_sales_kobo,
             COALESCE(a.actual_revenue_kobo, 0)::bigint AS actual_sales_kobo,
             (COALESCE(a.actual_revenue_kobo, 0) - (COALESCE(p.projected_portions, 0) * COALESCE(p.base_price_kobo, 0)))::bigint AS variance_kobo
           FROM daily_projected p
           FULL OUTER JOIN actual_sold a
             ON p.branch_code = a.branch_code AND p.menu_item_id = a.menu_item_id
           WHERE COALESCE(p.branch_code, a.branch_code) = $1 OR $1 = 'ALL'`,
          [branchCode]
        ),
      ]);

    res.json({
      branches: branchesRes.rows,
      deliveryZones: zonesRes.rows,
      menuItems: menuRes.rows,
      users: usersRes.rows,
      stock: stockRes.rows,
      alerts: alertsRes.rows,
      recentOrders: ordersRes.rows,
      variance: varianceRes.rows,
    });
  } catch (err) {
    console.error('Bootstrap error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Create order (staff-attributed or customer, with delivery zone check, stock deduction & alerts)
app.post('/api/orders', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      branch_id,
      channel = 'staff',
      order_type = 'pickup',
      customer_id = null,
      created_by = null,
      delivery_zone_id = null,
      delivery_address = null,
      guest_name = null,
      guest_phone = null,
      notes = null,
      items = [],
    } = req.body;

    if (!branch_id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'branch_id and at least one item are required' });
    }

    await client.query('BEGIN');

    // Fetch menu prices
    let subtotalKobo = 0;
    const enrichedItems = [];

    for (const item of items) {
      const qty = Number(item.quantity || 0);
      if (qty <= 0) {
        throw new Error('Item quantity must be greater than 0');
      }

      const menuRes = await client.query(
        `SELECT mi.id, mi.name, COALESCE(bmi.price_kobo, mi.base_price_kobo) AS unit_price_kobo
         FROM menu_items mi
         LEFT JOIN branch_menu_items bmi ON bmi.menu_item_id = mi.id AND bmi.branch_id = $1
         WHERE mi.id = $2 AND mi.is_active = true`,
        [branch_id, item.menu_item_id]
      );

      if (menuRes.rowCount === 0) {
        throw new Error(`Menu item not found: ${item.menu_item_id}`);
      }

      const row = menuRes.rows[0];
      const lineTotalKobo = Number(row.unit_price_kobo) * qty;
      subtotalKobo += lineTotalKobo;
      enrichedItems.push({
        menu_item_id: row.id,
        name_snapshot: row.name,
        unit_price_kobo: Number(row.unit_price_kobo),
        quantity: qty,
        line_total_kobo: lineTotalKobo,
        note: item.note || null,
      });
    }

    // Delivery validation & fee
    let deliveryFeeKobo = 0;
    let validZoneId = null;

    if (order_type === 'delivery') {
      if (!delivery_zone_id) {
        throw new Error('delivery_zone_id is required for delivery orders');
      }
      const zoneRes = await client.query(
        `SELECT id, fee_kobo, min_order_kobo
         FROM delivery_zones
         WHERE id = $1 AND branch_id = $2 AND is_active = true`,
        [delivery_zone_id, branch_id]
      );
      if (zoneRes.rowCount === 0) {
        throw new Error('Selected delivery zone is not approved for this branch');
      }
      const zone = zoneRes.rows[0];
      if (subtotalKobo < Number(zone.min_order_kobo)) {
        throw new Error(`Order subtotal is below minimum order for selected delivery zone`);
      }
      deliveryFeeKobo = Number(zone.fee_kobo);
      validZoneId = zone.id;
    }

    const totalKobo = subtotalKobo + deliveryFeeKobo;

    const orderRes = await client.query(
      `INSERT INTO orders (
         branch_id, channel, order_type, status, customer_id, created_by,
         delivery_zone_id, delivery_address, delivery_fee_kobo,
         subtotal_kobo, discount_kobo, total_kobo, notes, guest_name, guest_phone
       )
       VALUES ($1, $2, $3, 'received', $4, $5, $6, $7, $8, $9, 0, $10, $11, $12, $13)
       RETURNING *`,
      [
        branch_id,
        channel,
        order_type,
        customer_id,
        created_by,
        validZoneId,
        order_type === 'delivery' ? delivery_address : null,
        deliveryFeeKobo,
        subtotalKobo,
        totalKobo,
        notes,
        guest_name,
        guest_phone,
      ]
    );

    const order = orderRes.rows[0];

    await client.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by)
       VALUES ($1, NULL, 'received', $2)`,
      [order.id, created_by]
    );

    for (const line of enrichedItems) {
      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, name_snapshot, unit_price_kobo, quantity, line_total_kobo, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          order.id,
          line.menu_item_id,
          line.name_snapshot,
          line.unit_price_kobo,
          line.quantity,
          line.line_total_kobo,
          line.note,
        ]
      );

      // Deduct recipe ingredient stock & log movement + low-stock alert
      const recipes = await client.query(
        `SELECT ingredient_id, qty_per_portion FROM recipe_lines WHERE menu_item_id = $1`,
        [line.menu_item_id]
      );

      for (const rec of recipes.rows) {
        const deductQty = Number(rec.qty_per_portion) * line.quantity;

        await client.query(
          `INSERT INTO stock_movements (branch_id, ingredient_id, delta, reason, order_id, note, created_by)
           VALUES ($1, $2, $3, 'sale', $4, $5, $6)`,
          [branch_id, rec.ingredient_id, -deductQty, order.id, `Order #${order.order_no}`, created_by]
        );

        const stockRes = await client.query(
          `UPDATE branch_stock
           SET quantity = quantity - $1, updated_at = now()
           WHERE branch_id = $2 AND ingredient_id = $3
           RETURNING quantity, reorder_level, low_alert_sent_at`,
          [deductQty, branch_id, rec.ingredient_id]
        );

        if (stockRes.rowCount > 0) {
          const st = stockRes.rows[0];
          if (Number(st.quantity) <= Number(st.reorder_level) && !st.low_alert_sent_at) {
            const ingNameRes = await client.query('SELECT name, unit FROM ingredients WHERE id = $1', [
              rec.ingredient_id,
            ]);
            const ing = ingNameRes.rows[0] || { name: 'Item', unit: '' };
            await client.query(
              `INSERT INTO alerts (branch_id, kind, ingredient_id, message)
               VALUES ($1, 'low_stock', $2, $3)`,
              [
                branch_id,
                rec.ingredient_id,
                `Restock alert: ${ing.name} at ${st.quantity} ${ing.unit} (reorder level: ${st.reorder_level} ${ing.unit})`,
              ]
            );
            await client.query(
              `UPDATE branch_stock SET low_alert_sent_at = now() WHERE branch_id = $1 AND ingredient_id = $2`,
              [branch_id, rec.ingredient_id]
            );
          }
        }
      }
    }

    // Loyalty points for signed-in customers (1 pt per ₦1,000)
    if (customer_id) {
      const pointsEarned = Math.floor(totalKobo / 100000);
      if (pointsEarned > 0) {
        await client.query(
          `INSERT INTO loyalty_ledger (user_id, points, reason, order_id)
           VALUES ($1, $2, 'order', $3)`,
          [customer_id, pointsEarned, order.id]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ order });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create order error:', err);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.listen(PORT, () => {
  console.log(`Jekaplay API running on port ${PORT}`);
});
