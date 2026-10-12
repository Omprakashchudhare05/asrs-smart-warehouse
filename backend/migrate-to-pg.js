/**
 * Safe Migration Script: SQLite (Local) -> Supabase PostgreSQL (Cloud)
 * 
 * Usage:
 *   node migrate-to-pg.js "postgresql://postgres:[YOUR-PASSWORD]@[HOST]:5432/postgres"
 * 
 * Safety:
 *   - Local SQLite database is strictly read-only and preserved untouched.
 *   - Verifies record count matching before and after migration.
 */

const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

async function migrate() {
  const targetUrl = process.argv[2] || process.env.TARGET_DATABASE_URL || process.env.DATABASE_URL;
  if (!targetUrl) {
    console.error('\n❌ ERROR: Supabase PostgreSQL Connection String missing!');
    console.error('Usage: node migrate-to-pg.js "<SUPABASE_DATABASE_URL>"\n');
    process.exit(1);
  }

  console.log('--- ASRS SAFE POSTGRESQL MIGRATION ---');
  console.log('1. Reading local SQLite database (read-only)...');
  const sqlite = new Database(path.join(__dirname, 'asrs.db'), { readonly: true });

  const warehouse = sqlite.prepare('SELECT * FROM warehouse_config').all();
  const users = sqlite.prepare('SELECT * FROM users').all();
  const rack = sqlite.prepare('SELECT * FROM rack_config').all();
  const settings = sqlite.prepare('SELECT * FROM system_settings').all();
  const slots = sqlite.prepare('SELECT * FROM slots').all();
  const transactions = sqlite.prepare('SELECT * FROM transactions').all();
  const sessions = sqlite.prepare('SELECT * FROM user_sessions').all();

  console.log(`   Found in SQLite:`);
  console.log(`   - Warehouse config: ${warehouse.length}`);
  console.log(`   - Users: ${users.length}`);
  console.log(`   - Rack config: ${rack.length}`);
  console.log(`   - Settings: ${settings.length}`);
  console.log(`   - Slots: ${slots.length}`);
  console.log(`   - Transactions: ${transactions.length}`);
  console.log(`   - Active sessions: ${sessions.length}`);

  console.log('\n2. Connecting to Supabase PostgreSQL...');
  const pool = new Pool({
    connectionString: targetUrl,
    ssl: { rejectUnauthorized: false }
  });

function toUtcIso(ts) {
  if (!ts) return null;
  const s = String(ts).trim();
  if (s.includes('Z') || s.includes('+')) return s;
  return s.replace(' ', 'T') + 'Z';
}

  const client = await pool.connect();
  try {
    console.log('   Checking target database state across all 7 target tables (zero overwrite guard)...');
    const allTargetTables = [
      'warehouse_config',
      'users',
      'rack_config',
      'system_settings',
      'slots',
      'transactions',
      'user_sessions'
    ];
    const existingTablesRes = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name = ANY($1)
    `, [allTargetTables]);

    if (existingTablesRes.rows.length > 0) {
      console.log(`   Found ${existingTablesRes.rows.length} existing tables in target public schema.`);
      for (const row of existingTablesRes.rows) {
        const countRes = await client.query(`SELECT COUNT(*) as n FROM "${row.table_name}"`);
        const rowCount = Number(countRes.rows[0].n);
        if (rowCount > 0) {
          throw new Error(`SAFETY STOP: Target Supabase table '${row.table_name}' already contains ${rowCount} rows! Migration safely aborted to prevent data overwrite.`);
        }
      }
    }

    console.log('   Target database verified safe/empty. Creating tables on PostgreSQL...');
    await client.query('BEGIN');

    await client.query(`
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
    `);

    console.log('3. Inserting records into PostgreSQL...');

    // Warehouse config
    for (const w of warehouse) {
      await client.query(
        `INSERT INTO warehouse_config (id, warehouse_name, warehouse_code, location, created_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET warehouse_name=$2, warehouse_code=$3, location=$4`,
        [w.id, w.warehouse_name, w.warehouse_code, w.location, toUtcIso(w.created_at)]
      );
    }

    // Users
    for (const u of users) {
      await client.query(
        `INSERT INTO users (id, user_id, password_hash, salt, display_name, role, active, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (user_id) DO NOTHING`,
        [u.id, u.user_id, u.password_hash, u.salt, u.display_name, u.role, u.active, toUtcIso(u.created_at)]
      );
    }

    // Rack config
    for (const r of rack) {
      await client.query(
        `INSERT INTO rack_config (id, rows, cols, updated_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET rows=$2, cols=$3`,
        [r.id, r.rows, r.cols, toUtcIso(r.updated_at)]
      );
    }

    // Settings
    for (const s of settings) {
      await client.query(
        `INSERT INTO system_settings (key, value)
         VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2`,
        [s.key, s.value]
      );
    }

    // Slots
    for (const s of slots) {
      await client.query(
        `INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (slot) DO UPDATE SET quantity=$6, capacity=$7, item_name=$8, sku=$9`,
        [s.slot, s.item, s.x, s.y, s.occupied, s.quantity, s.capacity, s.item_name, s.sku]
      );
    }

    // Transactions
    for (const t of transactions) {
      await client.query(
        `INSERT INTO transactions (id, action, slot, item, source, time, item_name, sku, quantity, before_quantity, after_quantity, user_name, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO NOTHING`,
        [t.id, t.action, t.slot, t.item, t.source, toUtcIso(t.time), t.item_name, t.sku, t.quantity, t.before_quantity, t.after_quantity, t.user_name, t.role]
      );
    }

    // Sessions
    for (const s of sessions) {
      await client.query(
        `INSERT INTO user_sessions (token, user_id, display_name, role, created_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (token) DO NOTHING`,
        [s.token, s.user_id, s.display_name, s.role, toUtcIso(s.created_at)]
      );
    }

    // Synchronize serial sequences in PostgreSQL (proper empty & non-empty table handling)
    await client.query(`SELECT setval(pg_get_serial_sequence('users', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM users`);
    await client.query(`SELECT setval(pg_get_serial_sequence('transactions', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM transactions`);

    await client.query('COMMIT');

    console.log('\n4. Verifying migrated counts in PostgreSQL:');
    const pgWarehouse = (await client.query('SELECT COUNT(*) as c FROM warehouse_config')).rows[0].c;
    const pgUsers = (await client.query('SELECT COUNT(*) as c FROM users')).rows[0].c;
    const pgRack = (await client.query('SELECT COUNT(*) as c FROM rack_config')).rows[0].c;
    const pgSettings = (await client.query('SELECT COUNT(*) as c FROM system_settings')).rows[0].c;
    const pgSlots = (await client.query('SELECT COUNT(*) as c FROM slots')).rows[0].c;
    const pgTxs = (await client.query('SELECT COUNT(*) as c FROM transactions')).rows[0].c;
    const pgSessions = (await client.query('SELECT COUNT(*) as c FROM user_sessions')).rows[0].c;
    console.log(`   - PostgreSQL Warehouse: ${pgWarehouse} (SQLite: ${warehouse.length})`);
    console.log(`   - PostgreSQL Users: ${pgUsers} (SQLite: ${users.length})`);
    console.log(`   - PostgreSQL Rack Config: ${pgRack} (SQLite: ${rack.length})`);
    console.log(`   - PostgreSQL Settings: ${pgSettings} (SQLite: ${settings.length})`);
    console.log(`   - PostgreSQL Slots: ${pgSlots} (SQLite: ${slots.length})`);
    console.log(`   - PostgreSQL Transactions: ${pgTxs} (SQLite: ${transactions.length})`);
    console.log(`   - PostgreSQL Sessions: ${pgSessions} (SQLite: ${sessions.length})`);

    const userSeqRes = await client.query(`SELECT last_value FROM pg_sequences WHERE sequencename = 'users_id_seq'`);
    const txSeqRes = await client.query(`SELECT last_value FROM pg_sequences WHERE sequencename = 'transactions_id_seq'`);
    if (userSeqRes.rows.length > 0) {
      console.log(`   - Sequence 'users_id_seq': last_value=${userSeqRes.rows[0].last_value}`);
    }
    if (txSeqRes.rows.length > 0) {
      console.log(`   - Sequence 'transactions_id_seq': last_value=${txSeqRes.rows[0].last_value}`);
    }

    if (
      Number(pgWarehouse) !== warehouse.length ||
      Number(pgUsers) !== users.length ||
      Number(pgRack) !== rack.length ||
      Number(pgSettings) !== settings.length ||
      Number(pgSlots) !== slots.length ||
      Number(pgTxs) !== transactions.length ||
      Number(pgSessions) !== sessions.length
    ) {
      throw new Error('Post-migration row count verification failed! Counts do not match source.');
    }

    console.log('\n✅ MIGRATION COMPLETED SUCCESSFULLY!');
    console.log('Your cloud Supabase database is now fully in sync with your local SQLite data.');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('\n❌ MIGRATION FAILED - Changes rolled back in PostgreSQL!');
    console.error('Error details:', err.message);
    console.error('Your local SQLite database is 100% safe and intact.\n');
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

migrate();
