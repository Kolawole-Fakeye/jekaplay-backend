-- jekaplay-backend / db/migrations/001_schema.sql
-- Step 1: schema and branches. PostgreSQL 13+.
-- Money is stored in kobo (integer). Timestamps are timestamptz (UTC).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- Enums ----------
CREATE TYPE user_role AS ENUM ('owner', 'supervisor', 'staff', 'customer');
CREATE TYPE order_type AS ENUM ('pickup', 'eat_in', 'delivery');
CREATE TYPE order_channel AS ENUM ('staff', 'web', 'qr');
CREATE TYPE order_status AS ENUM (
  'pending_payment', 'received', 'preparing', 'ready',
  'out_for_delivery', 'completed', 'cancelled'
);
CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'failed', 'expired', 'refunded');
CREATE TYPE payment_method AS ENUM ('transfer', 'card', 'cash', 'pos');
CREATE TYPE stock_move_reason AS ENUM ('restock', 'sale', 'waste', 'adjustment', 'opening');
CREATE TYPE voucher_kind AS ENUM ('birthday', 'loyalty', 'referral', 'manual');
CREATE TYPE message_channel AS ENUM ('whatsapp', 'email', 'sms', 'push');
CREATE TYPE message_purpose AS ENUM ('transactional', 'restock_alert', 'shortfall_alert', 'promotional');

-- ---------- Shared trigger ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ---------- Branches ----------
CREATE TABLE branches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,            -- 'UNILAG', 'ORILE', 'LASU'
  name        text NOT NULL,
  address     text,
  phone       text,
  timezone    text NOT NULL DEFAULT 'Africa/Lagos',
  is_active   boolean NOT NULL DEFAULT true,
  accepts_delivery boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_branches_updated BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO branches (code, name) VALUES
  ('UNILAG', 'Jekaplay Unilag'),
  ('ORILE',  'Jekaplay Orile'),
  ('LASU',   'Jekaplay LASU');

-- ---------- Users ----------
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role           user_role NOT NULL,
  full_name      text NOT NULL,
  email          citext UNIQUE,
  phone          text UNIQUE,
  password_hash  text NOT NULL,
  birthday       date,                          -- customers: birthday vouchers
  referral_code  text UNIQUE,
  referred_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  is_active      boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  deleted_at     timestamptz,                   -- delete-account: anonymise + stamp
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_contact_chk CHECK (email IS NOT NULL OR phone IS NOT NULL OR deleted_at IS NOT NULL)
);
CREATE INDEX idx_users_role ON users(role) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which branches a staff/supervisor works at (owner sees all, customers none)
CREATE TABLE user_branches (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id  uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);

-- ---------- Customer profile and consent ----------
CREATE TABLE customer_profiles (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferred_branch uuid REFERENCES branches(id) ON DELETE SET NULL,
  whatsapp_number  text,
  dark_mode        text CHECK (dark_mode IN ('light', 'dark', 'system')) DEFAULT 'system',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_cprof_updated BEFORE UPDATE ON customer_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE consents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     message_channel NOT NULL,
  purpose     message_purpose NOT NULL,
  granted     boolean NOT NULL,
  source      text,                              -- 'signup', 'settings', 'whatsapp_reply'
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_consents_lookup ON consents(user_id, channel, purpose, created_at DESC);

CREATE TABLE customer_addresses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       text,
  address     text NOT NULL,
  landmark    text,
  zone_id     uuid,                              -- FK added after delivery_zones
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Delivery zones (per branch, approved areas and fees) ----------
CREATE TABLE delivery_zones (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name          text NOT NULL,
  fee_kobo      integer NOT NULL CHECK (fee_kobo >= 0),
  min_order_kobo integer NOT NULL DEFAULT 0,
  est_minutes   integer,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (branch_id, name)
);
ALTER TABLE customer_addresses
  ADD CONSTRAINT fk_addr_zone FOREIGN KEY (zone_id) REFERENCES delivery_zones(id) ON DELETE SET NULL;

-- ---------- Menu ----------
CREATE TABLE menu_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE menu_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id  uuid REFERENCES menu_categories(id) ON DELETE SET NULL,
  name         text NOT NULL,
  description  text,
  image_url    text,
  base_price_kobo integer NOT NULL CHECK (base_price_kobo >= 0),
  tags         text[] NOT NULL DEFAULT '{}',     -- spicy, vegetarian, etc. (recommendations)
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_items_updated BEFORE UPDATE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Per-branch availability and optional price override
CREATE TABLE branch_menu_items (
  branch_id     uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  menu_item_id  uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  price_kobo    integer CHECK (price_kobo >= 0),  -- NULL = use base price
  is_available  boolean NOT NULL DEFAULT true,
  PRIMARY KEY (branch_id, menu_item_id)
);

-- ---------- Ingredients, stock and recipes ----------
CREATE TABLE ingredients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,              -- rice, spaghetti, beef, sausages...
  unit        text NOT NULL,                     -- kg, pieces, litres
  is_active   boolean NOT NULL DEFAULT true
);

-- Per-branch stock level and restock threshold
CREATE TABLE branch_stock (
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  ingredient_id   uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  quantity        numeric(12,3) NOT NULL DEFAULT 0,
  reorder_level   numeric(12,3) NOT NULL DEFAULT 0,
  low_alert_sent_at timestamptz,                 -- avoids alert spam
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, ingredient_id)
);

CREATE TABLE stock_movements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      uuid NOT NULL REFERENCES branches(id),
  ingredient_id  uuid NOT NULL REFERENCES ingredients(id),
  delta          numeric(12,3) NOT NULL,         -- + restock, - usage
  reason         stock_move_reason NOT NULL,
  order_id       uuid,                           -- FK added after orders
  note           text,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_stockmov_branch_time ON stock_movements(branch_id, created_at DESC);

-- How much ingredient one portion of a menu item consumes (for stock deduction)
CREATE TABLE recipe_lines (
  menu_item_id   uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_id  uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty_per_portion numeric(12,4) NOT NULL CHECK (qty_per_portion > 0),
  PRIMARY KEY (menu_item_id, ingredient_id)
);

-- ---------- Projected vs actual sales ----------
-- Supervisor records the day's ingredient quantities; portions are derived
-- from portions_per_unit (real yields to be confirmed with the restaurant).
CREATE TABLE portion_yields (
  menu_item_id    uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_id   uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  portions_per_unit numeric(10,3) NOT NULL CHECK (portions_per_unit > 0),
  PRIMARY KEY (menu_item_id, ingredient_id)
);

CREATE TABLE daily_prep (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  prep_date      date NOT NULL,
  ingredient_id  uuid NOT NULL REFERENCES ingredients(id),
  quantity       numeric(12,3) NOT NULL CHECK (quantity >= 0),
  recorded_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, prep_date, ingredient_id)
);

-- ---------- Tables (QR dine-in) ----------
CREATE TABLE dining_tables (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  label       text NOT NULL,                     -- 'T1', 'T2'
  qr_token    text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(12), 'hex'),
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (branch_id, label)
);

-- ---------- Vouchers and loyalty ----------
CREATE TABLE vouchers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,
  kind           voucher_kind NOT NULL,
  user_id        uuid REFERENCES users(id) ON DELETE CASCADE,  -- NULL = open to all
  percent_off    smallint CHECK (percent_off BETWEEN 1 AND 100),
  amount_off_kobo integer CHECK (amount_off_kobo > 0),
  min_order_kobo integer NOT NULL DEFAULT 0,
  valid_from     timestamptz NOT NULL DEFAULT now(),
  valid_until    timestamptz,
  max_redemptions integer NOT NULL DEFAULT 1,
  redeemed_count integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT voucher_value_chk CHECK ((percent_off IS NOT NULL) <> (amount_off_kobo IS NOT NULL))
);

CREATE TABLE loyalty_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  points      integer NOT NULL,                  -- + earned, - redeemed
  reason      text NOT NULL,                     -- 'order', 'referral', 'redeem', 'bonus'
  order_id    uuid,                              -- FK added after orders
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_loyalty_user ON loyalty_ledger(user_id, created_at DESC);

-- ---------- Orders ----------
CREATE SEQUENCE order_number_seq START 1001;

CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no         bigint NOT NULL UNIQUE DEFAULT nextval('order_number_seq'),
  branch_id        uuid NOT NULL REFERENCES branches(id),
  channel          order_channel NOT NULL,
  order_type       order_type NOT NULL,
  status           order_status NOT NULL DEFAULT 'pending_payment',
  customer_id      uuid REFERENCES users(id) ON DELETE SET NULL,   -- NULL = walk-in
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,   -- staff attribution
  table_id         uuid REFERENCES dining_tables(id) ON DELETE SET NULL,
  delivery_zone_id uuid REFERENCES delivery_zones(id) ON DELETE SET NULL,
  delivery_address text,
  delivery_fee_kobo integer NOT NULL DEFAULT 0,
  subtotal_kobo    integer NOT NULL CHECK (subtotal_kobo >= 0),
  discount_kobo    integer NOT NULL DEFAULT 0,
  voucher_id       uuid REFERENCES vouchers(id) ON DELETE SET NULL,
  total_kobo       integer NOT NULL CHECK (total_kobo >= 0),
  notes            text,
  guest_name       text,
  guest_phone      text,
  placed_at        timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_dinein_chk CHECK (order_type <> 'eat_in' OR channel <> 'qr' OR table_id IS NOT NULL),
  CONSTRAINT orders_delivery_chk CHECK (order_type <> 'delivery' OR delivery_zone_id IS NOT NULL)
);
CREATE INDEX idx_orders_branch_status ON orders(branch_id, status, placed_at DESC);
CREATE INDEX idx_orders_customer ON orders(customer_id, placed_at DESC);
CREATE INDEX idx_orders_created_by ON orders(created_by);
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE order_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id    uuid NOT NULL REFERENCES menu_items(id),
  name_snapshot   text NOT NULL,
  unit_price_kobo integer NOT NULL CHECK (unit_price_kobo >= 0),
  quantity        integer NOT NULL CHECK (quantity > 0),
  line_total_kobo integer NOT NULL CHECK (line_total_kobo >= 0),
  note            text
);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_item ON order_items(menu_item_id);

CREATE TABLE order_status_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status order_status,
  to_status   order_status NOT NULL,
  changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,  -- NULL = system/webhook
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_osh_order ON order_status_history(order_id, created_at);

ALTER TABLE stock_movements ADD CONSTRAINT fk_stockmov_order
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE loyalty_ledger ADD CONSTRAINT fk_loyalty_order
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;

-- ---------- Payments (Monnify; no card data is ever stored) ----------
CREATE TABLE payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method                payment_method NOT NULL,
  status                payment_status NOT NULL DEFAULT 'pending',
  amount_kobo           integer NOT NULL CHECK (amount_kobo > 0),
  payment_reference     text NOT NULL UNIQUE,    -- our reference sent to Monnify
  monnify_transaction_ref text UNIQUE,
  transfer_account_number text,                  -- one-time account for pay-by-transfer
  transfer_bank_name    text,
  expires_at            timestamptz,
  paid_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_order ON payments(order_id);
CREATE TRIGGER trg_payments_updated BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Raw webhook log; unique key makes processing idempotent
CREATE TABLE webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL DEFAULT 'monnify',
  event_key     text NOT NULL,                   -- transactionReference + event type
  signature_valid boolean NOT NULL,
  payload       jsonb NOT NULL,
  processed_at  timestamptz,
  error         text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_key)
);

-- ---------- Notifications (WhatsApp etc.) and alerts ----------
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  channel     message_channel NOT NULL,
  purpose     message_purpose NOT NULL,
  recipient   text NOT NULL,
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','skipped_no_consent')),
  provider_id text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX idx_notif_status ON notifications(status, created_at);

CREATE TABLE alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('low_stock', 'shortfall', 'excess')),
  ingredient_id uuid REFERENCES ingredients(id) ON DELETE SET NULL,
  menu_item_id  uuid REFERENCES menu_items(id) ON DELETE SET NULL,
  message     text NOT NULL,
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_alerts_open ON alerts(branch_id, created_at DESC) WHERE resolved_at IS NULL;

-- ---------- Support ----------
CREATE TABLE support_tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  branch_id   uuid REFERENCES branches(id) ON DELETE SET NULL,
  order_id    uuid REFERENCES orders(id) ON DELETE SET NULL,
  subject     text NOT NULL,
  message     text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','closed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMIT;
