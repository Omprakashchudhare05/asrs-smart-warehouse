-- ============================================================================
-- ASRS SMART WAREHOUSE — BASELINE SCHEMA & SEED DATA (POSTGRESQL)
-- Target: Local PostgreSQL Staging (asrs_staging)
-- Source: backend/asrs.backup.db (Clean Single-Tenant Baseline Snapshot)
-- Baseline Commit: 9665a772dba700cee66221e151d8ef8d8c238feb
-- Safety: Executes in a single transaction; aborts if target tables exist.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. SAFETY PRE-CHECK (Fail if target database already contains application tables)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('warehouse_config', 'users', 'rack_config', 'slots', 'transactions', 'user_sessions', 'system_settings', 'otp_verifications')
  ) THEN
    RAISE EXCEPTION 'SAFETY STOP: Target database already contains existing ASRS application tables. Aborting 001_baseline_pg.sql to prevent accidental overwrite.';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. DDL: TABLE DEFINITIONS (Baseline Single-Tenant Schema)
-- ----------------------------------------------------------------------------
CREATE TABLE warehouse_config (
  id INT PRIMARY KEY CHECK(id=1),
  warehouse_name TEXT NOT NULL,
  warehouse_code TEXT NOT NULL,
  location TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('boss','operator')),
  active INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  email TEXT,
  phone TEXT,
  email_verified INT DEFAULT 0,
  phone_verified INT DEFAULT 0,
  approval_status TEXT NOT NULL DEFAULT 'approved',
  requested_role TEXT,
  effective_role TEXT,
  registration_reason TEXT,
  organization TEXT,
  employee_id TEXT,
  requested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  reviewed_by TEXT,
  rejection_reason TEXT
);

CREATE TABLE rack_config (
  id INT PRIMARY KEY CHECK(id=1),
  rows INT NOT NULL DEFAULT 4,
  cols INT NOT NULL DEFAULT 4,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE slots (
  slot TEXT PRIMARY KEY,
  item INT UNIQUE,
  x INT,
  y INT,
  occupied INT DEFAULT 1,
  quantity INT NOT NULL DEFAULT 1,
  capacity INT NOT NULL DEFAULT 10,
  item_name TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL DEFAULT ''
);

CREATE TABLE transactions (
  id SERIAL PRIMARY KEY,
  action TEXT,
  slot TEXT,
  item INT,
  source TEXT,
  time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  item_name TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL DEFAULT '',
  quantity INT NOT NULL DEFAULT 1,
  before_quantity INT NOT NULL DEFAULT 0,
  after_quantity INT NOT NULL DEFAULT 0,
  user_name TEXT DEFAULT 'System',
  role TEXT DEFAULT 'operator',
  user_id TEXT
);

CREATE TABLE user_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE otp_verifications (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  identifier TEXT NOT NULL,
  type TEXT NOT NULL,
  purpose TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  resend_count INT NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  verified INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_otp_identifier_purpose ON otp_verifications (identifier, purpose);

-- ----------------------------------------------------------------------------
-- 3. DML: BASELINE SEED DATA INSERTION
-- ----------------------------------------------------------------------------
INSERT INTO warehouse_config (id, warehouse_name, warehouse_code, location, created_at) VALUES (1, 'Test Warehouse', 'TEST-001', 'Nagpur', '2026-10-11T17:04:07Z');

-- Note: users table is intentionally initialized empty (provisioned securely on first startup or via web setup)

INSERT INTO rack_config (id, rows, cols, updated_at) VALUES (1, 4, 4, '2026-10-12T07:34:23Z');

-- Note: system_settings table is intentionally initialized empty (hardware key generated securely on startup or via HARDWARE_API_KEY)

INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES ('A1', 1, 0, 0, 1, 10, 10, 'Steel Screws', 'SKU-0001');
INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES ('A2', 2, 100, 0, 1, 1, 10, 'Ball Bearings', 'SKU-0002');
INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES ('A3', 3, 200, 0, 1, 1, 10, 'Proximity Sensors', 'SKU-0003');
INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES ('A4', 4, 300, 0, 1, 1, 10, 'Cable Connectors', 'SKU-0004');
INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES ('B1', 5, 0, 100, 1, 1, 10, 'Resistors', 'SKU-0005');
INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES ('B2', 6, 100, 100, 1, 1, 10, 'Capacitors', 'SKU-0006');
INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES ('B3', 7, 200, 100, 1, 1, 10, 'Integrated Circuits', 'SKU-0007');
INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES ('B4', 8, 300, 100, 1, 1, 10, 'Terminal Blocks', 'SKU-0008');
INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES ('C1', 9, 0, 200, 1, 1, 10, 'Limit Switches', 'SKU-0009');
INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES ('C2', 10, 100, 200, 1, 1, 10, 'DC Motors', 'SKU-0010');
INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES ('C3', 11, 200, 200, 1, 1, 10, 'Relay Modules', 'SKU-0011');
INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES ('C4', 12, 300, 200, 1, 1, 10, 'LED Indicators', 'SKU-0012');
INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES ('D1', 13, 0, 300, 1, 1, 10, 'Power Adapters', 'SKU-0013');
INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES ('D2', 14, 100, 300, 1, 1, 10, 'Mounting Brackets', 'SKU-0014');
INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES ('D3', 15, 200, 300, 1, 1, 10, 'Wire Spools', 'SKU-0015');
INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES ('D4', 16, 300, 300, 1, 1, 10, 'Spare Parts', 'SKU-0016');

INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (1, 'RETRIEVE', 'B2', 6, 'dashboard', '2026-09-30T15:13:39Z', '', '', 1, 0, 0, 'System', 'operator', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (2, 'STORE', 'B2', 6, 'dashboard', '2026-09-30T15:17:09Z', '', '', 1, 0, 0, 'System', 'operator', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (3, 'RETRIEVE', 'B1', 5, 'keypad', '2026-10-01T03:02:55Z', '', '', 1, 0, 0, 'System', 'operator', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (4, 'RETRIEVE', 'A1', 1, 'keypad', '2026-10-01T03:12:45Z', '', '', 1, 0, 0, 'System', 'operator', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (5, 'STORE', 'B1', 5, 'keypad', '2026-10-01T03:13:27Z', '', '', 1, 0, 0, 'System', 'operator', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (6, 'STORE', 'A1', 1, 'keypad', '2026-10-01T03:13:49Z', '', '', 1, 0, 0, 'System', 'operator', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (7, 'STORE', 'A1', 1, 'dashboard', '2026-10-12T06:29:54Z', 'Steel Screws', 'SKU-0001', 1, 1, 2, 'Test Boss', 'boss', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (8, 'RETRIEVE', 'A1', 1, 'dashboard', '2026-10-12T06:29:54Z', 'Steel Screws', 'SKU-0001', 1, 2, 1, 'Test Boss', 'boss', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (9, 'STORE', 'A1', 1, 'keypad', '2026-10-12T06:29:54Z', 'Steel Screws', 'SKU-0001', 1, 1, 2, 'ESP32 Device', 'hardware', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (10, 'RETRIEVE', 'A1', 1, 'keypad', '2026-10-12T06:29:54Z', 'Steel Screws', 'SKU-0001', 1, 2, 1, 'ESP32 Device', 'hardware', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (11, 'STORE', 'E5', 25, 'dashboard', '2026-10-12T06:29:54Z', 'Product E5', 'SKU-E5', 3, 0, 3, 'Test Boss', 'boss', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (12, 'RETRIEVE', 'E5', 25, 'dashboard', '2026-10-12T06:29:54Z', 'Product E5', 'SKU-E5', 3, 3, 0, 'Test Boss', 'boss', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (13, 'STORE', 'A1', 1, 'dashboard', '2026-10-12T06:33:11Z', 'Steel Screws', 'SKU-0001', 1, 1, 2, 'Test Boss', 'boss', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (14, 'RETRIEVE', 'A1', 1, 'dashboard', '2026-10-12T06:33:11Z', 'Steel Screws', 'SKU-0001', 1, 2, 1, 'Test Boss', 'boss', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (15, 'STORE', 'A1', 1, 'keypad', '2026-10-12T06:33:11Z', 'Steel Screws', 'SKU-0001', 1, 1, 2, 'ESP32 Device', 'hardware', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (16, 'RETRIEVE', 'A1', 1, 'keypad', '2026-10-12T06:33:11Z', 'Steel Screws', 'SKU-0001', 1, 2, 1, 'ESP32 Device', 'hardware', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (17, 'STORE', 'E5', 25, 'dashboard', '2026-10-12T06:33:11Z', 'Product E5', 'SKU-E5', 3, 0, 3, 'Test Boss', 'boss', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (18, 'RETRIEVE', 'E5', 25, 'dashboard', '2026-10-12T06:33:11Z', 'Product E5', 'SKU-E5', 3, 3, 0, 'Test Boss', 'boss', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (19, 'STORE', 'A1', 1, 'dashboard', '2026-10-12T07:02:00Z', 'Steel Screws', 'SKU-0001', 1, 1, 2, 'Test Boss', 'boss', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (20, 'RETRIEVE', 'A1', 1, 'dashboard', '2026-10-12T07:02:00Z', 'Steel Screws', 'SKU-0001', 1, 2, 1, 'Test Boss', 'boss', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (21, 'STORE', 'A1', 1, 'keypad', '2026-10-12T07:02:00Z', 'Steel Screws', 'SKU-0001', 1, 1, 2, 'ESP32 Device', 'hardware', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (22, 'RETRIEVE', 'A1', 1, 'keypad', '2026-10-12T07:02:00Z', 'Steel Screws', 'SKU-0001', 1, 2, 1, 'ESP32 Device', 'hardware', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (23, 'STORE', 'E5', 25, 'dashboard', '2026-10-12T07:02:00Z', 'Product E5', 'SKU-E5', 3, 0, 3, 'Test Boss', 'boss', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (24, 'RETRIEVE', 'E5', 25, 'dashboard', '2026-10-12T07:02:00Z', 'Product E5', 'SKU-E5', 3, 3, 0, 'Test Boss', 'boss', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (25, 'STORE', 'A1', 1, 'dashboard', '2026-10-12T07:34:23Z', 'Steel Screws', 'SKU-0001', 1, 1, 2, 'Test Boss', 'boss', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (26, 'RETRIEVE', 'A1', 1, 'dashboard', '2026-10-12T07:34:23Z', 'Steel Screws', 'SKU-0001', 1, 2, 1, 'Test Boss', 'boss', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (27, 'STORE', 'A1', 1, 'keypad', '2026-10-12T07:34:23Z', 'Steel Screws', 'SKU-0001', 1, 1, 2, 'ESP32 Device', 'hardware', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (28, 'RETRIEVE', 'A1', 1, 'keypad', '2026-10-12T07:34:23Z', 'Steel Screws', 'SKU-0001', 1, 2, 1, 'ESP32 Device', 'hardware', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (29, 'STORE', 'E5', 25, 'dashboard', '2026-10-12T07:34:23Z', 'Product E5', 'SKU-E5', 3, 0, 3, 'Test Boss', 'boss', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (30, 'RETRIEVE', 'E5', 25, 'dashboard', '2026-10-12T07:34:23Z', 'Product E5', 'SKU-E5', 3, 3, 0, 'Test Boss', 'boss', NULL);
INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES (31, 'STORE', 'A1', 1, 'dashboard', '2026-10-12T08:29:26Z', 'Steel Screws', 'SKU-0001', 9, 1, 10, 'Test Boss', 'boss', NULL);

-- Note: user_sessions table is intentionally initialized empty (sessions created via /auth/login)

-- ----------------------------------------------------------------------------
-- 4. SYNCHRONIZE POSTGRESQL SEQUENCES
-- ----------------------------------------------------------------------------
SELECT setval(pg_get_serial_sequence('users', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM users;
SELECT setval(pg_get_serial_sequence('transactions', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM transactions;
SELECT setval(pg_get_serial_sequence('otp_verifications', 'id'), 1, false);

-- ----------------------------------------------------------------------------
-- 5. POST-SEED SANITY VERIFICATION
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  w_cnt INT; u_cnt INT; r_cnt INT; s_cnt INT; sl_cnt INT; tx_cnt INT; ses_cnt INT;
BEGIN
  SELECT COUNT(*) INTO w_cnt FROM warehouse_config;
  SELECT COUNT(*) INTO u_cnt FROM users;
  SELECT COUNT(*) INTO r_cnt FROM rack_config;
  SELECT COUNT(*) INTO s_cnt FROM system_settings;
  SELECT COUNT(*) INTO sl_cnt FROM slots;
  SELECT COUNT(*) INTO tx_cnt FROM transactions;
  SELECT COUNT(*) INTO ses_cnt FROM user_sessions;

  IF w_cnt != 1 OR u_cnt != 0 OR r_cnt != 1 OR s_cnt != 0 OR sl_cnt != 16 OR tx_cnt != 31 OR ses_cnt != 0 THEN
    RAISE EXCEPTION 'POST-SEED SANITY CHECK FAILED: Row count mismatch (warehouse: %, users: %, rack: %, settings: %, slots: %, txs: %, sessions: %)',
      w_cnt, u_cnt, r_cnt, s_cnt, sl_cnt, tx_cnt, ses_cnt;
  END IF;
END $$;

COMMIT;
