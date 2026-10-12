/**
 * Read-Only Supabase Database Status Checker
 * 
 * Usage:
 *   node check-supabase-status.js "postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres"
 * 
 * Safety:
 *   - Strictly READ-ONLY.
 *   - Executes only SELECT queries against information_schema.
 *   - Zero tables created, modified, or dropped.
 */

const { Pool } = require('pg');

async function checkStatus() {
  const targetUrl = process.argv[2] || process.env.DATABASE_URL;
  if (!targetUrl) {
    console.error('\n❌ ERROR: Supabase connection string required!');
    console.error('Usage: node check-supabase-status.js "<SUPABASE_CONNECTION_STRING>"\n');
    process.exit(1);
  }

  console.log('=== SUPABASE READ-ONLY STATUS CHECK ===');
  console.log('Connecting to cloud PostgreSQL...');

  const pool = new Pool({
    connectionString: targetUrl,
    ssl: { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  try {
    // 1. Connection info
    const infoRes = await client.query('SELECT current_database() as db, current_user as usr, version() as ver');
    console.log(`Connected to database: ${infoRes.rows[0].db} as user: ${infoRes.rows[0].usr}`);
    console.log(`PostgreSQL version: ${infoRes.rows[0].ver.split(' ')[0]} ${infoRes.rows[0].ver.split(' ')[1]}`);

    // 2. Scan public schema tables
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);

    console.log(`\nPublic Schema Tables Found: ${tablesRes.rows.length}`);

    if (tablesRes.rows.length === 0) {
      console.log('✅ Target Supabase database is completely CLEAN & EMPTY.');
      console.log('   Ready for initial migration with zero risk of conflict or overwrite.');
    } else {
      console.log('Table details:');
      for (const row of tablesRes.rows) {
        const countRes = await client.query(`SELECT COUNT(*) as n FROM "${row.table_name}"`);
        console.log(`- ${row.table_name.padEnd(25)}: ${countRes.rows[0].n} rows`);
      }
    }
  } catch (err) {
    console.error('❌ Connection/Query Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

checkStatus();
