const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

let sqliteDb = null;
let pgPool = null;
const isPg = Boolean(process.env.DATABASE_URL);

if (isPg) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
  });
} else {
  const Database = require('better-sqlite3');
  const dbPath = process.env.SQLITE_DB_PATH || path.join(__dirname, 'asrs.db');
  sqliteDb = new Database(dbPath);
  sqliteDb.pragma('journal_mode=WAL');
}

function toPgSql(sql) {
  let idx = 1;
  return sql.replace(/\?/g, () => `$${idx++}`);
}

async function query(sql, params = []) {
  if (isPg) {
    const res = await pgPool.query(toPgSql(sql), params);
    return res;
  } else {
    const stmt = sqliteDb.prepare(sql);
    if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
      return { rows: stmt.all(...params) };
    } else {
      const info = stmt.run(...params);
      return { rowCount: info.changes, lastInsertRowid: info.lastInsertRowid };
    }
  }
}

async function all(sql, params = []) {
  if (isPg) {
    const res = await pgPool.query(toPgSql(sql), params);
    return res.rows;
  } else {
    return sqliteDb.prepare(sql).all(...params);
  }
}

async function get(sql, params = []) {
  if (isPg) {
    const res = await pgPool.query(toPgSql(sql), params);
    return res.rows[0] || null;
  } else {
    return sqliteDb.prepare(sql).get(...params) || null;
  }
}

async function run(sql, params = []) {
  if (isPg) {
    const res = await pgPool.query(toPgSql(sql), params);
    return { changes: res.rowCount };
  } else {
    const info = sqliteDb.prepare(sql).run(...params);
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }
}

async function initDb() {
  if (isPg) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS warehouse_config (
        id INT PRIMARY KEY CHECK(id=1),
        warehouse_name TEXT NOT NULL,
        warehouse_code TEXT NOT NULL,
        location TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        user_id TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('boss','operator')),
        active INT NOT NULL DEFAULT 1,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS rack_config (
        id INT PRIMARY KEY CHECK(id=1),
        rows INT NOT NULL DEFAULT 4,
        cols INT NOT NULL DEFAULT 4,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS slots (
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
      CREATE TABLE IF NOT EXISTS transactions (
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
        role TEXT DEFAULT 'operator'
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS otp_verifications (
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
      CREATE INDEX IF NOT EXISTS idx_otp_identifier_purpose ON otp_verifications (identifier, purpose);
    `);

    // Additive migration helper for PostgreSQL existing users table
    await pgPool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS requested_role TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS effective_role TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_reason TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS organization TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS requested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP WITH TIME ZONE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_role TEXT;
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_id TEXT;
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS store_id TEXT NOT NULL DEFAULT 'store_default_001';
      ALTER TABLE slots ADD COLUMN IF NOT EXISTS store_id TEXT NOT NULL DEFAULT 'store_default_001';
      ALTER TABLE rack_config ADD COLUMN IF NOT EXISTS store_id TEXT NOT NULL DEFAULT 'store_default_001';

      CREATE TABLE IF NOT EXISTS stores (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        store_type TEXT NOT NULL DEFAULT 'warehouse',
        status TEXT NOT NULL DEFAULT 'active',
        owner_user_id TEXT,
        address TEXT,
        city TEXT,
        max_slots INT DEFAULT 50,
        subscription_plan TEXT DEFAULT 'starter',
        rack_rows INT NOT NULL DEFAULT 4,
        rack_cols INT NOT NULL DEFAULT 4,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS store_memberships (
        id SERIAL PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('store_owner', 'store_admin', 'operator')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated', 'pending')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (store_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS store_devices (
        id SERIAL PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        device_key TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

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

      CREATE INDEX IF NOT EXISTS idx_stores_code ON stores(code);
      CREATE INDEX IF NOT EXISTS idx_store_memberships_user ON store_memberships(user_id);
      CREATE INDEX IF NOT EXISTS idx_store_devices_key ON store_devices(device_key);
      CREATE INDEX IF NOT EXISTS idx_slots_store_id ON slots(store_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_store_id ON transactions(store_id);
    `);
  } else {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS warehouse_config (
        id INTEGER PRIMARY KEY CHECK(id=1),
        warehouse_name TEXT NOT NULL,
        warehouse_code TEXT NOT NULL,
        location TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
      CREATE TABLE IF NOT EXISTS rack_config (
        id INTEGER PRIMARY KEY CHECK(id=1),
        rows INTEGER NOT NULL DEFAULT 4,
        cols INTEGER NOT NULL DEFAULT 4,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
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
        role TEXT DEFAULT 'operator'
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
      CREATE INDEX IF NOT EXISTS idx_otp_identifier_purpose ON otp_verifications (identifier, purpose);
    `);

    // Additive migration helper for existing tables
    const hasCol = (t, c) => sqliteDb.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);
    const addCol = (t, c, sql) => { if (!hasCol(t, c)) sqliteDb.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${sql}`); };
    addCol('users', 'email', 'TEXT DEFAULT NULL');
    addCol('users', 'phone', 'TEXT DEFAULT NULL');
    addCol('users', 'email_verified', 'INTEGER DEFAULT 0');
    addCol('users', 'phone_verified', 'INTEGER DEFAULT 0');
    addCol('users', 'approval_status', "TEXT NOT NULL DEFAULT 'approved'");
    addCol('users', 'requested_role', 'TEXT DEFAULT NULL');
    addCol('users', 'effective_role', 'TEXT DEFAULT NULL');
    addCol('users', 'registration_reason', 'TEXT DEFAULT NULL');
    addCol('users', 'organization', 'TEXT DEFAULT NULL');
    addCol('users', 'employee_id', 'TEXT DEFAULT NULL');
    addCol('users', 'requested_at', 'TEXT DEFAULT NULL');
    addCol('users', 'reviewed_at', 'TEXT DEFAULT NULL');
    addCol('users', 'reviewed_by', 'TEXT DEFAULT NULL');
    addCol('users', 'rejection_reason', 'TEXT DEFAULT NULL');
    addCol('slots', 'quantity', 'INTEGER NOT NULL DEFAULT 1');
    addCol('slots', 'capacity', 'INTEGER NOT NULL DEFAULT 10');
    addCol('slots', 'item_name', "TEXT NOT NULL DEFAULT ''");
    addCol('slots', 'sku', "TEXT NOT NULL DEFAULT ''");
    addCol('transactions', 'item_name', "TEXT NOT NULL DEFAULT ''");
    addCol('transactions', 'sku', "TEXT NOT NULL DEFAULT ''");
    addCol('transactions', 'quantity', 'INTEGER NOT NULL DEFAULT 1');
    addCol('transactions', 'before_quantity', 'INTEGER NOT NULL DEFAULT 0');
    addCol('transactions', 'after_quantity', 'INTEGER NOT NULL DEFAULT 0');
    addCol('transactions', 'user_name', "TEXT DEFAULT 'System'");
    addCol('transactions', 'role', "TEXT DEFAULT 'operator'");
    addCol('transactions', 'user_id', 'TEXT DEFAULT NULL');
    addCol('transactions', 'store_id', "TEXT NOT NULL DEFAULT 'store_default_001'");
    addCol('users', 'platform_role', 'TEXT DEFAULT NULL');
    addCol('rack_config', 'store_id', "TEXT NOT NULL DEFAULT 'store_default_001'");

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS stores (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        store_type TEXT NOT NULL DEFAULT 'warehouse',
        status TEXT NOT NULL DEFAULT 'active',
        owner_user_id TEXT,
        address TEXT,
        city TEXT,
        max_slots INTEGER DEFAULT 50,
        subscription_plan TEXT DEFAULT 'starter',
        rack_rows INTEGER NOT NULL DEFAULT 4,
        rack_cols INTEGER NOT NULL DEFAULT 4,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS store_memberships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (store_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS store_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_id TEXT NOT NULL,
        device_key TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_id TEXT,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        details TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Ensure SQLite slots table supports composite PRIMARY KEY (store_id, slot) across multiple stores
    const slotsInfo = sqliteDb.prepare('PRAGMA table_info(slots)').all();
    const hasStoreIdInSlots = slotsInfo.some(x => x.name === 'store_id');
    const isCompositePk = slotsInfo.filter(x => x.pk > 0).length >= 2;
    if (!isCompositePk) {
      sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS slots_multi_tenant (
          store_id TEXT NOT NULL DEFAULT 'store_default_001',
          slot TEXT NOT NULL,
          item INTEGER,
          x INTEGER,
          y INTEGER,
          occupied INTEGER DEFAULT 1,
          quantity INTEGER NOT NULL DEFAULT 1,
          capacity INTEGER NOT NULL DEFAULT 10,
          item_name TEXT NOT NULL DEFAULT '',
          sku TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (store_id, slot)
        );
      `);
      if (hasStoreIdInSlots) {
        sqliteDb.exec(`
          INSERT OR IGNORE INTO slots_multi_tenant (store_id, slot, item, x, y, occupied, quantity, capacity, item_name, sku)
          SELECT COALESCE(store_id, 'store_default_001'), slot, item, x, y, occupied, quantity, capacity, item_name, sku FROM slots;
        `);
      } else {
        sqliteDb.exec(`
          INSERT OR IGNORE INTO slots_multi_tenant (store_id, slot, item, x, y, occupied, quantity, capacity, item_name, sku)
          SELECT 'store_default_001', slot, item, x, y, occupied, quantity, capacity, item_name, sku FROM slots;
        `);
      }
      sqliteDb.exec(`
        DROP TABLE slots;
        ALTER TABLE slots_multi_tenant RENAME TO slots;
      `);
    }
  }

  // Ensure default store exists (migrated from warehouse_config)
  const existingDefaultStore = await get("SELECT * FROM stores WHERE id = 'store_default_001'");
  if (!existingDefaultStore) {
    const warehouse = await get('SELECT * FROM warehouse_config WHERE id=1');
    await run(`
      INSERT INTO stores (id, name, code, slug, store_type, status, owner_user_id, city, rack_rows, rack_cols)
      VALUES (?, ?, ?, 'default-warehouse', 'warehouse', 'active', 'testboss', ?, 4, 4)
    `, [
      'store_default_001',
      warehouse?.warehouse_name || 'Main Warehouse',
      warehouse?.warehouse_code || 'WH-001',
      warehouse?.location || 'Nagpur'
    ]);
  }

  // Ensure testboss has platform_owner and store_owner in default store
  await run("UPDATE users SET platform_role = 'platform_owner' WHERE user_id = 'testboss' AND (platform_role IS NULL OR platform_role = '')");
  const testbossMember = await get("SELECT * FROM store_memberships WHERE store_id = 'store_default_001' AND user_id = 'testboss'");
  if (!testbossMember) {
    await run("INSERT INTO store_memberships (store_id, user_id, role, status) VALUES ('store_default_001', 'testboss', 'store_owner', 'active')");
  }

  // Backfill legacy active users into default store memberships (strictly only those with zero store memberships)
  const unassignedLegacyUsers = await all(`
    SELECT u.user_id, u.role, u.effective_role
    FROM users u
    WHERE u.active = 1
      AND NOT EXISTS (SELECT 1 FROM store_memberships m WHERE m.user_id = u.user_id)
  `);
  for (const u of unassignedLegacyUsers) {
    let mRole = 'operator';
    if (u.user_id === 'testboss' || u.role === 'boss' || u.effective_role === 'owner') mRole = 'store_owner';
    else if (u.effective_role === 'admin' || (u.role === 'boss' && u.effective_role === 'admin')) mRole = 'store_admin';
    await run("INSERT INTO store_memberships (store_id, user_id, role, status) VALUES ('store_default_001', ?, ?, 'active')", [u.user_id, mRole]);
  }

  // Ensure rack_config default exists
  const existingRack = await get('SELECT * FROM rack_config WHERE id=1');
  if (!existingRack) {
    await run('INSERT INTO rack_config (id, rows, cols) VALUES (1, 4, 4)');
  }

  // Ensure default hardware API key exists and is mapped to default store in store_devices
  const existingHwKey = await get("SELECT value FROM system_settings WHERE key='hardware_api_key'");
  let activeHwKey = existingHwKey?.value;
  if (!activeHwKey) {
    activeHwKey = process.env.HARDWARE_API_KEY || 'asrs_hw_' + crypto.randomBytes(16).toString('hex');
    await run('INSERT INTO system_settings (key, value) VALUES (?, ?)', ['hardware_api_key', activeHwKey]);
  }
  const existingDev = await get("SELECT * FROM store_devices WHERE device_key = ?", [activeHwKey]);
  if (!existingDev) {
    await run("INSERT INTO store_devices (store_id, device_key, device_name, status) VALUES ('store_default_001', ?, 'Main ESP32 Controller', 'active')", [activeHwKey]);
  }

  // Ensure slots, transactions and rack_config are backfilled with default store ID
  await run("UPDATE slots SET store_id = 'store_default_001' WHERE store_id IS NULL OR store_id = ''");
  await run("UPDATE transactions SET store_id = 'store_default_001' WHERE store_id IS NULL OR store_id = ''");
  await run("UPDATE rack_config SET store_id = 'store_default_001' WHERE store_id IS NULL OR store_id = ''");

  // Fix slot names if corrupted to Steel Screws (Bug 1 fix safely)
  const defaultCatalog = [
    'Steel Screws', 'Ball Bearings', 'Proximity Sensors', 'Cable Connectors',
    'Resistors', 'Capacitors', 'Integrated Circuits', 'Terminal Blocks',
    'Limit Switches', 'DC Motors', 'Relay Modules', 'LED Indicators',
    'Power Adapters', 'Mounting Brackets', 'Wire Spools', 'Spare Parts'
  ];
  const allCurrentSlots = await all("SELECT slot, item, item_name, sku, quantity FROM slots WHERE store_id = 'store_default_001' ORDER BY item");
  const allSameName = allCurrentSlots.length > 1 && allCurrentSlots.every(s => s.item_name === 'Steel Screws');
  if (allSameName) {
    for (const s of allCurrentSlots) {
      const idx = ((Number(s.item || 1) - 1) % defaultCatalog.length);
      const name = defaultCatalog[idx];
      const sku = `SKU-${String(s.item).padStart(4, '0')}`;
      await run("UPDATE slots SET item_name=?, sku=? WHERE store_id='store_default_001' AND slot=?", [name, sku, s.slot]);
    }
  }
}

module.exports = {
  isPg,
  query,
  all,
  get,
  run,
  initDb,
  pool: pgPool,
  sqlite: sqliteDb
};
