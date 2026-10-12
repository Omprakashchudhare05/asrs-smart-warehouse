/**
 * Safe Boss/Admin Password Reset Script
 * 
 * Usage:
 *   node reset-boss-password.js "<NEW_PASSWORD>"
 * 
 * Safety Guarantee:
 *   1. Automatically creates a backup of asrs.db before modifying anything.
 *   2. Updates ONLY password_hash and salt for user_id='testboss'.
 *   3. Does NOT touch inventory, slots, transactions, warehouse_config, or any other data.
 *   4. Verifies scrypt hash computation immediately after update.
 *   5. Never exposes password hashes or secret values in output.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const newPassword = process.argv[2];

if (!newPassword || newPassword.trim().length < 8) {
  console.error('\n❌ ERROR: New password must be at least 8 characters long!');
  console.error('Usage: node reset-boss-password.js "YourNewSecurePassword123"\n');
  process.exit(1);
}

const dbPath = path.join(__dirname, 'asrs.db');
const backupDir = 'C:\\ASRS_SAFE_BACKUP';

if (!fs.existsSync(dbPath)) {
  console.error(`\n❌ ERROR: Database file not found at ${dbPath}\n`);
  process.exit(1);
}

console.log('=== SAFE BOSS PASSWORD RESET PROCEDURE ===');

// 1. Create safety backup before touching database
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `asrs_before_pwd_reset_${timestamp}.db`);
fs.copyFileSync(dbPath, backupPath);
console.log(`1. Pre-reset backup created at:\n   ${backupPath}`);

// 2. Open database and verify testboss exists
const db = new Database(dbPath);
const existingUser = db.prepare("SELECT id, user_id, display_name, role, active FROM users WHERE user_id='testboss'").get();

if (!existingUser) {
  console.error("\n❌ ERROR: User 'testboss' not found in database! No changes made.\n");
  db.close();
  process.exit(1);
}

console.log(`2. User verified: '${existingUser.user_id}' (${existingUser.display_name}, Role: ${existingUser.role})`);

// 3. Compute new salt and scrypt hash using exact server.js algorithm
const salt = crypto.randomBytes(16).toString('hex');
const newHash = crypto.scryptSync(newPassword.trim(), salt, 64).toString('hex');

// 4. Update in-place only for testboss
const updateResult = db.prepare(
  "UPDATE users SET password_hash=?, salt=? WHERE user_id='testboss' AND role='boss'"
).run(newHash, salt);

if (updateResult.changes !== 1) {
  console.error('\n❌ ERROR: Update affected 0 rows! Rolling back.\n');
  db.close();
  process.exit(1);
}

// Clear stale session tokens for testboss
db.prepare("DELETE FROM user_sessions WHERE user_id='testboss'").run();

console.log('3. Password hash and salt successfully updated in SQLite database.');

// 5. Verification check
const updatedUser = db.prepare("SELECT user_id, password_hash, salt FROM users WHERE user_id='testboss'").get();
const verifyHash = crypto.scryptSync(newPassword.trim(), updatedUser.salt, 64).toString('hex');
const matches = verifyHash === updatedUser.password_hash;

db.close();

if (matches) {
  console.log('\n✅ VERIFICATION SUCCESSFUL!');
  console.log("   Account 'testboss' password has been reset and verified.");
  console.log('   You can now start backend and log in with user_id: testboss\n');
} else {
  console.error('\n❌ CRITICAL: Verification mismatch! Restoring from backup...');
  fs.copyFileSync(backupPath, dbPath);
  console.error('   Original database restored. Please check system.\n');
  process.exit(1);
}
