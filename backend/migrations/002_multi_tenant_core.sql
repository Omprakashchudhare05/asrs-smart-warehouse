-- ============================================================================
-- ASRS SMART WAREHOUSE — MULTI-TENANT SAAS MIGRATION
-- File: backend/migrations/002_multi_tenant_core.sql
-- Target Database: Supabase PostgreSQL (Production Review Only)
-- Scope: Additive Multi-Store Schema, Platform Hierarchy, and Tenant Scoping
-- STRICT RULE: Purely additive. Preserves all existing users, credentials,
--              testboss account, 16 slots, 33 transactions, and rack config.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. PRE-CHECK: Confirm database state and existing tables
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users') THEN
    RAISE EXCEPTION 'Pre-check failed: table "users" does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'slots') THEN
    RAISE EXCEPTION 'Pre-check failed: table "slots" does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'transactions') THEN
    RAISE EXCEPTION 'Pre-check failed: table "transactions" does not exist.';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. ADDITIVE COLUMNS: Tenant Scoping & Platform Roles
-- ----------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_role TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS store_id TEXT NOT NULL DEFAULT 'store_default_001';
ALTER TABLE slots ADD COLUMN IF NOT EXISTS store_id TEXT NOT NULL DEFAULT 'store_default_001';
ALTER TABLE rack_config ADD COLUMN IF NOT EXISTS store_id TEXT NOT NULL DEFAULT 'store_default_001';

-- ----------------------------------------------------------------------------
-- 3. MULTI-TENANT TABLES
-- ----------------------------------------------------------------------------

-- Stores: Central tenant registry for independent grocery, quick-commerce, and warehouses
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  store_type TEXT NOT NULL DEFAULT 'warehouse',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'suspended', 'rejected')),
  owner_user_id TEXT,
  address TEXT,
  city TEXT,
  max_slots INT DEFAULT 50,
  subscription_plan TEXT DEFAULT 'starter',
  rack_rows INT NOT NULL DEFAULT 4,
  rack_cols INT NOT NULL DEFAULT 4,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Store Memberships: Strict user-store mapping and store-level role binding
CREATE TABLE IF NOT EXISTS store_memberships (
  id SERIAL PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('store_owner', 'store_admin', 'operator')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated', 'pending')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (store_id, user_id)
);

-- Store Devices: Hardware device authentication bound strictly per store
CREATE TABLE IF NOT EXISTS store_devices (
  id SERIAL PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  device_key TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Audit Logs: Cross-tenant access monitoring, security logging, and staff audits
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  store_id TEXT,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- 4. PERFORMANCE & ISOLATION INDEXES
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_stores_code ON stores(code);
CREATE INDEX IF NOT EXISTS idx_stores_status ON stores(status);
CREATE INDEX IF NOT EXISTS idx_store_memberships_user ON store_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_store_memberships_store ON store_memberships(store_id);
CREATE INDEX IF NOT EXISTS idx_store_devices_key ON store_devices(device_key);
CREATE INDEX IF NOT EXISTS idx_slots_store_id ON slots(store_id);
CREATE INDEX IF NOT EXISTS idx_transactions_store_id ON transactions(store_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_store ON audit_logs(store_id);

-- ----------------------------------------------------------------------------
-- 5. SLOTS PRIMARY KEY ADJUSTMENT FOR MULTI-TENANCY
-- Converts slots PRIMARY KEY from (slot) to composite (store_id, slot)
-- and unique item constraint to (store_id, item)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  existing_pk_name TEXT;
  pk_cols INT := 0;
BEGIN
  -- Dynamically discover existing primary key constraint name and column count on slots
  SELECT tc.constraint_name, COUNT(kcu.column_name)
  INTO existing_pk_name, pk_cols
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
   AND tc.table_name = kcu.table_name
  WHERE tc.table_name = 'slots'
    AND tc.constraint_type = 'PRIMARY KEY'
  GROUP BY tc.constraint_name;

  IF pk_cols = 1 THEN
    -- Drop legacy single-column primary key (regardless of generated constraint name)
    EXECUTE 'ALTER TABLE slots DROP CONSTRAINT IF EXISTS ' || quote_ident(existing_pk_name);
    ALTER TABLE slots ADD CONSTRAINT slots_pkey PRIMARY KEY (store_id, slot);
  ELSIF pk_cols = 0 OR pk_cols IS NULL THEN
    -- No primary key found; safely add composite primary key
    ALTER TABLE slots ADD CONSTRAINT slots_pkey PRIMARY KEY (store_id, slot);
  END IF;
  -- If pk_cols >= 2, composite primary key already exists; no-op.

  -- Safely migrate unique item constraint to (store_id, item)
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slots_item_key') THEN
    ALTER TABLE slots DROP CONSTRAINT slots_item_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slots_store_item_key') THEN
    ALTER TABLE slots ADD CONSTRAINT slots_store_item_key UNIQUE (store_id, item);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 6. DATA BACKFILL & SEEDING (Idempotent & Non-Destructive)
-- ----------------------------------------------------------------------------

-- A. Seed default warehouse store from warehouse_config
INSERT INTO stores (id, name, code, slug, store_type, status, owner_user_id, city, rack_rows, rack_cols)
SELECT
  'store_default_001',
  COALESCE(warehouse_name, 'Main Warehouse'),
  COALESCE(warehouse_code, 'WH-001'),
  'default-warehouse',
  'warehouse',
  'active',
  'testboss',
  COALESCE(location, 'Nagpur'),
  4,
  4
FROM warehouse_config
WHERE id = 1
ON CONFLICT (id) DO NOTHING;

-- Fallback default store insert if warehouse_config was empty
INSERT INTO stores (id, name, code, slug, store_type, status, owner_user_id, city, rack_rows, rack_cols)
VALUES ('store_default_001', 'Main Warehouse', 'WH-001', 'default-warehouse', 'warehouse', 'active', 'testboss', 'Nagpur', 4, 4)
ON CONFLICT (id) DO NOTHING;

-- B. Assign Platform Owner role to testboss
UPDATE users
SET platform_role = 'platform_owner'
WHERE user_id = 'testboss' AND (platform_role IS NULL OR platform_role = '');

-- C. Enroll testboss as store_owner of default store
INSERT INTO store_memberships (store_id, user_id, role, status)
VALUES ('store_default_001', 'testboss', 'store_owner', 'active')
ON CONFLICT (store_id, user_id) DO NOTHING;

-- D. Backfill legacy active users into default store memberships (strictly only those with zero store memberships)
INSERT INTO store_memberships (store_id, user_id, role, status)
SELECT
  'store_default_001',
  u.user_id,
  CASE
    WHEN u.user_id = 'testboss' OR u.role = 'boss' OR u.effective_role = 'owner' THEN 'store_owner'
    WHEN u.effective_role = 'admin' OR (u.requested_role = 'admin' AND u.role = 'boss') THEN 'store_admin'
    ELSE 'operator'
  END,
  'active'
FROM users u
WHERE u.active = 1
  AND NOT EXISTS (SELECT 1 FROM store_memberships sm WHERE sm.user_id = u.user_id)
ON CONFLICT (store_id, user_id) DO NOTHING;

-- E. Backfill active hardware API key into store_devices for default store
INSERT INTO store_devices (store_id, device_key, device_name, status)
SELECT
  'store_default_001',
  value,
  'Main ESP32 Controller',
  'active'
FROM system_settings
WHERE key = 'hardware_api_key'
ON CONFLICT (device_key) DO NOTHING;

-- F. Ensure all slots and transactions belong to default store
UPDATE slots SET store_id = 'store_default_001' WHERE store_id IS NULL OR store_id = '';
UPDATE transactions SET store_id = 'store_default_001' WHERE store_id IS NULL OR store_id = '';
UPDATE rack_config SET store_id = 'store_default_001' WHERE store_id IS NULL OR store_id = '';

COMMIT;

-- ----------------------------------------------------------------------------
-- 7. VERIFICATION QUERIES (Run to verify migration success)
-- ----------------------------------------------------------------------------
-- SELECT id, name, code, status, owner_user_id FROM stores;
-- SELECT store_id, user_id, role, status FROM store_memberships;
-- SELECT store_id, device_name, status FROM store_devices;
-- SELECT COUNT(*) as total_slots, store_id FROM slots GROUP BY store_id;
-- SELECT COUNT(*) as total_txs, store_id FROM transactions GROUP BY store_id;
-- SELECT user_id, role, effective_role, platform_role FROM users WHERE user_id = 'testboss';

-- ----------------------------------------------------------------------------
-- 8. EMERGENCY ROLLBACK INSTRUCTIONS & LIMITATIONS (Review only)
-- ----------------------------------------------------------------------------
-- ROLLBACK LIMITATIONS & WARNINGS:
-- 1. DATA LOSS RISK: Rolling back multi-tenancy is IRREVERSIBLE and DESTRUCTIVE for all
--    secondary stores created after this migration. All secondary store memberships,
--    hardware device keys, audit logs, and custom slot configurations will be permanently dropped.
-- 2. PRIMARY KEY RESTORATION PRE-REQUISITE: Restoring the single-column PRIMARY KEY (slot)
--    requires that every slot code in table "slots" be globally unique. If multiple stores
--    have been initialized (each having slots A1-D4), any attempt to restore PRIMARY KEY (slot)
--    will FAIL with unique violation (23505) until all non-default store slots are deleted or archived.
-- 3. TRANSACTION ORPHANING / LOSS: Transactions recorded for secondary stores will be
--    deleted or lose their store association when store_id is dropped. Always perform a
--    full database backup (pg_dump) before executing any rollback.
-- 4. PARTIAL MIGRATION RESILIENCE: If a rollback fails midway, inspect information_schema.table_constraints
--    to verify existing constraint names before re-attempting.
--
-- If ever required to revert multi-tenant tables:
-- BEGIN;
-- DROP TABLE IF EXISTS audit_logs CASCADE;
-- DROP TABLE IF EXISTS store_devices CASCADE;
-- DROP TABLE IF EXISTS store_memberships CASCADE;
-- DROP TABLE IF EXISTS stores CASCADE;
-- ALTER TABLE users DROP COLUMN IF EXISTS platform_role;
-- ALTER TABLE transactions DROP COLUMN IF EXISTS store_id;
-- ALTER TABLE rack_config DROP COLUMN IF EXISTS store_id;
-- DO $$
-- DECLARE
--   curr_pk_name TEXT;
-- BEGIN
--   SELECT constraint_name INTO curr_pk_name
--   FROM information_schema.table_constraints
--   WHERE table_name = 'slots' AND constraint_type = 'PRIMARY KEY';
--   IF curr_pk_name IS NOT NULL THEN
--     EXECUTE 'ALTER TABLE slots DROP CONSTRAINT IF EXISTS ' || quote_ident(curr_pk_name);
--   END IF;
--   DELETE FROM slots WHERE store_id != 'store_default_001';
--   ALTER TABLE slots ADD CONSTRAINT slots_pkey PRIMARY KEY (slot);
--   ALTER TABLE slots DROP COLUMN IF EXISTS store_id;
--   IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slots_store_item_key') THEN
--     ALTER TABLE slots DROP CONSTRAINT slots_store_item_key;
--   END IF;
--   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slots_item_key') THEN
--     ALTER TABLE slots ADD CONSTRAINT slots_item_key UNIQUE (item);
--   END IF;
-- END $$;
-- COMMIT;
