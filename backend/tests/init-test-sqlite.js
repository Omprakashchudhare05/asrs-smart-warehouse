// backend/tests/init-test-sqlite.js
// Safe baseline seeder for isolated temporary SQLite test databases
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function initTestSqlite(targetPath) {
  // 1. Strict test mode requirement
  if (process.env.NODE_ENV !== 'test') {
    throw new Error("initTestSqlite refused: execution is strictly restricted to test mode (NODE_ENV=test).");
  }

  // 2. Default target strictly to isolated test database, never live asrs.db
  const defaultTestPath = path.resolve(__dirname, 'asrs.test.db');
  const dbPath = path.resolve(targetPath || defaultTestPath);

  // 3. Resolve and validate target path boundaries
  const liveDbPath = path.resolve(__dirname, '../asrs.db');
  const backupDbPath = path.resolve(__dirname, '../asrs.backup.db');

  if (dbPath === liveDbPath || dbPath === backupDbPath || path.basename(dbPath) === 'asrs.db' || path.basename(dbPath) === 'asrs.backup.db') {
    throw new Error(`initTestSqlite refused: target path cannot be a primary or backup database (${dbPath}).`);
  }

  if (!dbPath.endsWith('.test.db') && !dbPath.endsWith('.test.sqlite')) {
    throw new Error(`initTestSqlite refused: target path must be an isolated test database ending with .test.db (${dbPath}).`);
  }

  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS warehouse_config (
      id INTEGER PRIMARY KEY CHECK(id=1),
      warehouse_name TEXT NOT NULL,
      warehouse_code TEXT NOT NULL,
      location TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR REPLACE INTO warehouse_config (id, warehouse_name, warehouse_code, location)
    VALUES (1, 'Test Warehouse', 'TEST-001', 'Nagpur');

    CREATE TABLE IF NOT EXISTS rack_config (
      id INTEGER PRIMARY KEY CHECK(id=1),
      rows INTEGER NOT NULL DEFAULT 4,
      cols INTEGER NOT NULL DEFAULT 4,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR REPLACE INTO rack_config (id, rows, cols)
    VALUES (1, 4, 4);

    CREATE TABLE IF NOT EXISTS slots (
      slot TEXT PRIMARY KEY,
      item INTEGER UNIQUE,
      x INTEGER,
      y INTEGER,
      occupied INTEGER DEFAULT 1,
      quantity INTEGER NOT NULL DEFAULT 1,
      capacity INTEGER NOT NULL DEFAULT 10,
      item_name TEXT NOT NULL DEFAULT '',
      sku TEXT NOT NULL DEFAULT ''
    );

    INSERT OR REPLACE INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku) VALUES
      ('A1', 1, 0, 0, 1, 10, 10, 'Steel Screws', 'SKU-0001'),
      ('A2', 2, 100, 0, 1, 1, 10, 'Ball Bearings', 'SKU-0002'),
      ('A3', 3, 200, 0, 1, 1, 10, 'Proximity Sensors', 'SKU-0003'),
      ('A4', 4, 300, 0, 1, 1, 10, 'Cable Connectors', 'SKU-0004'),
      ('B1', 5, 0, 100, 1, 1, 10, 'Resistors', 'SKU-0005'),
      ('B2', 6, 100, 100, 1, 1, 10, 'Capacitors', 'SKU-0006'),
      ('B3', 7, 200, 100, 1, 1, 10, 'Integrated Circuits', 'SKU-0007'),
      ('B4', 8, 300, 100, 1, 1, 10, 'Terminal Blocks', 'SKU-0008'),
      ('C1', 9, 0, 200, 1, 1, 10, 'Limit Switches', 'SKU-0009'),
      ('C2', 10, 100, 200, 1, 1, 10, 'DC Motors', 'SKU-0010'),
      ('C3', 11, 200, 200, 1, 1, 10, 'Relay Modules', 'SKU-0011'),
      ('C4', 12, 300, 200, 1, 1, 10, 'LED Indicators', 'SKU-0012'),
      ('D1', 13, 0, 300, 1, 1, 10, 'Power Adapters', 'SKU-0013'),
      ('D2', 14, 100, 300, 1, 1, 10, 'Mounting Brackets', 'SKU-0014'),
      ('D3', 15, 200, 300, 1, 1, 10, 'Wire Spools', 'SKU-0015'),
      ('D4', 16, 300, 300, 1, 1, 10, 'Spare Parts', 'SKU-0016');

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT,
      slot TEXT,
      item INTEGER,
      source TEXT,
      time TEXT DEFAULT CURRENT_TIMESTAMP,
      item_name TEXT NOT NULL DEFAULT '',
      sku TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL DEFAULT 1,
      before_quantity INTEGER NOT NULL DEFAULT 0,
      after_quantity INTEGER NOT NULL DEFAULT 0,
      user_name TEXT DEFAULT 'System',
      role TEXT DEFAULT 'operator',
      user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('boss','operator')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS otp_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      identifier TEXT NOT NULL,
      type TEXT NOT NULL,
      purpose TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      resend_count INTEGER NOT NULL DEFAULT 0,
      last_sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.close();
  return dbPath;
}

if (require.main === module) {
  process.env.NODE_ENV = 'test';
  const created = initTestSqlite();
  console.log(`Baseline test SQLite database initialized at ${created}.`);
}

module.exports = { initTestSqlite };
