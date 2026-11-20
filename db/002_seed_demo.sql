BEGIN;

-- Sample users (password_hash placeholder for prototype seed)
INSERT INTO users (id, role, full_name, email, phone, password_hash, birthday, referral_code)
VALUES
  ('11111111-1111-4111-8111-111111111101', 'owner', 'Jekaplay Owner', 'owner@jekaplayonline.com', '+2348000000001', 'seed_hash_placeholder', NULL, 'OWN001'),
  ('11111111-1111-4111-8111-111111111102', 'supervisor', 'Tunde Supervisor', 'tunde.sup@jekaplayonline.com', '+2348000000002', 'seed_hash_placeholder', '1990-05-14', 'SUP001'),
  ('11111111-1111-4111-8111-111111111103', 'staff', 'Chidi Staff', 'chidi.staff@jekaplayonline.com', '+2348000000003', 'seed_hash_placeholder', '1997-08-22', 'STF001'),
  ('11111111-1111-4111-8111-111111111104', 'staff', 'Amina Staff', 'amina.staff@jekaplayonline.com', '+2348000000004', 'seed_hash_placeholder', '1998-03-11', 'STF002'),
  ('11111111-1111-4111-8111-111111111105', 'customer', 'Adaeze Customer', 'adaeze@example.com', '+2348000000005', 'seed_hash_placeholder', CURRENT_DATE, 'ADA100'),
  ('11111111-1111-4111-8111-111111111106', 'customer', 'Emeka Customer', 'emeka@example.com', '+2348000000006', 'seed_hash_placeholder', '1995-07-04', 'EME100')
ON CONFLICT (id) DO NOTHING;

-- Assign staff and supervisor to UNILAG branch
INSERT INTO user_branches (user_id, branch_id)
SELECT u.id, b.id
FROM users u
CROSS JOIN branches b
WHERE u.id IN (
  '11111111-1111-4111-8111-111111111102',
  '11111111-1111-4111-8111-111111111103',
  '11111111-1111-4111-8111-111111111104'
)
AND b.code = 'UNILAG'
ON CONFLICT DO NOTHING;

-- Approved delivery zones (fees in kobo: e.g., 150000 = N1,500)
INSERT INTO delivery_zones (branch_id, name, fee_kobo, min_order_kobo, est_minutes, is_active)
SELECT b.id, z.name, z.fee_kobo, z.min_order_kobo, z.est_minutes, true
FROM branches b
CROSS JOIN (
  VALUES
    ('UNILAG Campus & Yaba', 120000, 300000, 25),
    ('Surulere & Fadeyi', 180000, 400000, 35),
    ('Ikeja & Maryland', 250000, 600000, 45)
) AS z(name, fee_kobo, min_order_kobo, est_minutes)
WHERE b.code = 'UNILAG'
ON CONFLICT (branch_id, name) DO NOTHING;

INSERT INTO delivery_zones (branch_id, name, fee_kobo, min_order_kobo, est_minutes, is_active)
SELECT b.id, z.name, z.fee_kobo, z.min_order_kobo, z.est_minutes, true
FROM branches b
CROSS JOIN (
  VALUES
    ('Orile & Coker', 100000, 250000, 20),
    ('Mile 2 & Amuwo', 180000, 400000, 35)
) AS z(name, fee_kobo, min_order_kobo, est_minutes)
WHERE b.code = 'ORILE'
ON CONFLICT (branch_id, name) DO NOTHING;

-- Menu categories and items
INSERT INTO menu_categories (id, name, sort_order)
VALUES
  ('22222222-2222-4222-8222-222222222201', 'Rice & Pasta', 1),
  ('22222222-2222-4222-8222-222222222202', 'Proteins & Sides', 2)
ON CONFLICT (name) DO NOTHING;

INSERT INTO menu_items (id, category_id, name, description, base_price_kobo, tags)
VALUES
  ('33333333-3333-4333-8333-333333333301', '22222222-2222-4222-8222-222222222201', 'Smoky Jollof & Beef', 'Party jollof served with spiced beef', 350000, ARRAY['spicy','popular','beef']),
  ('33333333-3333-4333-8333-333333333302', '22222222-2222-4222-8222-222222222201', 'Stir-Fry Spaghetti & Sausages', 'Savory spaghetti tossed with grilled sausages', 320000, ARRAY['quick','sausage']),
  ('33333333-3333-4333-8333-333333333303', '22222222-2222-4222-8222-222222222202', 'Peppered Beef Pack', 'Extra tender beef portions', 200000, ARRAY['spicy','beef'])
ON CONFLICT (id) DO NOTHING;

-- Ingredients
INSERT INTO ingredients (id, name, unit)
VALUES
  ('44444444-4444-4444-8444-444444444401', 'Rice', 'kg'),
  ('44444444-4444-4444-8444-444444444402', 'Spaghetti', 'kg'),
  ('44444444-4444-4444-8444-444444444403', 'Beef', 'kg'),
  ('44444444-4444-4444-8444-444444444404', 'Sausages', 'pieces')
ON CONFLICT (name) DO NOTHING;

-- Branch stock levels (UNILAG)
INSERT INTO branch_stock (branch_id, ingredient_id, quantity, reorder_level)
SELECT b.id, i.id, s.qty, s.reorder
FROM branches b
JOIN ingredients i ON true
JOIN (
  VALUES
    ('Rice', 50.000, 15.000),
    ('Spaghetti', 30.000, 10.000),
    ('Beef', 18.000, 8.000),
    ('Sausages', 40.000, 20.000)
) AS s(ing_name, qty, reorder) ON s.ing_name = i.name
WHERE b.code = 'UNILAG'
ON CONFLICT (branch_id, ingredient_id) DO NOTHING;

-- Recipe lines (stock deduction per portion)
INSERT INTO recipe_lines (menu_item_id, ingredient_id, qty_per_portion)
VALUES
  ('33333333-3333-4333-8333-333333333301', '44444444-4444-4444-8444-444444444401', 0.2000),
  ('33333333-3333-4333-8333-333333333301', '44444444-4444-4444-8444-444444444403', 0.1000),
  ('33333333-3333-4333-8333-333333333302', '44444444-4444-4444-8444-444444444402', 0.2500),
  ('33333333-3333-4333-8333-333333333302', '44444444-4444-4444-8444-444444444404', 2.0000),
  ('33333333-3333-4333-8333-333333333303', '44444444-4444-4444-8444-444444444403', 0.1500)
ON CONFLICT (menu_item_id, ingredient_id) DO NOTHING;

-- Portion yields (projected portions per unit of ingredient prepped)
INSERT INTO portion_yields (menu_item_id, ingredient_id, portions_per_unit)
VALUES
  ('33333333-3333-4333-8333-333333333301', '44444444-4444-4444-8444-444444444401', 5.000),
  ('33333333-3333-4333-8333-333333333302', '44444444-4444-4444-8444-444444444402', 4.000),
  ('33333333-3333-4333-8333-333333333303', '44444444-4444-4444-8444-444444444403', 6.667)
ON CONFLICT (menu_item_id, ingredient_id) DO NOTHING;

-- Daily prep for today at UNILAG (e.g. 10kg rice -> 50 portions, 8kg spaghetti -> 32 portions, 6kg beef)
INSERT INTO daily_prep (branch_id, prep_date, ingredient_id, quantity, recorded_by)
SELECT b.id, CURRENT_DATE, i.id, p.qty, '11111111-1111-4111-8111-111111111102'
FROM branches b
JOIN ingredients i ON true
JOIN (
  VALUES
    ('Rice', 10.000),
    ('Spaghetti', 8.000),
    ('Beef', 6.000),
    ('Sausages', 24.000)
) AS p(ing_name, qty) ON p.ing_name = i.name
WHERE b.code = 'UNILAG'
ON CONFLICT (branch_id, prep_date, ingredient_id) DO NOTHING;

COMMIT;
