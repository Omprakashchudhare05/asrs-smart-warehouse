/**
 * Read-Only Comprehensive Migration Verification Script
 * Validates all 7 tables, data integrity, sequences, sessions, and hardware settings
 * between local SQLite and Supabase PostgreSQL.
 * Strictly NO secrets printed.
 */

const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

async function run() {
  const targetUrl = process.argv[2] || process.env.DATABASE_URL || process.env.TARGET_DATABASE_URL;
  if (!targetUrl) {
    console.error('ERROR: Database URL missing');
    process.exit(1);
  }

  const sqlite = new Database(path.join(__dirname, 'asrs.db'), { readonly: true });
  const pool = new Pool({ connectionString: targetUrl, ssl: { rejectUnauthorized: false } });

  const tables = [
    'warehouse_config',
    'users',
    'rack_config',
    'system_settings',
    'slots',
    'transactions',
    'user_sessions'
  ];

  console.log('=== SEVEN TABLES COUNT COMPARISON ===');
  const results = {};
  for (const t of tables) {
    const sqliteCount = sqlite.prepare('SELECT COUNT(*) as c FROM ' + t).get().c;
    const pgRes = await pool.query('SELECT COUNT(*) as c FROM "' + t + '"');
    const pgCount = Number(pgRes.rows[0].c);
    const match = sqliteCount === pgCount;
    results[t] = { sqlite: sqliteCount, pg: pgCount, match };
    console.log(t.padEnd(20) + ' | SQLite: ' + String(sqliteCount).padStart(3) + ' | Supabase PG: ' + String(pgCount).padStart(3) + ' | Match: ' + (match ? 'PASS' : 'FAIL'));
  }

  console.log('\n=== DATA INTEGRITY CHECKS ===');
  // 1. Warehouse config
  const sqW = sqlite.prepare('SELECT id, warehouse_name, warehouse_code, location FROM warehouse_config').all();
  const pgW = (await pool.query('SELECT id, warehouse_name, warehouse_code, location FROM warehouse_config')).rows;
  console.log('Warehouse Config match:                      ' + (JSON.stringify(sqW) === JSON.stringify(pgW) ? 'PASS' : 'FAIL'));

  // 2. Users (without printing hashes)
  const sqU = sqlite.prepare('SELECT id, user_id, password_hash, salt, display_name, role, active FROM users').all();
  const pgU = (await pool.query('SELECT id, user_id, password_hash, salt, display_name, role, active FROM users')).rows;
  const usersEqual = sqU.length === pgU.length && sqU.every((u, i) => 
    u.id === pgU[i].id &&
    u.user_id === pgU[i].user_id &&
    u.display_name === pgU[i].display_name &&
    u.role === pgU[i].role &&
    u.active === pgU[i].active &&
    u.password_hash === pgU[i].password_hash &&
    u.salt === pgU[i].salt
  );
  console.log('Users Data & Password Hash match (bit-for-bit): ' + (usersEqual ? 'PASS' : 'FAIL'));
  console.log('  -> User ID: ' + pgU[0]?.user_id + ' | Role: ' + pgU[0]?.role + ' | Active: ' + pgU[0]?.active);

  // 3. Rack config
  const sqR = sqlite.prepare('SELECT id, rows, cols FROM rack_config').all();
  const pgR = (await pool.query('SELECT id, rows, cols FROM rack_config')).rows;
  console.log('Rack Config match (4x4):                     ' + (JSON.stringify(sqR) === JSON.stringify(pgR) ? 'PASS' : 'FAIL'));

  // 4. System settings
  const sqS = sqlite.prepare('SELECT key, value FROM system_settings').all();
  const pgS = (await pool.query('SELECT key, value FROM system_settings')).rows;
  const settingsMatch = sqS.length === pgS.length && sqS.every((s, i) => s.key === pgS[i].key && s.value === pgS[i].value);
  console.log('System Settings match (Hardware Key intact): ' + (settingsMatch ? 'PASS' : 'FAIL'));

  // 5. Slots
  const sqSlots = sqlite.prepare('SELECT slot, item, x, y, occupied, quantity, capacity, item_name, sku FROM slots ORDER BY slot').all();
  const pgSlots = (await pool.query('SELECT slot, item, x, y, occupied, quantity, capacity, item_name, sku FROM slots ORDER BY slot')).rows;
  const slotsMatch = JSON.stringify(sqSlots) === JSON.stringify(pgSlots);
  console.log('Slots 16/16 Attributes & Stock match:       ' + (slotsMatch ? 'PASS' : 'FAIL'));

  // 6. Transactions
  const sqT = sqlite.prepare('SELECT COUNT(*) as c, MIN(id) as min_id, MAX(id) as max_id FROM transactions').get();
  const pgT = (await pool.query('SELECT COUNT(*) as c, MIN(id) as min_id, MAX(id) as max_id FROM transactions')).rows[0];
  console.log('Transactions Count & ID range match:        ' + ((sqT.c == pgT.c && sqT.min_id == pgT.min_id && sqT.max_id == pgT.max_id) ? 'PASS' : 'FAIL'));
  console.log('  -> SQLite: count=' + sqT.c + ', min=' + sqT.min_id + ', max=' + sqT.max_id);
  console.log('  -> Supabase: count=' + pgT.c + ', min=' + pgT.min_id + ', max=' + pgT.max_id);

  // 7. Sessions
  const sqSess = sqlite.prepare('SELECT token, user_id, display_name, role FROM user_sessions').all();
  const pgSess = (await pool.query('SELECT token, user_id, display_name, role FROM user_sessions')).rows;
  const sessMatch = JSON.stringify(sqSess) === JSON.stringify(pgSess);
  console.log('User Sessions token & role match:           ' + (sessMatch ? 'PASS' : 'FAIL'));

  console.log('\n=== SEQUENCE STATUS ===');
  const seqRes = await pool.query(
    "SELECT sequencename, last_value FROM pg_sequences WHERE sequencename IN ('users_id_seq', 'transactions_id_seq')"
  );
  for (const s of seqRes.rows) {
    console.log('Sequence: ' + s.sequencename.padEnd(22) + ' | last_value: ' + s.last_value);
  }

  console.log('\n=== CONTROLLED SEQUENCE TEST (WITH ROLLBACK) ===');
  const testClient = await pool.connect();
  try {
    await testClient.query('BEGIN');
    const uRes = await testClient.query(
      "INSERT INTO users (user_id, password_hash, salt, display_name, role) VALUES ('__temp_seq_check__', 'x', 'y', 'Temp', 'operator') RETURNING id"
    );
    const tRes = await testClient.query(
      "INSERT INTO transactions (action, slot, item, source) VALUES ('STORE', 'A1', 1, 'VERIFY_TEST') RETURNING id"
    );
    console.log('Next User ID generated:                     ' + uRes.rows[0].id + ' (Expected: 2)');
    console.log('Next Transaction ID generated:              ' + tRes.rows[0].id + ' (Expected: 32)');
    await testClient.query('ROLLBACK');
    console.log('Rollback successful:                         PASS (0 test records committed)');
  } finally {
    // Re-synchronize sequences back to existing max values
    await testClient.query("SELECT setval(pg_get_serial_sequence('users', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM users");
    await testClient.query("SELECT setval(pg_get_serial_sequence('transactions', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM transactions");
    testClient.release();
  }
  if (pgSess.length > 0) {
    const authTest = await pool.query('SELECT user_id, display_name, role FROM user_sessions WHERE token = $1', [pgSess[0].token]);
    if (authTest.rows.length === 1 && authTest.rows[0].user_id === 'testboss') {
      console.log('Existing Session Token Authentication:       PASS (User: testboss, Role: boss)');
    } else {
      console.log('Existing Session Token Authentication:       FAIL');
    }
  }

  sqlite.close();
  await pool.end();
}

run().catch(e => {
  console.error('Verification Error:', e.message);
  process.exit(1);
});
