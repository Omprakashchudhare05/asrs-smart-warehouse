process.env.NODE_ENV = 'test';
const path = require('path');
const fs = require('fs');

const liveDbPath = path.join(__dirname, '../asrs.db');
const testDbPath = path.join(__dirname, 'asrs.test.db');
if (!process.env.DATABASE_URL) {
  if (fs.existsSync(liveDbPath)) {
    fs.copyFileSync(liveDbPath, testDbPath);
  } else {
    const { initTestSqlite } = require('./init-test-sqlite');
    initTestSqlite(testDbPath);
  }
  process.env.SQLITE_DB_PATH = testDbPath;
}

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const db = require('../db');
const { app } = require('../server');

let server;
let baseUrl;
let bossToken = '';
let operatorToken = '';
let adminToken = '';
let hardwareApiKey = '';

test.before(async () => {
  await db.initDb();
  await new Promise(resolve => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  const hwKeySetting = await db.get("SELECT value FROM system_settings WHERE key='hardware_api_key'");
  hardwareApiKey = hwKeySetting?.value || '';
});

test.after(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
  if (!process.env.DATABASE_URL) {
    if (db.sqlite) {
      try { db.sqlite.close(); } catch {}
    }
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
      if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
    } catch {}
  }
});

async function api(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(bossToken ? { Authorization: `Bearer ${bossToken}` } : {}),
      ...(options.headers || {})
    }
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

test('1. Health check returns OK and database type', async () => {
  const res = await api('/health');
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.ok(res.data.database);
});

test('2. Auth status reports warehouse and boss configuration', async () => {
  const res = await api('/auth/status');
  assert.equal(res.status, 200);
  assert.equal(res.data.setupRequired, false);
  assert.equal(res.data.warehouse.warehouse_name, 'Test Warehouse');
  assert.equal(res.data.rack.rows, 4);
  assert.equal(res.data.rack.cols, 4);
});

test('3. Login with testboss succeeds and returns persistent token', async () => {
  // Use boss account created during setup (or create temporary session)
  const u = await db.get("SELECT user_id FROM users WHERE role='boss'");
  assert.ok(u, 'Boss user should exist');

  // Verify DB session storage
  const crypto = require('crypto');
  const dummyToken = 'test_token_' + crypto.randomBytes(16).toString('hex');
  await db.run('INSERT INTO user_sessions (token, user_id, display_name, role) VALUES (?, ?, ?, ?)', [
    dummyToken,
    u.user_id,
    'Test Boss',
    'owner'
  ]);
  bossToken = dummyToken;

  // Setup approved test operator
  const opSalt = crypto.randomBytes(16).toString('hex');
  const opPassHash = crypto.scryptSync('OperatorPass123!', opSalt, 64).toString('hex');
  await db.run(`
    INSERT INTO users (user_id, password_hash, salt, display_name, role, active, approval_status, requested_role, effective_role)
    VALUES ('test_op', ?, ?, 'Test Operator', 'operator', 1, 'approved', 'operator', 'operator')
  `, [opPassHash, opSalt]);
  operatorToken = 'test_op_token_' + crypto.randomBytes(16).toString('hex');
  await db.run('INSERT INTO user_sessions (token, user_id, display_name, role) VALUES (?, ?, ?, ?)', [
    operatorToken,
    'test_op',
    'Test Operator',
    'operator'
  ]);
  await db.run("INSERT INTO store_memberships (store_id, user_id, role, status) VALUES ('store_default_001', 'test_op', 'operator', 'active')");

  // Setup approved test admin
  const admSalt = crypto.randomBytes(16).toString('hex');
  const admPassHash = crypto.scryptSync('AdminPass123!', admSalt, 64).toString('hex');
  await db.run(`
    INSERT INTO users (user_id, password_hash, salt, display_name, role, active, approval_status, requested_role, effective_role)
    VALUES ('test_admin', ?, ?, 'Test Admin', 'boss', 1, 'approved', 'admin', 'admin')
  `, [admPassHash, admSalt]);
  adminToken = 'test_admin_token_' + crypto.randomBytes(16).toString('hex');
  await db.run('INSERT INTO user_sessions (token, user_id, display_name, role) VALUES (?, ?, ?, ?)', [
    adminToken,
    'test_admin',
    'Test Admin',
    'admin'
  ]);
  await db.run("INSERT INTO store_memberships (store_id, user_id, role, status) VALUES ('store_default_001', 'test_admin', 'store_admin', 'active')");

  const summary = await api('/summary');
  assert.equal(summary.status, 200);
  assert.ok(summary.data.totalSlots >= 16);
});

test('4. Slot catalog integrity: all 16 slots have distinct product names and SKUs', async () => {
  const res = await api('/slots');
  assert.equal(res.status, 200);
  const slots = res.data;
  assert.ok(slots.length >= 16);

  const slotA1 = slots.find(s => s.slot === 'A1');
  const slotA2 = slots.find(s => s.slot === 'A2');
  assert.equal(slotA1.item_name, 'Steel Screws');
  assert.equal(slotA1.sku, 'SKU-0001');
  assert.equal(slotA2.item_name, 'Ball Bearings');
  assert.equal(slotA2.sku, 'SKU-0002');
  assert.notEqual(slotA1.item_name, slotA2.item_name);
});

test('5. Store and Retrieve operations validate inventory boundaries and enforce Operator role restriction', async () => {
  const allSlots = (await api('/slots')).data;
  const sBefore = allSlots.find(s => s.quantity < s.capacity) || allSlots[1];
  const targetSlot = sBefore.slot;
  const initialQty = sBefore.quantity;

  // Routine Store/Retrieve attempted by Boss/Owner MUST return 403
  const bossStore = await api('/store', {
    method: 'POST',
    body: JSON.stringify({ slot: targetSlot, quantity: 1, source: 'dashboard' })
  });
  assert.equal(bossStore.status, 403);
  assert.match(bossStore.data.error, /restricted to approved Operators only/i);

  // Routine Store/Retrieve attempted by Admin MUST return 403
  const adminStore = await api('/store', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ slot: targetSlot, quantity: 1, source: 'dashboard' })
  });
  assert.equal(adminStore.status, 403);
  assert.match(adminStore.data.error, /restricted to approved Operators only/i);

  // Store 1 unit as approved Operator succeeds
  const storeRes = await api('/store', {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ slot: targetSlot, quantity: 1, source: 'dashboard' })
  });
  assert.equal(storeRes.status, 200);
  assert.equal(storeRes.data.slot.quantity, initialQty + 1);

  // Retrieve 1 unit as approved Operator succeeds
  const retRes = await api('/retrieve', {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ slot: targetSlot, quantity: 1, source: 'dashboard' })
  });
  assert.equal(retRes.status, 200);
  assert.equal(retRes.data.slot.quantity, initialQty);

  // Attempt to retrieve excessive quantity
  const badRet = await api('/retrieve', {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ slot: targetSlot, quantity: 9999, source: 'dashboard' })
  });
  assert.equal(badRet.status, 400);
  assert.match(badRet.data.error, /Insufficient stock/i);
});

test('6. Hardware API authentication rejects unauthorized requests and allows valid API Key', async () => {
  const allSlots = (await api('/slots')).data;
  const sTarget = (allSlots.find(s => s.quantity < s.capacity) || allSlots[1]).slot;

  // Reject without key
  const noKey = await api('/api/hardware/store', {
    method: 'POST',
    body: JSON.stringify({ slot: sTarget, quantity: 1 })
  });
  assert.equal(noKey.status, 401);

  // Reject with invalid key
  const badKey = await api('/api/hardware/store', {
    method: 'POST',
    headers: { 'X-Hardware-Key': 'invalid_secret_key' },
    body: JSON.stringify({ slot: sTarget, quantity: 1 })
  });
  assert.equal(badKey.status, 401);

  // Allow with valid hardware key
  assert.ok(hardwareApiKey, 'Hardware key must exist');
  const validHw = await api('/api/hardware/store', {
    method: 'POST',
    headers: { 'X-Hardware-Key': hardwareApiKey },
    body: JSON.stringify({ slot: sTarget, quantity: 1, source: 'keypad' })
  });
  assert.equal(validHw.status, 200);
  assert.equal(validHw.data.ok, true);

  // Clean up
  await api('/api/hardware/retrieve', {
    method: 'POST',
    headers: { 'X-Hardware-Key': hardwareApiKey },
    body: JSON.stringify({ slot: sTarget, quantity: 1, source: 'keypad' })
  });
});

test('7. Dynamic Rack Configuration: Expand to 5x5 and Safe-Shrink Protection', async () => {
  // Expand to 5x5
  const expand = await api('/rack/dimensions', {
    method: 'PUT',
    body: JSON.stringify({ rows: 5, cols: 5 })
  });
  assert.equal(expand.status, 200);
  assert.equal(expand.data.rows, 5);
  assert.equal(expand.data.cols, 5);
  assert.equal(expand.data.totalSlots, 25);

  // Add stock to slot E5 (outside 4x4) via operator
  const storeE5 = await api('/store', {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ slot: 'E5', quantity: 3, source: 'dashboard' })
  });
  assert.equal(storeE5.status, 200);
  assert.equal(storeE5.data.slot.quantity, 3);

  // Attempt to shrink rack to 4x4 while E5 is occupied -> MUST FAIL
  const shrinkFail = await api('/rack/dimensions', {
    method: 'PUT',
    body: JSON.stringify({ rows: 4, cols: 4 })
  });
  assert.equal(shrinkFail.status, 400);
  assert.match(shrinkFail.data.error, /Cannot shrink rack/i);
  assert.match(shrinkFail.data.error, /E5/i);

  // Retrieve stock from E5 via operator
  await api('/retrieve', {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ slot: 'E5', quantity: 3, source: 'dashboard' })
  });

  // Now shrink to 4x4 -> MUST SUCCEED
  const shrinkOk = await api('/rack/dimensions', {
    method: 'PUT',
    body: JSON.stringify({ rows: 4, cols: 4 })
  });
  assert.equal(shrinkOk.status, 200);
  assert.equal(shrinkOk.data.rows, 4);
  assert.equal(shrinkOk.data.cols, 4);
  assert.equal(shrinkOk.data.totalSlots, 16);
});

test('8. Public admin registration is blocked when an active Boss exists (403)', async () => {
  const res = await api('/auth/setup-admin/request', {
    method: 'POST',
    body: JSON.stringify({
      userId: 'hacker_admin',
      password: 'HackerPassword123!',
      displayName: 'Unauthorized Admin',
      email: 'hacker@example.com',
      phone: '+919999999999',
      warehouseName: 'Fake Warehouse',
      warehouseCode: 'FAKE-01',
      location: 'Nowhere'
    })
  });
  assert.equal(res.status, 403);
  assert.match(res.data.error, /Public registration is disabled/i);
});

test('9. Admin profile update links verified email & phone to existing Boss', async () => {
  const res = await api('/auth/profile', {
    method: 'PUT',
    body: JSON.stringify({
      email: 'boss@asrs-warehouse.com',
      phone: '+919876543210',
      displayName: 'Main Warehouse Admin'
    })
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.user.email, 'boss@asrs-warehouse.com');
  assert.equal(res.data.user.phone, '+919876543210');

  // Verify in database
  const u = await db.get("SELECT email, phone FROM users WHERE user_id='testboss'");
  assert.equal(u.email, 'boss@asrs-warehouse.com');
  assert.equal(u.phone, '+919876543210');
});

test('10. Forgot Password: Request OTP with email, cooldown rate limiting, and secure hash in DB', async () => {
  const otpService = require('../otp-service');
  let capturedOtp = null;
  otpService.setTestOtpListener(({ otp, purpose }) => {
    if (purpose === 'forgot_password') capturedOtp = otp;
  });

  const req1 = await api('/auth/forgot-password/request', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'boss@asrs-warehouse.com' })
  });
  assert.equal(req1.status, 200);
  assert.equal(req1.data.ok, true);
  assert.ok(req1.data.destination, 'Masked destination must be returned');
  // Strict check: Plaintext OTP is NEVER returned in response
  assert.equal(req1.data.otp, undefined, 'Plaintext OTP must NEVER be leaked in response');
  assert.ok(capturedOtp, 'OTP must have been generated and dispatched');

  // Verify OTP is hashed in DB and plaintext is NOT in DB
  const dbOtp = await db.get("SELECT otp_hash FROM otp_verifications WHERE user_id='testboss' AND purpose='forgot_password'");
  assert.ok(dbOtp, 'OTP record must exist in DB');
  assert.notEqual(dbOtp.otp_hash, capturedOtp, 'DB must store HASH, never plaintext OTP');
  assert.equal(otpService.verifyOtpHash(capturedOtp, dbOtp.otp_hash), true, 'Hash must match timing-safe comparison');

  // Rate limiting cooldown: Immediate 2nd request must be rejected (429)
  const req2 = await api('/auth/forgot-password/request', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'boss@asrs-warehouse.com' })
  });
  assert.equal(req2.status, 429);
  assert.match(req2.data.error, /Please wait/i);
});

test('11. Forgot Password Security: Wrong OTP decrements attempts and expired OTP is rejected', async () => {
  // Test wrong OTP
  const badRes = await api('/auth/forgot-password/reset', {
    method: 'POST',
    body: JSON.stringify({
      identifier: 'boss@asrs-warehouse.com',
      otp: '000000',
      newPassword: 'BrandNewPassword123'
    })
  });
  assert.equal(badRes.status, 400);
  assert.match(badRes.data.error, /Invalid verification code/i);

  // Check attempts incremented in DB
  const dbOtp = await db.get("SELECT attempts FROM otp_verifications WHERE user_id='testboss' AND purpose='forgot_password'");
  assert.equal(dbOtp.attempts, 1);

  // Test expired OTP: temporarily set expires_at in the past
  await db.run("UPDATE otp_verifications SET expires_at='2020-01-01T00:00:00.000Z' WHERE user_id='testboss'");
  const expiredRes = await api('/auth/forgot-password/reset', {
    method: 'POST',
    body: JSON.stringify({
      identifier: 'boss@asrs-warehouse.com',
      otp: '123456',
      newPassword: 'BrandNewPassword123'
    })
  });
  assert.equal(expiredRes.status, 400);
  assert.match(expiredRes.data.error, /expired/i);
});

test('12. Forgot Password Reset: Validates new password, invalidates ALL sessions, and allows login', async () => {
  const otpService = require('../otp-service');
  let freshOtp = null;
  otpService.setTestOtpListener(({ otp, purpose }) => {
    if (purpose === 'forgot_password') freshOtp = otp;
  });

  // Clear previous OTP to bypass cooldown in test
  await db.run("DELETE FROM otp_verifications WHERE user_id='testboss'");

  // Ensure an active session exists before reset
  await db.run("INSERT INTO user_sessions (token, user_id, display_name, role) VALUES ('active_pre_reset_token', 'testboss', 'Boss', 'boss')");
  const sessionsBefore = await db.all("SELECT * FROM user_sessions WHERE user_id='testboss'");
  assert.ok(sessionsBefore.length >= 1, 'Active session should exist prior to reset');

  // Request fresh OTP
  await api('/auth/forgot-password/request', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'testboss' })
  });
  assert.ok(freshOtp, 'Fresh OTP generated');

  // Reset password
  const newPass = 'UpdatedSecurePass2026!';
  const resetRes = await api('/auth/forgot-password/reset', {
    method: 'POST',
    body: JSON.stringify({
      identifier: 'testboss',
      otp: freshOtp,
      newPassword: newPass
    })
  });
  assert.equal(resetRes.status, 200);
  assert.equal(resetRes.data.ok, true);

  // CRITICAL CHECK: All sessions for testboss MUST be deleted
  const sessionsAfter = await db.all("SELECT * FROM user_sessions WHERE user_id='testboss'");
  assert.equal(sessionsAfter.length, 0, 'ALL active sessions must be invalidated upon password reset');

  // Verify login with OLD password fails (401)
  const oldLogin = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ userId: 'testboss', password: 'old_wrong_password' })
  });
  assert.equal(oldLogin.status, 401);

  // Verify login with NEW password succeeds (200)
  const newLogin = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ userId: 'testboss', password: newPass })
  });
  assert.equal(newLogin.status, 200);
  assert.equal(newLogin.data.ok, true);
  assert.ok(newLogin.data.token, 'New session token must be issued');
  bossToken = newLogin.data.token; // Update bossToken for subsequent test requests
});

test('13. First-Time Setup Admin with Email & Phone OTP verification (Simulated on clean state)', async () => {
  const otpService = require('../otp-service');
  const capturedOtps = {};
  otpService.setTestOtpListener(({ type, otp, purpose }) => {
    if (purpose === 'admin_registration') capturedOtps[type] = otp;
  });

  // Temporarily deactivate boss accounts to simulate first-time warehouse setup
  await db.run("UPDATE users SET active=0 WHERE role='boss'");

  try {
    // Step 1: Request Registration OTPs
    const regReq = await api('/auth/setup-admin/request', {
      method: 'POST',
      body: JSON.stringify({
        userId: 'new_warehouse_boss',
        password: 'StrongBossPassword999!',
        displayName: 'First Time Boss',
        email: 'newboss@warehouse.com',
        phone: '+919876543211',
        warehouseName: 'Central Logistics Hub',
        warehouseCode: 'HUB-001',
        location: 'Pune'
      })
    });
    assert.equal(regReq.status, 200);
    assert.equal(regReq.data.ok, true);
    assert.equal(regReq.data.step, 'verify_otp');
    assert.ok(capturedOtps.email, 'Email OTP generated');
    assert.ok(capturedOtps.phone, 'Mobile OTP generated');

    // Verify user is staged as INACTIVE (active = 0)
    const staged = await db.get("SELECT active, email_verified, phone_verified FROM users WHERE user_id='new_warehouse_boss'");
    assert.equal(staged.active, 0, 'Admin must remain inactive until OTP verification');

    // Step 2: Verify with correct OTPs
    const verifyRes = await api('/auth/setup-admin/verify', {
      method: 'POST',
      body: JSON.stringify({
        userId: 'new_warehouse_boss',
        emailOtp: capturedOtps.email,
        phoneOtp: capturedOtps.phone
      })
    });
    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.data.ok, true);
    assert.ok(verifyRes.data.token, 'Session token issued');

    // Verify user is now ACTIVE (active = 1, email_verified = 1, phone_verified = 1)
    const activeUser = await db.get("SELECT active, email_verified, phone_verified FROM users WHERE user_id='new_warehouse_boss'");
    assert.equal(activeUser.active, 1);
    assert.equal(activeUser.email_verified, 1);
    assert.equal(activeUser.phone_verified, 1);
  } finally {
    // Clean up simulated user & restore testboss & test_admin
    await db.run("DELETE FROM users WHERE user_id='new_warehouse_boss'");
    await db.run("DELETE FROM otp_verifications WHERE user_id='new_warehouse_boss'");
    await db.run("UPDATE users SET active=1 WHERE user_id='testboss' OR user_id='test_admin'");
    // Ensure bossToken session exists
    const crypto = require('crypto');
    const existingSession = await db.get("SELECT * FROM user_sessions WHERE token = ?", [bossToken]);
    if (!existingSession) {
      bossToken = 'test_token_' + crypto.randomBytes(16).toString('hex');
      await db.run("INSERT INTO user_sessions (token, user_id, display_name, role) VALUES (?, 'testboss', 'Test Boss', 'owner')", [bossToken]);
    }
  }
});

test('14. Concurrency Protection: Double-clicks and simultaneous movements prevent negative stock and capacity overflow', async () => {
  // Setup slot A1 with exact known stock = 4, capacity = 10
  await db.run("UPDATE slots SET quantity = 4, occupied = 1, capacity = 10 WHERE slot = 'A1'");

  // 1. Race condition test: 5 concurrent retrievals of 2 units each (total requested = 10 units, available = 4)
  const retrievePromises = Array.from({ length: 5 }, () =>
    api('/retrieve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ slot: 'A1', quantity: 2, source: 'concurrency_test' })
    })
  );

  const retrieveResults = await Promise.all(retrievePromises);
  const successRetrievals = retrieveResults.filter(r => r.status === 200 && r.data.ok === true);
  const rejectedRetrievals = retrieveResults.filter(r => r.status === 400 && r.data.error?.includes('Insufficient stock'));

  // Exactly 2 requests must succeed (2 * 2 = 4 units retrieved), exactly 3 must be safely rejected
  assert.equal(successRetrievals.length, 2, 'Exactly 2 retrievals should succeed');
  assert.equal(rejectedRetrievals.length, 3, 'Remaining 3 concurrent retrievals must be safely rejected');

  // Verify DB state: Stock must be exactly 0, never negative!
  const slotAfterRetrieve = await db.get("SELECT quantity, occupied FROM slots WHERE slot = 'A1'");
  assert.equal(slotAfterRetrieve.quantity, 0, 'Slot stock must be exactly 0');
  assert.equal(slotAfterRetrieve.occupied, 0, 'Occupied must be 0 when stock is 0');

  // 2. Race condition test: 5 concurrent store requests of 4 units each (total addition = 20 units, capacity = 10)
  const storePromises = Array.from({ length: 5 }, () =>
    api('/store', {
      method: 'POST',
      headers: { Authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ slot: 'A1', quantity: 4, source: 'concurrency_test' })
    })
  );

  const storeResults = await Promise.all(storePromises);
  const successStores = storeResults.filter(r => r.status === 200 && r.data.ok === true);
  const rejectedStores = storeResults.filter(r => r.status === 400 && r.data.error?.includes('capacity exceeded'));

  // Exactly 2 store requests must succeed (2 * 4 = 8 units stored, 8 + 4 would be 12 > 10)
  assert.equal(successStores.length, 2, 'Exactly 2 store requests should succeed');
  assert.equal(rejectedStores.length, 3, 'Remaining 3 store requests must be rejected to prevent capacity overflow');

  // Verify DB state: Stock must be exactly 8, never exceeding capacity of 10!
  const slotAfterStore = await db.get("SELECT quantity, occupied FROM slots WHERE slot = 'A1'");
  assert.equal(slotAfterStore.quantity, 8, 'Slot stock must be exactly 8');
  assert.equal(slotAfterStore.occupied, 1, 'Occupied must be 1');
});

test('15. Admin Profile OTP Verification: Existing admin securely verifies email & phone via OTP', async () => {
  const otpService = require('../otp-service');
  let capturedEmailOtp = null;
  let capturedPhoneOtp = null;
  otpService.setTestOtpListener(({ type, otp, purpose }) => {
    if (purpose === 'profile_verification') {
      if (type === 'email') capturedEmailOtp = otp;
      if (type === 'phone') capturedPhoneOtp = otp;
    }
  });

  // Step 1: Request Email OTP for logged-in boss
  const reqEmail = await api('/auth/profile/request-otp', {
    method: 'POST',
    body: JSON.stringify({ channel: 'email' })
  });
  assert.equal(reqEmail.status, 200);
  assert.equal(reqEmail.data.ok, true);
  assert.ok(capturedEmailOtp, 'Email OTP generated for profile verification');

  // Verify invalid OTP is rejected
  const badVerify = await api('/auth/profile/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ channel: 'email', otp: '000000' })
  });
  assert.equal(badVerify.status, 400);

  // Step 2: Verify with correct Email OTP
  const goodVerify = await api('/auth/profile/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ channel: 'email', otp: capturedEmailOtp })
  });
  assert.equal(goodVerify.status, 200);
  assert.equal(goodVerify.data.ok, true);
  assert.equal(goodVerify.data.user.email_verified, 1);

  // Step 3: Request & Verify Mobile Phone OTP
  const reqPhone = await api('/auth/profile/request-otp', {
    method: 'POST',
    body: JSON.stringify({ channel: 'phone' })
  });
  assert.equal(reqPhone.status, 200);
  assert.equal(reqPhone.data.ok, true);
  assert.ok(capturedPhoneOtp, 'Mobile OTP generated for profile verification');

  const goodPhoneVerify = await api('/auth/profile/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ channel: 'phone', otp: capturedPhoneOtp })
  });
  assert.equal(goodPhoneVerify.status, 200);
  assert.equal(goodPhoneVerify.data.ok, true);
  assert.equal(goodPhoneVerify.data.user.phone_verified, 1);

  // Step 4: Changing email resets email_verified to 0
  const changeRes = await api('/auth/profile', {
    method: 'PUT',
    body: JSON.stringify({ email: 'newaddress@asrs-warehouse.com', phone: '+919876543210', displayName: 'Updated Boss' })
  });
  assert.equal(changeRes.status, 200);
  assert.equal(changeRes.data.user.email_verified, 0, 'Editing contact must un-verify until new OTP confirmed');
  assert.equal(changeRes.data.user.phone_verified, 1, 'Unmodified contact retains verified status');
});

test('16. Operator Role Boundaries: Operator cannot access Admin/Owner endpoints', async () => {
  // 1. Operator cannot resize rack (Owner only) -> 403
  const rackRes = await api('/rack/dimensions', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ rows: 4, cols: 4 })
  });
  assert.equal(rackRes.status, 403);

  // 2. Operator cannot edit slot capacity (Owner only) -> 403
  const capRes = await api('/slots/A1/capacity', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ capacity: 20 })
  });
  assert.equal(capRes.status, 403);

  // 3. Operator cannot edit product name/SKU (Admin/Owner only) -> 403
  const prodRes = await api('/slots/A1/product', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ item_name: 'Hacked Product', sku: 'HACK-01' })
  });
  assert.equal(prodRes.status, 403);

  // 4. Operator cannot view or manage hardware key (Owner only) -> 403
  const hwRes = await api('/hardware/key', {
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  assert.equal(hwRes.status, 403);

  // 5. Operator cannot view user list (Admin/Owner only) -> 403
  const usersRes = await api('/users', {
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  assert.equal(usersRes.status, 403);

  // 6. Operator cannot access approval queues -> 403
  const adminQueueRes = await api('/api/owner/pending-admins', {
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  assert.equal(adminQueueRes.status, 403);

  const opQueueRes = await api('/api/admin/pending-operators', {
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  assert.equal(opQueueRes.status, 403);
});

test('17. Admin Role Boundaries: Admin can manage operators and product metadata, but cannot access Owner-only endpoints', async () => {
  // 1. Admin CAN update product metadata
  const prodOk = await api('/slots/A2/product', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ item_name: 'Precision Ball Bearings', sku: 'SKU-0002-MOD' })
  });
  assert.equal(prodOk.status, 200);
  assert.equal(prodOk.data.slot.item_name, 'Precision Ball Bearings');

  // 2. Admin CANNOT access Owner-only rack configuration -> 403
  const rackRes = await api('/rack/dimensions', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ rows: 4, cols: 4 })
  });
  assert.equal(rackRes.status, 403);

  // 3. Admin CANNOT update slot capacity -> 403
  const capRes = await api('/slots/A2/capacity', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ capacity: 50 })
  });
  assert.equal(capRes.status, 403);

  // 4. Admin CANNOT manage hardware key -> 403
  const hwRes = await api('/hardware/key', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(hwRes.status, 403);

  // 5. Admin CANNOT view or approve pending Admins -> 403
  const pendingAdmins = await api('/api/owner/pending-admins', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(pendingAdmins.status, 403);

  // 6. Admin CAN view pending operators
  const pendingOps = await api('/api/admin/pending-operators', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(pendingOps.status, 200);
  assert.equal(pendingOps.data.ok, true);
});

test('18. Operator Registration & Admin Approval Lifecycle', async () => {
  // 1. Public Operator registration request
  const regRes = await api('/auth/register/operator', {
    method: 'POST',
    body: JSON.stringify({
      userId: 'new_operator_bob',
      password: 'OperatorPass456!',
      displayName: 'Bob Operator',
      email: 'bob@warehouse.com',
      employeeId: 'EMP-101',
      registrationReason: 'Night shift picker'
    })
  });
  assert.equal(regRes.status, 200);
  assert.equal(regRes.data.ok, true);

  // Prevent duplicate registration
  const dupRes = await api('/auth/register/operator', {
    method: 'POST',
    body: JSON.stringify({
      userId: 'new_operator_bob',
      password: 'OperatorPass456!',
      displayName: 'Bob Operator'
    })
  });
  assert.equal(dupRes.status, 400);

  // 2. Pending operator CANNOT login -> 403
  const loginPending = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      userId: 'new_operator_bob',
      password: 'OperatorPass456!'
    })
  });
  assert.equal(loginPending.status, 403);
  assert.match(loginPending.data.error, /pending administrator approval/i);

  // 3. Admin views pending operator queue
  const queueRes = await api('/api/admin/pending-operators', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(queueRes.status, 200);
  const targetReq = queueRes.data.requests.find(r => r.user_id === 'new_operator_bob');
  assert.ok(targetReq, 'Pending operator should appear in queue');
  assert.equal(targetReq.employee_id, 'EMP-101');

  // 4. Admin approves the operator
  const approveRes = await api(`/api/admin/operators/${targetReq.id}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.data.ok, true);

  // 5. Approved operator CAN now login
  const loginOk = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      userId: 'new_operator_bob',
      password: 'OperatorPass456!'
    })
  });
  assert.equal(loginOk.status, 200);
  assert.equal(loginOk.data.user.role, 'operator');
  assert.equal(loginOk.data.user.approvalStatus, 'approved');
  const bobToken = loginOk.data.token;

  // 6. Approved operator can store/retrieve
  const bobStore = await api('/store', {
    method: 'POST',
    headers: { Authorization: `Bearer ${bobToken}` },
    body: JSON.stringify({ slot: 'A1', quantity: 1, source: 'dashboard' })
  });
  assert.equal(bobStore.status, 200);

  await api('/retrieve', {
    method: 'POST',
    headers: { Authorization: `Bearer ${bobToken}` },
    body: JSON.stringify({ slot: 'A1', quantity: 1, source: 'dashboard' })
  });
});

test('19. Admin Registration & Owner-Only Approval Lifecycle', async () => {
  // 1. Public Admin registration request
  const regRes = await api('/auth/register/admin', {
    method: 'POST',
    body: JSON.stringify({
      userId: 'candidate_admin_alice',
      password: 'AdminSecurePass789!',
      displayName: 'Alice Manager',
      email: 'alice@warehouse.com',
      phone: '+919876543299',
      organization: 'Logistics Operations',
      registrationReason: 'Lead shift supervisor'
    })
  });
  assert.equal(regRes.status, 200);
  assert.equal(regRes.data.ok, true);

  // 2. Pending admin CANNOT login -> 403
  const loginPending = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      userId: 'candidate_admin_alice',
      password: 'AdminSecurePass789!'
    })
  });
  assert.equal(loginPending.status, 403);
  assert.match(loginPending.data.error, /pending administrator approval/i);

  // 3. Other Admin CANNOT approve candidate admin -> 403
  const queueRes = await api('/api/owner/pending-admins', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(queueRes.status, 403);

  // 4. Owner views pending admin queue
  const ownerQueueRes = await api('/api/owner/pending-admins', {
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(ownerQueueRes.status, 200);
  const targetReq = ownerQueueRes.data.requests.find(r => r.user_id === 'candidate_admin_alice');
  assert.ok(targetReq, 'Pending admin request must exist in owner queue');
  assert.equal(targetReq.organization, 'Logistics Operations');

  // 5. Admin attempts to approve -> 403
  const adminAttemptApprove = await api(`/api/owner/admins/${targetReq.id}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(adminAttemptApprove.status, 403);

  // 6. Owner approves candidate admin
  const ownerApprove = await api(`/api/owner/admins/${targetReq.id}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(ownerApprove.status, 200);

  // 7. Approved admin CAN now login with admin role
  const loginOk = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      userId: 'candidate_admin_alice',
      password: 'AdminSecurePass789!'
    })
  });
  assert.equal(loginOk.status, 200);
  assert.equal(loginOk.data.user.role, 'admin');
  assert.equal(loginOk.data.user.approvalStatus, 'approved');
});

test('20. Real-time Session Revocation on Account Deactivation or Rejection', async () => {
  // Create an approved operator with active session
  const crypto = require('crypto');
  const tempToken = 'active_session_token_' + crypto.randomBytes(16).toString('hex');
  await db.run(`
    INSERT INTO users (user_id, password_hash, salt, display_name, role, active, approval_status, requested_role, effective_role)
    VALUES ('revocable_user', 'hash', 'salt', 'Revocable User', 'operator', 1, 'approved', 'operator', 'operator')
  `);
  await db.run(`
    INSERT INTO user_sessions (token, user_id, display_name, role)
    VALUES (?, 'revocable_user', 'Revocable User', 'operator')
  `, [tempToken]);
  await db.run("INSERT INTO store_memberships (store_id, user_id, role, status) VALUES ('store_default_001', 'revocable_user', 'operator', 'active')");

  // Session works before deactivation
  const checkBefore = await api('/slots', {
    headers: { Authorization: `Bearer ${tempToken}` }
  });
  assert.equal(checkBefore.status, 200);

  // Admin deactivates the user via PATCH /users/:id
  const targetUser = await db.get("SELECT id FROM users WHERE user_id = 'revocable_user'");
  const deactRes = await api(`/users/${targetUser.id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ active: false })
  });
  assert.equal(deactRes.status, 200);

  // Existing session token MUST immediately return 401 or 403 and be purged
  const checkAfter = await api('/slots', {
    headers: { Authorization: `Bearer ${tempToken}` }
  });
  assert.ok(checkAfter.status === 401 || checkAfter.status === 403, 'Session must be immediately rejected');

  // Verify session removed from database
  const sessionInDb = await db.get("SELECT * FROM user_sessions WHERE token = ?", [tempToken]);
  assert.equal(sessionInDb, null, 'Revoked session token must be purged from user_sessions table');
});

test('21. Transaction Privacy and Server-Derived Attribution', async () => {
  // 1. Perform movement as test_op (slot A1)
  const opMove = await api('/store', {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({
      slot: 'A1',
      quantity: 1,
      // Attempt to spoof actor and role in body
      user_name: 'SuperHacker',
      role: 'owner',
      user_id: 'testboss'
    })
  });
  assert.equal(opMove.status, 200);

  // 2. Query transactions as Operator: operator must ONLY see transactions matching user_id = test_op
  const opTxs = await api('/transactions', {
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  assert.equal(opTxs.status, 200);
  assert.ok(opTxs.data.length >= 1);
  for (const tx of opTxs.data) {
    assert.equal(tx.user_id, 'test_op', 'Operator must only see their own transactions');
  }

  // 3. Verify server-derived attribution in DB: spoofed body fields must be completely ignored
  const latestTx = await db.get("SELECT * FROM transactions WHERE slot = 'A1' ORDER BY id DESC LIMIT 1");
  assert.equal(latestTx.user_id, 'test_op', 'Transaction user_id must be derived from server session');
  assert.equal(latestTx.user_name, 'Test Operator', 'User display name must be derived from session');
  assert.equal(latestTx.role, 'operator', 'Role must be derived from session');

  // 4. Query transactions as Admin & Owner: receives warehouse-wide transactions
  const bossTxs = await api('/transactions', {
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(bossTxs.status, 200);
  assert.ok(bossTxs.data.length >= opTxs.data.length);

  // Clean up stock in A1
  await api('/retrieve', {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ slot: 'A1', quantity: 1 })
  });
});

test('22. Universal Forgot Password works for approved Operators and invalidates sessions', async () => {
  const otpService = require('../otp-service');
  let capturedOpOtp = null;
  otpService.setTestOtpListener(({ otp, purpose }) => {
    if (purpose === 'forgot_password') capturedOpOtp = otp;
  });

  // Link email to test_op
  await db.run("UPDATE users SET email = 'operator@asrs-warehouse.com', email_verified = 1 WHERE user_id = 'test_op'");

  // 1. Request password reset
  const reqRes = await api('/auth/forgot-password/request', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'operator@asrs-warehouse.com' })
  });
  assert.equal(reqRes.status, 200);
  assert.ok(capturedOpOtp, 'OTP dispatched for operator');

  // 2. Reset password
  const newOpPass = 'NewOperatorPass999!';
  const resetRes = await api('/auth/forgot-password/reset', {
    method: 'POST',
    body: JSON.stringify({
      identifier: 'test_op',
      otp: capturedOpOtp,
      newPassword: newOpPass
    })
  });
  assert.equal(resetRes.status, 200);

  // 3. Prior operator session must be invalidated
  const oldSessionCheck = await api('/slots', {
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  assert.equal(oldSessionCheck.status, 401);

  // 4. Login with new password succeeds
  const loginRes = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ userId: 'test_op', password: newOpPass })
  });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.data.user.role, 'operator');
  operatorToken = loginRes.data.token;
});

test('23. Owner Admin Management lifecycle, deactivation, and immediate session invalidation', async () => {
  // 1. Owner can view approved admins
  const adminsRes = await api('/api/owner/admins', {
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(adminsRes.status, 200);
  assert.ok(Array.isArray(adminsRes.data.admins));
  const foundAdmin = adminsRes.data.admins.find(a => a.userId === 'test_admin');
  assert.ok(foundAdmin, 'test_admin must appear in approved admins list');
  assert.equal(foundAdmin.role, 'admin');
  assert.equal(foundAdmin.active, 1);

  // 2. Admin or Operator cannot access Owner Admin Management
  const adminForbidden = await api('/api/owner/admins', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(adminForbidden.status, 403);
  const opForbidden = await api('/api/owner/admins', {
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  assert.equal(opForbidden.status, 403);

  // 3. Owner deactivates Admin
  const deactRes = await api(`/api/owner/admins/${foundAdmin.id}/deactivate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(deactRes.status, 200);
  assert.ok(deactRes.data.ok);

  // 4. Admin session is immediately invalidated (purged token returns 401 / deactivated returns 403)
  const deadSessionRes = await api('/slots', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.ok([401, 403].includes(deadSessionRes.status), 'Deactivated admin request must be rejected');

  // 5. Deactivated admin cannot login
  const deactLogin = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ userId: 'test_admin', password: 'AdminPass123!' })
  });
  assert.equal(deactLogin.status, 403, 'Deactivated account cannot sign in');

  // 6. Owner cannot deactivate the last active Owner account (self-lockout prevention)
  const ownerUser = await db.get("SELECT id FROM users WHERE user_id = 'testboss'");
  const selfDeact = await api(`/api/owner/admins/${ownerUser.id}/deactivate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(selfDeact.status, 400, 'Cannot deactivate the Owner account');

  // 7. Owner reactivates Admin
  const actRes = await api(`/api/owner/admins/${foundAdmin.id}/activate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(actRes.status, 200);

  // 8. Admin can now sign back in
  const reactLogin = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ userId: 'test_admin', password: 'AdminPass123!' })
  });
  assert.equal(reactLogin.status, 200);
  adminToken = reactLogin.data.token;
});

test('24. Admin Operator Management lifecycle & Role Boundary Protection', async () => {
  // 1. Admin can view approved operators
  const opsRes = await api('/api/admin/operators', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(opsRes.status, 200);
  assert.ok(Array.isArray(opsRes.data.operators));
  const foundOp = opsRes.data.operators.find(o => o.userId === 'test_op');
  assert.ok(foundOp, 'test_op must appear in approved operators list');
  assert.equal(foundOp.role, 'operator');
  assert.equal(foundOp.active, 1);

  // 2. Operator cannot access Operator Management endpoint
  const opForbidden = await api('/api/admin/operators', {
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  assert.equal(opForbidden.status, 403);

  // 3. Admin cannot deactivate another Admin or Owner
  const adminUser = await db.get("SELECT id FROM users WHERE user_id = 'test_admin'");
  const adminTriesAdmin = await api(`/api/admin/operators/${adminUser.id}/deactivate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(adminTriesAdmin.status, 403, 'Admins cannot deactivate Admins');

  const ownerUser = await db.get("SELECT id FROM users WHERE user_id = 'testboss'");
  const adminTriesOwner = await api(`/api/admin/operators/${ownerUser.id}/deactivate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(adminTriesOwner.status, 403, 'Admins cannot deactivate Owner');

  // 4. Admin deactivates Operator
  const deactRes = await api(`/api/admin/operators/${foundOp.id}/deactivate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(deactRes.status, 200);

  // 5. Operator session immediately invalidated (purged token returns 401 / deactivated returns 403)
  const deadOpSession = await api('/slots', {
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  assert.ok([401, 403].includes(deadOpSession.status), 'Deactivated operator request must be rejected');

  // 6. Deactivated operator cannot sign in
  const deactOpLogin = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ userId: 'test_op', password: 'NewOperatorPass999!' })
  });
  assert.equal(deactOpLogin.status, 403);

  // 7. Admin reactivates Operator
  const actRes = await api(`/api/admin/operators/${foundOp.id}/activate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(actRes.status, 200);

  // 8. Operator can sign back in
  const reactOpLogin = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ userId: 'test_op', password: 'NewOperatorPass999!' })
  });
  assert.equal(reactOpLogin.status, 200);
  operatorToken = reactOpLogin.data.token;
});

test('25. Transaction Date Filtering: inclusive boundaries, error handling, and role privacy', async () => {
  // 1. Stage specific transactions with known dates
  await db.run("INSERT INTO transactions (action, slot, item, item_name, sku, source, time, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES ('STORE', 'A1', 1, 'Product A1', 'SKU-A1', 'test', '2026-10-05 10:00:00', 5, 0, 5, 'Test Operator', 'operator', 'test_op')");
  await db.run("INSERT INTO transactions (action, slot, item, item_name, sku, source, time, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES ('STORE', 'A2', 2, 'Product A2', 'SKU-A2', 'test', '2026-10-10 14:30:00', 3, 0, 3, 'Test Operator', 'operator', 'test_op')");
  await db.run("INSERT INTO transactions (action, slot, item, item_name, sku, source, time, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES ('STORE', 'A3', 3, 'Product A3', 'SKU-A3', 'test', '2026-10-15 09:15:00', 2, 0, 2, 'Test Operator', 'operator', 'test_op')");
  // Transaction by another user
  await db.run("INSERT INTO transactions (action, slot, item, item_name, sku, source, time, quantity, before_quantity, after_quantity, user_name, role, user_id) VALUES ('STORE', 'A4', 4, 'Product A4', 'SKU-A4', 'test', '2026-10-10 12:00:00', 1, 0, 1, 'Other Operator', 'operator', 'other_user')");

  // 2. Query range 2026-10-05 to 2026-10-10 as Owner (inclusive boundaries)
  const rangeRes = await api('/transactions?from=2026-10-05&to=2026-10-10', {
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(rangeRes.status, 200);
  const dates = rangeRes.data.map(t => t.time);
  assert.ok(dates.some(d => d.includes('2026-10-05')), 'Inclusive start boundary: 2026-10-05 must be included');
  assert.ok(dates.some(d => d.includes('2026-10-10')), 'Inclusive end boundary: 2026-10-10 must be included');
  assert.ok(!dates.some(d => d.includes('2026-10-15')), 'Records beyond upper boundary must be excluded');

  // 3. Exact single-day range 2026-10-10 to 2026-10-10
  const singleDayRes = await api('/transactions?from=2026-10-10&to=2026-10-10', {
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(singleDayRes.status, 200);
  for (const t of singleDayRes.data) {
    assert.ok(t.time.includes('2026-10-10'), 'Single-day filter must include only that day');
  }

  // 4. Role privacy: Operator querying the date range sees ONLY their own records
  const opFilteredRes = await api('/transactions?from=2026-10-05&to=2026-10-10', {
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  assert.equal(opFilteredRes.status, 200);
  for (const t of opFilteredRes.data) {
    assert.equal(t.user_id, 'test_op', 'Operator must only see their own records even with date filters');
  }
  // Other user's transaction must NOT be visible to operator
  assert.ok(!opFilteredRes.data.some(t => t.user_id === 'other_user'));

  // 5. Invalid date validation
  const invalidDateRes = await api('/transactions?from=not-a-date', {
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(invalidDateRes.status, 400);

  // 6. Reversed date range validation (from > to)
  const reversedRes = await api('/transactions?from=2026-10-15&to=2026-10-05', {
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(reversedRes.status, 400);
  assert.equal(reversedRes.data.error, 'From Date cannot be later than To Date');
});

test('26. Excel (.xlsx) Export: binary verification, formula injection defense, and role scope', async () => {
  const ExcelJS = require('exceljs');

  // 1. Stage transaction with formula injection attempts
  await db.run(`
    INSERT INTO transactions (
      action, slot, item, item_name, sku, source, time,
      quantity, before_quantity, after_quantity, user_name, role, user_id
    ) VALUES (
      '=cmd|'' /C calc''!A0', 'B1', 99, '+ProductWithFormula', '-SKUFormula', '@FormulaSource',
      '2026-10-08 11:20:00', 1, 0, 1, '+EvilDisplayName', 'operator', '=EVIL_USER'
    )
  `);

  // 2. Fetch Excel export as Owner
  const exportUrl = `${baseUrl}/transactions/export?from=2026-10-05&to=2026-10-10`;
  const exportRes = await fetch(exportUrl, {
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(exportRes.status, 200);
  assert.equal(
    exportRes.headers.get('content-type'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  assert.ok(
    exportRes.headers.get('content-disposition').includes('filename="ASRS_Transactions_2026-10-05_to_2026-10-10.xlsx"')
  );

  // 3. Load Excel workbook and verify structure
  const arrayBuffer = await exportRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('Transactions');
  assert.ok(ws, 'Worksheet "Transactions" must exist');

  // Verify header row
  const headerRow = ws.getRow(1);
  assert.equal(headerRow.getCell(1).value, 'Transaction ID');
  assert.equal(headerRow.getCell(3).value, 'Action');
  assert.equal(headerRow.getCell(4).value, 'Product Name');

  // 4. Verify formula injection protection on data rows
  let foundSanitized = false;
  ws.eachRow((row, rowNumber) => {
    if (rowNumber > 1) {
      const actionVal = String(row.getCell(3).value || '');
      const productVal = String(row.getCell(4).value || '');
      const userVal = String(row.getCell(8).value || '');
      if (actionVal.includes('calc') || productVal.includes('ProductWithFormula')) {
        foundSanitized = true;
        // MUST be sanitized with leading single-quote (')
        assert.ok(actionVal.startsWith("'="), `Formula cell must be sanitized with leading quote: ${actionVal}`);
        assert.ok(productVal.startsWith("'+"), `Formula cell must be sanitized with leading quote: ${productVal}`);
        assert.ok(userVal.startsWith("'="), `Formula user must be sanitized with leading quote: ${userVal}`);
      }
    }
  });
  assert.ok(foundSanitized, 'Sanitized formula injection row must be present');

  // 5. Operator export check: Operator cannot export other users' records
  const opExportRes = await fetch(`${baseUrl}/transactions/export?from=2026-10-05&to=2026-10-10`, {
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  assert.equal(opExportRes.status, 200);
  const opBuffer = Buffer.from(await opExportRes.arrayBuffer());
  const opWb = new ExcelJS.Workbook();
  await opWb.xlsx.load(opBuffer);
  const opWs = opWb.getWorksheet('Transactions');
  opWs.eachRow((row, rowNumber) => {
    if (rowNumber > 1) {
      const userCell = String(row.getCell(8).value || '');
      assert.ok(!userCell.includes('other_user'), 'Operator export must never include another user');
    }
  });

  // 6. Empty range export check (returns valid workbook without crash)
  const emptyExportRes = await fetch(`${baseUrl}/transactions/export?from=2099-01-01&to=2099-01-02`, {
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(emptyExportRes.status, 200);
  const emptyWb = new ExcelJS.Workbook();
  await emptyWb.xlsx.load(Buffer.from(await emptyExportRes.arrayBuffer()));
  const emptyWs = emptyWb.getWorksheet('Transactions');
  assert.ok(emptyWs, 'Empty result must still generate a valid Excel sheet');
  const emptyNoteCell = emptyWs.getRow(2).getCell(1).value;
  assert.ok(String(emptyNoteCell).includes('No transactions found'), 'Empty state note row must be present');
});

test('27. Role-Specific Navigation Menu Contracts & Client-Side Privilege Isolation', async () => {
  // Read dashboard/app.js to verify menu definition contracts
  const appJs = fs.readFileSync(path.join(__dirname, '../../dashboard/app.js'), 'utf8');
  assert.ok(appJs.includes("admin_mgmt', '♟', 'Admin Management'"), 'Owner menu must include Admin Management');
  assert.ok(appJs.includes("operator_mgmt', '♟', 'Operator Management'"), 'Admin menu must include Operator Management');
  
  // Verify Admin menu does not include Owner-only options
  const adminMenuMatch = appJs.match(/admin:\s*\[([\s\S]*?)\],\s*operator:/);
  assert.ok(adminMenuMatch, 'Admin menu must be defined');
  const adminMenuStr = adminMenuMatch[1];
  assert.ok(!adminMenuStr.includes('admin_mgmt'), 'Admin menu must NOT contain Admin Management');
  assert.ok(!adminMenuStr.includes("'rack'"), 'Admin menu must NOT contain Rack Configuration');
  assert.ok(!adminMenuStr.includes('settings'), 'Admin menu must NOT contain Settings & Hardware');
  assert.ok(!adminMenuStr.includes("'store'"), 'Admin menu must NOT contain Store Stock');
  assert.ok(!adminMenuStr.includes("'retrieve'"), 'Admin menu must NOT contain Retrieve Stock');

  // Verify Operator menu does not include Management options
  const opMenuMatch = appJs.match(/operator:\s*\[([\s\S]*?)\]\s*\};/);
  assert.ok(opMenuMatch, 'Operator menu must be defined');
  const opMenuStr = opMenuMatch[1];
  assert.ok(!opMenuStr.includes('admin_mgmt'), 'Operator menu must NOT contain Admin Management');
  assert.ok(!opMenuStr.includes('operator_mgmt'), 'Operator menu must NOT contain Operator Management');
  assert.ok(!opMenuStr.includes('approvals'), 'Operator menu must NOT contain Approvals');
  assert.ok(!opMenuStr.includes("'rack'"), 'Operator menu must NOT contain Rack Configuration');
  assert.ok(!opMenuStr.includes('settings'), 'Operator menu must NOT contain Settings & Hardware');
  assert.ok(opMenuStr.includes("'store'"), 'Operator menu must contain Store Stock');
  assert.ok(opMenuStr.includes("'retrieve'"), 'Operator menu must contain Retrieve Stock');
});

test('28. Public Store Application Onboarding: validates input, prevents duplicate codes, and creates pending store', async () => {
  // Invalid empty name
  const invalidName = await api('/api/stores/apply', {
    method: 'POST',
    headers: {},
    body: JSON.stringify({ name: '', code: 'STORE1', email: 'owner@store1.com', password: 'Password123!' })
  });
  assert.equal(invalidName.status, 400);

  // Valid application for Grocery Store
  const validApp = await api('/api/stores/apply', {
    method: 'POST',
    headers: {},
    body: JSON.stringify({
      name: 'Fresh Mart Grocery',
      code: 'FM_GROCERY_01',
      storeType: 'grocery',
      ownerUserId: 'fm_owner',
      ownerName: 'Fresh Mart Owner',
      email: 'owner@freshmart.com',
      phone: '+919876500001',
      address: '123 Market Road',
      city: 'Pune',
      password: 'FreshPassword123!',
      applicationReason: 'Quick grocery fulfillment dark store'
    })
  });
  assert.equal(validApp.status, 200);
  assert.equal(validApp.data.ok, true);
  assert.ok(validApp.data.storeId);
  assert.equal(validApp.data.code, 'FM_GROCERY_01');

  // Duplicate code attempt must fail
  const dupCode = await api('/api/stores/apply', {
    method: 'POST',
    headers: {},
    body: JSON.stringify({
      name: 'Fresh Mart Second Branch',
      code: 'FM_GROCERY_01',
      email: 'second@freshmart.com',
      password: 'Password123!'
    })
  });
  assert.equal(dupCode.status, 400);
  assert.match(dupCode.data.error, /already registered/i);
});

test('29. Platform Owner Approval Lifecycle: activates store, activates owner, initializes 16 slots, and registers device', async () => {
  // Pending stores queue as Platform Owner
  const pendingRes = await api('/api/platform/pending-stores', {
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(pendingRes.status, 200);
  assert.ok(Array.isArray(pendingRes.data.stores));
  const pendingStore = pendingRes.data.stores.find(s => s.code === 'FM_GROCERY_01');
  assert.ok(pendingStore, 'Pending store must be in platform pending queue');

  // Non-platform owner cannot approve (403)
  const forbiddenApprove = await api(`/api/platform/stores/${pendingStore.id}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  assert.equal(forbiddenApprove.status, 403);

  // Approve store as Platform Owner
  const approveRes = await api(`/api/platform/stores/${pendingStore.id}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.data.ok, true);

  // Verify store is now active
  const storeRow = await db.get('SELECT * FROM stores WHERE id = ?', [pendingStore.id]);
  assert.equal(storeRow.status, 'active');

  // Verify owner user is now active and approved
  const ownerUser = await db.get('SELECT * FROM users WHERE user_id = ?', ['fm_owner']);
  assert.equal(ownerUser.active, 1);
  assert.equal(ownerUser.approval_status, 'approved');

  // Verify 16 default slots (A1-D4) were initialized for this store
  const storeSlots = await db.all('SELECT slot, store_id, quantity FROM slots WHERE store_id = ? ORDER BY slot', [pendingStore.id]);
  assert.equal(storeSlots.length, 16);
  assert.equal(storeSlots[0].slot, 'A1');
  assert.equal(storeSlots[15].slot, 'D4');

  // Verify hardware device registered for this store
  const devRow = await db.get('SELECT * FROM store_devices WHERE store_id = ?', [pendingStore.id]);
  assert.ok(devRow);
  assert.equal(devRow.status, 'active');
  assert.ok(devRow.device_key.startsWith('asrs_hw_'));
});

test('30. Store Suspension and Re-activation Lifecycle: suspended store blocks tenant operations', async () => {
  const store = await db.get("SELECT id FROM stores WHERE code = 'FM_GROCERY_01'");
  assert.ok(store);

  // Suspend store as Platform Owner
  const suspendRes = await api(`/api/platform/stores/${store.id}/suspend`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(suspendRes.status, 200);

  // Login as store owner
  const crypto = require('crypto');
  const ownerToken = 'owner_token_' + crypto.randomBytes(16).toString('hex');
  await db.run('INSERT INTO user_sessions (token, user_id, display_name, role) VALUES (?, ?, ?, ?)', [
    ownerToken, 'fm_owner', 'Fresh Mart Owner', 'admin'
  ]);

  // Attempt to access slots of suspended store -> 403 Store is currently suspended
  const accessRes = await api('/slots', {
    headers: { Authorization: `Bearer ${ownerToken}`, 'x-store-id': store.id }
  });
  assert.equal(accessRes.status, 403);
  assert.match(accessRes.data.error, /suspended/i);

  // Reactivate store as Platform Owner
  const reactivateRes = await api(`/api/platform/stores/${store.id}/activate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(reactivateRes.status, 200);

  // Access slots again -> 200 OK
  const accessActive = await api('/slots', {
    headers: { Authorization: `Bearer ${ownerToken}`, 'x-store-id': store.id }
  });
  assert.equal(accessActive.status, 200);
});

test('31. Cross-Tenant Slot and Inventory Isolation between Store A and Store B', async () => {
  // Store A = store_default_001
  // Store B = Fresh Mart store
  const storeB = await db.get("SELECT id FROM stores WHERE code = 'FM_GROCERY_01'");
  assert.ok(storeB);

  // Add an operator to Store B
  const crypto = require('crypto');
  const opBSalt = crypto.randomBytes(16).toString('hex');
  const opBHash = crypto.scryptSync('OpPass123!', opBSalt, 64).toString('hex');
  await db.run(`
    INSERT INTO users (user_id, password_hash, salt, display_name, role, active, approval_status, effective_role)
    VALUES ('op_freshmart', ?, ?, 'FM Operator', 'operator', 1, 'approved', 'operator')
  `, [opBHash, opBSalt]);
  await db.run(`
    INSERT INTO store_memberships (store_id, user_id, role, status)
    VALUES (?, 'op_freshmart', 'operator', 'active')
  `, [storeB.id]);
  const opBToken = 'token_op_b_' + crypto.randomBytes(16).toString('hex');
  await db.run('INSERT INTO user_sessions (token, user_id, display_name, role) VALUES (?, ?, ?, ?)', [
    opBToken, 'op_freshmart', 'FM Operator', 'operator'
  ]);

  // Read initial stock in Store A slot B2
  const slotA_B2_init = await db.get("SELECT quantity FROM slots WHERE store_id = 'store_default_001' AND slot = 'B2'");
  const initialStockA = Number(slotA_B2_init.quantity);

  // Store B Operator performs STORE of 5 units in slot B2 of Store B
  const storeBMovement = await api('/store', {
    method: 'POST',
    headers: { Authorization: `Bearer ${opBToken}`, 'x-store-id': storeB.id },
    body: JSON.stringify({ slot: 'B2', quantity: 5, source: 'dashboard' })
  });
  assert.equal(storeBMovement.status, 200);
  assert.equal(storeBMovement.data.slot.quantity, 5);
  assert.equal(storeBMovement.data.slot.store_id, storeB.id);

  // Verify Store A slot B2 was COMPLETELY UNTOUCHED
  const slotA_B2_after = await db.get("SELECT quantity FROM slots WHERE store_id = 'store_default_001' AND slot = 'B2'");
  assert.equal(Number(slotA_B2_after.quantity), initialStockA, 'Store A stock must remain completely unchanged');

  // Transactions query for Store B only returns Store B transactions
  const txResB = await api('/transactions', {
    headers: { Authorization: `Bearer ${opBToken}`, 'x-store-id': storeB.id }
  });
  assert.equal(txResB.status, 200);
  assert.ok(txResB.data.every(t => t.store_id === storeB.id));
});

test('32. Strict Cross-Tenant Access Enforcement: Store A user blocked from Store B with audit logging', async () => {
  const storeB = await db.get("SELECT id FROM stores WHERE code = 'FM_GROCERY_01'");
  assert.ok(storeB);

  // Store A Operator (test_op) tries to access Store B slots
  const trespassSlots = await api('/slots', {
    headers: { Authorization: `Bearer ${operatorToken}`, 'x-store-id': storeB.id }
  });
  assert.equal(trespassSlots.status, 403);
  assert.match(trespassSlots.data.error, /not an active member/i);

  // Store A Operator tries to store items in Store B rack
  const trespassStore = await api('/store', {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}`, 'x-store-id': storeB.id },
    body: JSON.stringify({ slot: 'A1', quantity: 2 })
  });
  assert.equal(trespassStore.status, 403);
  assert.match(trespassStore.data.error, /not an active member/i);

  // Verify audit log captured UNAUTHORIZED_CROSS_STORE_ACCESS
  const auditEntry = await db.get(
    "SELECT * FROM audit_logs WHERE store_id = ? AND user_id = 'test_op' AND action = 'UNAUTHORIZED_CROSS_STORE_ACCESS'",
    [storeB.id]
  );
  assert.ok(auditEntry, 'Audit log entry must be recorded for unauthorized cross-tenant attempt');
});

test('33. Hardware Device Multi-Tenant Isolation: device key isolates movement per store', async () => {
  const storeB = await db.get("SELECT id FROM stores WHERE code = 'FM_GROCERY_01'");
  const devB = await db.get('SELECT device_key FROM store_devices WHERE store_id = ?', [storeB.id]);
  assert.ok(devB);

  // Hardware movement using Store B device key
  const hwRes = await api('/api/hardware/store', {
    method: 'POST',
    headers: { 'x-hardware-key': devB.device_key },
    body: JSON.stringify({ slot: 'C1', quantity: 2, source: 'keypad' })
  });
  assert.equal(hwRes.status, 200);
  assert.equal(hwRes.data.storeId, storeB.id);
  assert.equal(hwRes.data.slot.slot, 'C1');

  // Verify Store B slot C1 updated, while Store A slot C1 was untouched
  const slotB_C1 = await db.get('SELECT quantity FROM slots WHERE store_id = ? AND slot = ?', [storeB.id, 'C1']);
  assert.equal(slotB_C1.quantity, 2);

  const slotA_C1 = await db.get("SELECT quantity FROM slots WHERE store_id = 'store_default_001' AND slot = 'C1'");
  assert.notEqual(slotA_C1.quantity, 2);
});

test('34. Store Staff Management & Communication Hierarchy Enforcement', async () => {
  const storeB = await db.get("SELECT id FROM stores WHERE code = 'FM_GROCERY_01'");
  const ownerToken = (await db.get("SELECT token FROM user_sessions WHERE user_id = 'fm_owner'"))?.token;
  assert.ok(ownerToken);

  // 1. Store Owner adds Store Admin
  const addAdminRes = await api(`/api/stores/${storeB.id}/members`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      userId: 'fm_admin_1',
      displayName: 'FM Assistant Manager',
      role: 'store_admin',
      password: 'AdminPassword123!',
      email: 'admin1@freshmart.com'
    })
  });
  assert.equal(addAdminRes.status, 200);

  // Login token for newly created Store Admin
  const crypto = require('crypto');
  const adminTokenFM = 'token_fm_admin_' + crypto.randomBytes(16).toString('hex');
  await db.run('INSERT INTO user_sessions (token, user_id, display_name, role) VALUES (?, ?, ?, ?)', [
    adminTokenFM, 'fm_admin_1', 'FM Assistant Manager', 'admin'
  ]);

  // 2. Store Admin adds Operator -> MUST SUCCEED
  const addOpRes = await api(`/api/stores/${storeB.id}/members`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminTokenFM}` },
    body: JSON.stringify({
      userId: 'fm_op_picker',
      displayName: 'Picker One',
      role: 'operator',
      password: 'OpPassword123!',
      email: 'picker1@freshmart.com'
    })
  });
  assert.equal(addOpRes.status, 200);

  // 3. Store Admin attempts to add another Store Admin -> MUST FAIL (403)
  const addAdminFail = await api(`/api/stores/${storeB.id}/members`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminTokenFM}` },
    body: JSON.stringify({
      userId: 'fm_admin_2',
      displayName: 'Illegal Admin',
      role: 'store_admin',
      password: 'AdminPassword123!'
    })
  });
  assert.equal(addAdminFail.status, 403);
  assert.match(addAdminFail.data.error, /only add Operators/i);

  // 4. Operator attempts to view or manage staff -> MUST FAIL (403)
  const opTokenFM = (await db.get("SELECT token FROM user_sessions WHERE user_id = 'op_freshmart'"))?.token;
  const opViewMembers = await api(`/api/stores/${storeB.id}/members`, {
    headers: { Authorization: `Bearer ${opTokenFM}` }
  });
  assert.equal(opViewMembers.status, 403);
});

test('35. Sole Store Owner Self-Lockout Protection and Immediate Session Revocation', async () => {
  const storeB = await db.get("SELECT id FROM stores WHERE code = 'FM_GROCERY_01'");
  const ownerToken = (await db.get("SELECT token FROM user_sessions WHERE user_id = 'fm_owner'"))?.token;
  assert.ok(ownerToken);

  // 1. Sole Store Owner attempts to deactivate themselves -> MUST FAIL (400)
  const selfDeactivate = await api(`/api/stores/${storeB.id}/members/fm_owner/deactivate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  assert.equal(selfDeactivate.status, 400);
  assert.match(selfDeactivate.data.error, /only active Store Owner/i);

  // 2. Deactivate an operator -> session immediately invalidated
  const deactOp = await api(`/api/stores/${storeB.id}/members/fm_op_picker/deactivate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  assert.equal(deactOp.status, 200);

  const membership = await db.get("SELECT status FROM store_memberships WHERE store_id = ? AND user_id = 'fm_op_picker'", [storeB.id]);
  assert.equal(membership.status, 'deactivated');
});

test('36. User Stores List (/api/user/stores): Platform Owner vs Store Member scoping', async () => {
  // Platform Owner sees all active stores
  const poStores = await api('/api/user/stores', {
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(poStores.status, 200);
  assert.ok(poStores.data.stores.length >= 2, 'Platform Owner must see all active stores');

  // Store B operator only sees Store B
  const opTokenFM = (await db.get("SELECT token FROM user_sessions WHERE user_id = 'op_freshmart'"))?.token;
  const opStores = await api('/api/user/stores', {
    headers: { Authorization: `Bearer ${opTokenFM}` }
  });
  assert.equal(opStores.status, 200);
  assert.equal(opStores.data.stores.length, 1);
  assert.equal(opStores.data.stores[0].code, 'FM_GROCERY_01');
});

test('37. SEC-01 Cross-Tenant Isolation: Store B user blocked from Store A with zero auto-enrollment', async () => {
  const storeB = await db.get("SELECT id FROM stores WHERE code = 'FM_GROCERY_01'");
  const opTokenFM = (await db.get("SELECT token FROM user_sessions WHERE user_id = 'op_freshmart'"))?.token;
  assert.ok(opTokenFM, 'Store B operator token must exist');

  // Verify op_freshmart is NOT a member of store_default_001
  const priorMembership = await db.get(
    "SELECT * FROM store_memberships WHERE store_id = 'store_default_001' AND user_id = 'op_freshmart'"
  );
  assert.equal(priorMembership, null, 'op_freshmart must not have membership in default store');

  // 1. Store B user attempts to access Store A inventory using x-store-id header
  const crossStoreAccess = await api('/slots', {
    headers: {
      Authorization: `Bearer ${opTokenFM}`,
      'x-store-id': 'store_default_001'
    }
  });
  assert.equal(crossStoreAccess.status, 403);
  assert.match(crossStoreAccess.data.error, /not an active member of this store/i);

  // 2. Verify NO membership was dynamically auto-enrolled (SEC-01 guarantee)
  const afterMembership = await db.get(
    "SELECT * FROM store_memberships WHERE store_id = 'store_default_001' AND user_id = 'op_freshmart'"
  );
  assert.equal(afterMembership, null, 'Dynamic auto-enrollment must NEVER occur');

  // 3. Verify security incident was recorded in audit_logs
  const auditEntry = await db.get(
    "SELECT * FROM audit_logs WHERE user_id = 'op_freshmart' AND action = 'UNAUTHORIZED_CROSS_STORE_ACCESS' ORDER BY id DESC LIMIT 1"
  );
  assert.ok(auditEntry, 'Cross-store access attempt must be audited');
  assert.equal(auditEntry.store_id, 'store_default_001');
});

test('38. SEC-05 Conflicting Store Identifiers: Request rejected when parameters conflict', async () => {
  const storeB = await db.get("SELECT id FROM stores WHERE code = 'FM_GROCERY_01'");
  const ownerTokenFM = (await db.get("SELECT token FROM user_sessions WHERE user_id = 'fm_owner'"))?.token;
  assert.ok(ownerTokenFM);

  // Send header x-store-id pointing to store_default_001, but query param pointing to storeB.id
  const conflictRes = await api(`/slots?store_id=${storeB.id}`, {
    headers: {
      Authorization: `Bearer ${ownerTokenFM}`,
      'x-store-id': 'store_default_001'
    }
  });
  assert.equal(conflictRes.status, 400);
  assert.match(conflictRes.data.error, /Conflicting store identifiers/i);
});

test('39. SEC-02 Staff Isolation: Store B admin cannot view or modify Store A staff', async () => {
  const storeB = await db.get("SELECT id FROM stores WHERE code = 'FM_GROCERY_01'");
  const adminTokenFM = (await db.get("SELECT token FROM user_sessions WHERE user_id = 'fm_admin_1'"))?.token;
  assert.ok(adminTokenFM, 'Store B admin token must exist');

  // 1. Store B admin calling GET /api/admin/operators only receives Store B operators
  const opsRes = await api('/api/admin/operators', {
    headers: { Authorization: `Bearer ${adminTokenFM}` }
  });
  assert.equal(opsRes.status, 200);
  const userIds = opsRes.data.operators.map(o => o.user_id);
  assert.ok(!userIds.includes('test_op'), 'Store B admin must not see Store A operators');

  // 2. Store B admin calling GET /users only sees Store B operators
  const usersRes = await api('/users', {
    headers: { Authorization: `Bearer ${adminTokenFM}` }
  });
  assert.equal(usersRes.status, 200);
  const returnedUserIds = usersRes.data.map(u => u.user_id);
  assert.ok(!returnedUserIds.includes('test_op'), 'Store B admin must not see Store A users');
  assert.ok(!returnedUserIds.includes('testboss'), 'Store B admin must not see Store A owner');

  // 3. Store B admin attempting to deactivate Store A operator via /api/admin/operators/:id/deactivate
  const storeAOp = await db.get("SELECT id FROM users WHERE user_id = 'test_op'");
  const deactAttempt = await api(`/api/admin/operators/${storeAOp.id}/deactivate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminTokenFM}` }
  });
  assert.equal(deactAttempt.status, 404);
  assert.match(deactAttempt.data.error, /not found in this store/i);

  // 4. Store B admin attempting to modify Store A operator via PATCH /users/:id
  const patchAttempt = await api(`/users/${storeAOp.id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${adminTokenFM}` },
    body: JSON.stringify({ active: false })
  });
  assert.equal(patchAttempt.status, 404);
  assert.match(patchAttempt.data.error, /not found in this store/i);
});

test('40. SEC-02 Platform Barrier: Store B owner blocked from platform owner routes', async () => {
  const ownerTokenFM = (await db.get("SELECT token FROM user_sessions WHERE user_id = 'fm_owner'"))?.token;
  assert.ok(ownerTokenFM);

  // 1. Blocked from platform stores list
  const platStores = await api('/api/platform/stores', {
    headers: { Authorization: `Bearer ${ownerTokenFM}` }
  });
  assert.equal(platStores.status, 403);
  assert.match(platStores.data.error, /Platform Owner permission required/i);

  // 2. Blocked from platform pending stores
  const pendStores = await api('/api/platform/pending-stores', {
    headers: { Authorization: `Bearer ${ownerTokenFM}` }
  });
  assert.equal(pendStores.status, 403);

  // 3. Blocked from hardware master key endpoints
  const hwKey = await api('/hardware/key', {
    headers: { Authorization: `Bearer ${ownerTokenFM}` }
  });
  assert.equal(hwKey.status, 403);

  const hwRegen = await api('/hardware/key/regenerate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerTokenFM}` }
  });
  assert.equal(hwRegen.status, 403);

  // 4. Blocked from platform owner pending admin queue
  const pendAdmins = await api('/api/owner/pending-admins', {
    headers: { Authorization: `Bearer ${ownerTokenFM}` }
  });
  assert.equal(pendAdmins.status, 403);
});

test('41. SEC-03 Rack Isolation: Independent store rack dimensions do not overwrite default store', async () => {
  const storeB = await db.get("SELECT id FROM stores WHERE code = 'FM_GROCERY_01'");
  const ownerTokenFM = (await db.get("SELECT token FROM user_sessions WHERE user_id = 'fm_owner'"))?.token;
  assert.ok(ownerTokenFM);

  // Initial Store A dimensions (rack_config id=1)
  const rackConfigBefore = await db.get('SELECT rows, cols FROM rack_config WHERE id = 1');

  // Store B expands its rack to 3x5
  const updateB = await api('/rack/dimensions', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${ownerTokenFM}`,
      'x-store-id': storeB.id
    },
    body: JSON.stringify({ rows: 3, cols: 5 })
  });
  assert.equal(updateB.status, 200);
  assert.equal(updateB.data.rows, 3);
  assert.equal(updateB.data.cols, 5);

  // Verify Store B in database has rack_rows=3, rack_cols=5
  const storeBRow = await db.get('SELECT rack_rows, rack_cols FROM stores WHERE id = ?', [storeB.id]);
  assert.equal(storeBRow.rack_rows, 3);
  assert.equal(storeBRow.rack_cols, 5);

  // Crucial SEC-03 assertion: rack_config id = 1 for Store A remains completely untouched
  const rackConfigAfter = await db.get('SELECT rows, cols FROM rack_config WHERE id = 1');
  assert.equal(rackConfigAfter.rows, rackConfigBefore.rows, 'Store A rack rows must remain untouched');
  assert.equal(rackConfigAfter.cols, rackConfigBefore.cols, 'Store A rack cols must remain untouched');
});

test('42. SEC-04 Hardware Isolation: Store device key rotation immediately invalidates old key', async () => {
  const storeB = await db.get("SELECT id FROM stores WHERE code = 'FM_GROCERY_01'");
  const ownerTokenFM = (await db.get("SELECT token FROM user_sessions WHERE user_id = 'fm_owner'"))?.token;
  assert.ok(ownerTokenFM);

  // Register a new device for Store B
  const regDev = await api(`/api/stores/${storeB.id}/devices`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerTokenFM}` },
    body: JSON.stringify({ deviceName: 'ESP32 Shelf Scanner' })
  });
  assert.equal(regDev.status, 200);
  const initialKey = regDev.data.deviceKey;
  assert.ok(initialKey);

  // Find the device id
  const devRow = await db.get('SELECT id FROM store_devices WHERE device_key = ?', [initialKey]);
  assert.ok(devRow);

  // Device can store inventory for Store B using initial key
  const validHwCall = await api('/api/hardware/store', {
    method: 'POST',
    headers: { 'X-Hardware-Key': initialKey },
    body: JSON.stringify({ slot: 'A1', quantity: 1, source: 'keypad' })
  });
  assert.equal(validHwCall.status, 200);
  assert.equal(validHwCall.data.storeId, storeB.id);

  // Rotate device key via POST /api/stores/:storeId/devices/:deviceId/rotate
  const rotateRes = await api(`/api/stores/${storeB.id}/devices/${devRow.id}/rotate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerTokenFM}` }
  });
  assert.equal(rotateRes.status, 200);
  const rotatedKey = rotateRes.data.deviceKey;
  assert.ok(rotatedKey);
  assert.notEqual(rotatedKey, initialKey);

  // Old key MUST now fail with 401 Unauthorized
  const oldKeyCall = await api('/api/hardware/store', {
    method: 'POST',
    headers: { 'X-Hardware-Key': initialKey },
    body: JSON.stringify({ slot: 'A1', quantity: 1, source: 'keypad' })
  });
  assert.equal(oldKeyCall.status, 401);

  // New key MUST succeed with 200 OK
  const newKeyCall = await api('/api/hardware/retrieve', {
    method: 'POST',
    headers: { 'X-Hardware-Key': rotatedKey },
    body: JSON.stringify({ slot: 'A1', quantity: 1, source: 'keypad' })
  });
  assert.equal(newKeyCall.status, 200);
  assert.equal(newKeyCall.data.storeId, storeB.id);
});

test('43. SEC-04 Master Key Atomicity: Platform regeneration synchronizes store_devices for default store', async () => {
  const regenRes = await api('/hardware/key/regenerate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${bossToken}` }
  });
  assert.equal(regenRes.status, 200);
  const newMasterKey = regenRes.data.hardwareApiKey;
  assert.ok(newMasterKey);

  // Verify system_settings has new key
  const settingRow = await db.get("SELECT value FROM system_settings WHERE key = 'hardware_api_key'");
  assert.equal(settingRow.value, newMasterKey);

  // Verify store_devices for store_default_001 has new key
  const devRow = await db.get("SELECT device_key FROM store_devices WHERE store_id = 'store_default_001'");
  assert.equal(devRow.device_key, newMasterKey, 'Default store device key must be synchronized atomically');

  // Verify hardware operation succeeds with new master key
  const hwOk = await api('/api/hardware/store', {
    method: 'POST',
    headers: { 'X-Hardware-Key': newMasterKey },
    body: JSON.stringify({ slot: 'A1', quantity: 1, source: 'keypad' })
  });
  assert.equal(hwOk.status, 200);
  assert.equal(hwOk.data.storeId, 'store_default_001');

  // Clean up
  await api('/api/hardware/retrieve', {
    method: 'POST',
    headers: { 'X-Hardware-Key': newMasterKey },
    body: JSON.stringify({ slot: 'A1', quantity: 1, source: 'keypad' })
  });
});

test('44. Transaction & Export Tenant Boundary: User cannot query or export foreign store transactions', async () => {
  const storeB = await db.get("SELECT id FROM stores WHERE code = 'FM_GROCERY_01'");
  const opTokenFM = (await db.get("SELECT token FROM user_sessions WHERE user_id = 'op_freshmart'"))?.token;
  assert.ok(opTokenFM);

  // 1. Store B operator querying /transactions without params gets only Store B transactions
  const txRes = await api('/transactions', {
    headers: { Authorization: `Bearer ${opTokenFM}` }
  });
  assert.equal(txRes.status, 200);
  for (const t of txRes.data) {
    assert.equal(t.store_id, storeB.id, 'Transactions must strictly belong to Store B');
  }

  // 2. Store B operator attempts to query foreign store via query param ?store_id=store_default_001 -> 403
  const foreignTxRes = await api('/transactions?store_id=store_default_001', {
    headers: { Authorization: `Bearer ${opTokenFM}` }
  });
  assert.equal(foreignTxRes.status, 403);
  assert.match(foreignTxRes.data.error, /not an active member of this store/i);

  // 3. Store B operator attempts to export foreign store via ?store_id=store_default_001 -> 403
  const foreignExport = await api('/transactions/export?store_id=store_default_001', {
    headers: { Authorization: `Bearer ${opTokenFM}` }
  });
  assert.equal(foreignExport.status, 403);
  assert.match(foreignExport.data.error, /not an active member of this store/i);
});

test('45. Phase 3 Frontend Contracts: Store Switcher, Onboarding Alias & Mobile PWA Integration', async () => {
  // 1. Verify /api/stores/register alias works cleanly alongside /api/stores/apply
  const regRes = await api('/api/stores/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'QuickMart Dark Store 02',
      code: 'QM_DARK_02',
      storeType: 'dark_store',
      email: 'owner@qm-dark02.com',
      ownerUserId: 'qm_owner_02',
      ownerName: 'QuickMart Owner',
      password: 'Password123!',
      applicationReason: 'Dark store 15-min delivery'
    })
  });
  assert.equal(regRes.status, 200);
  assert.equal(regRes.data.ok, true);
  assert.equal(regRes.data.code, 'QM_DARK_02');

  // 2. Verify dashboard/index.html UI Contracts
  const indexHtml = fs.readFileSync(path.join(__dirname, '../../dashboard/index.html'), 'utf8');
  assert.ok(indexHtml.includes('id="storeSwitcherWrap"'), 'HTML must include Store Switcher container');
  assert.ok(indexHtml.includes('id="storeSelect"'), 'HTML must include #storeSelect dropdown');
  assert.ok(indexHtml.includes('id="storeTypeBadge"'), 'HTML must include #storeTypeBadge');
  assert.ok(indexHtml.includes('id="storeRegFields"'), 'HTML must include Store Registration fields');
  assert.ok(indexHtml.includes('id="storeRegLink"'), 'HTML must include #storeRegLink in footer');
  assert.ok(indexHtml.includes('id="mobileBottomNav"'), 'HTML must include mobile bottom navigation bar');

  // 3. Verify dashboard/app.js Frontend Logic Contracts
  const appJs = fs.readFileSync(path.join(__dirname, '../../dashboard/app.js'), 'utf8');
  assert.ok(appJs.includes('async function fetchUserStores()'), 'app.js must define fetchUserStores');
  assert.ok(appJs.includes('async function switchStore('), 'app.js must define switchStore');
  assert.ok(appJs.includes('function getCurrentStoreRole()'), 'app.js must define getCurrentStoreRole');
  assert.ok(appJs.includes('function setupStoreRegHandlers()'), 'app.js must define setupStoreRegHandlers');
  assert.ok(appJs.includes('function buildMobileNav()'), 'app.js must define buildMobileNav');
  assert.ok(appJs.includes('function platformStoresPage()'), 'app.js must define platformStoresPage');
  assert.ok(appJs.includes('function storeStaffPage()'), 'app.js must define storeStaffPage');
  assert.ok(appJs.includes('function storeDevicesPage()'), 'app.js must define storeDevicesPage');
  assert.ok(appJs.includes("'x-store-id': activeStoreId"), 'Excel export must include x-store-id header');

  // 4. Verify dashboard/style.css Responsive Styling Contracts
  const styleCss = fs.readFileSync(path.join(__dirname, '../../dashboard/style.css'), 'utf8');
  assert.ok(styleCss.includes('.store-switcher-wrap'), 'CSS must include .store-switcher-wrap');
  assert.ok(styleCss.includes('.mobile-bottom-nav'), 'CSS must include .mobile-bottom-nav');
  assert.ok(styleCss.includes('@media') && styleCss.includes('max-width: 768px'), 'CSS must include responsive media queries');
});

test('46. Startup Backfill Idempotency & Zero Auto-Enrollment: initDb does not grant default-store membership to Store B users', async () => {
  // Confirm op_freshmart exists and is active
  const opUser = await db.get("SELECT * FROM users WHERE user_id = 'op_freshmart'");
  assert.ok(opUser, 'Store B operator op_freshmart must exist in users table');

  // Verify op_freshmart does NOT have membership in default store
  const memBefore = await db.get(
    "SELECT * FROM store_memberships WHERE store_id = 'store_default_001' AND user_id = 'op_freshmart'"
  );
  assert.equal(memBefore, null, 'op_freshmart must NOT have default store membership before initDb');

  // Execute database initialization/startup backfill again
  await db.initDb();

  // Verify op_freshmart STILL does not have default store membership
  const memAfter = await db.get(
    "SELECT * FROM store_memberships WHERE store_id = 'store_default_001' AND user_id = 'op_freshmart'"
  );
  assert.equal(memAfter, null, 'initDb must NOT silently grant default store membership to Store B users');

  // Verify default store integrity is preserved
  const testbossMember = await db.get(
    "SELECT * FROM store_memberships WHERE store_id = 'store_default_001' AND user_id = 'testboss'"
  );
  assert.ok(testbossMember, 'testboss must retain store_owner membership in default store');
  assert.equal(testbossMember.status, 'active');

  const defaultStoreSlots = await db.get(
    "SELECT COUNT(*) as n FROM slots WHERE store_id = 'store_default_001'"
  );
  assert.ok(Number(defaultStoreSlots.n) >= 16, 'Default store must maintain its slots');
});

test('47. Secure First-Owner Bootstrap & Password Hashing: initDb provisions owner without hardcoded credentials', async () => {
  const boss = await db.get("SELECT user_id, password_hash, salt, role, effective_role, platform_role FROM users WHERE user_id = 'testboss'");
  assert.ok(boss, 'testboss must exist in database');
  assert.equal(boss.role, 'boss');
  assert.equal(boss.platform_role, 'platform_owner');
  assert.equal(boss.effective_role, 'owner');
  assert.ok(boss.salt && boss.salt.length === 32, 'Salt must be a 16-byte hex string');
  assert.ok(boss.password_hash && boss.password_hash.length === 128, 'Password hash must be 64-byte scrypt hex');

  // Verify membership in default store
  const mem = await db.get("SELECT * FROM store_memberships WHERE store_id = 'store_default_001' AND user_id = 'testboss'");
  assert.ok(mem, 'testboss must be enrolled in default store');
  assert.equal(mem.role, 'store_owner');
  assert.equal(mem.status, 'active');
});

test('48. Dynamic Hardware Device Provisioning: initDb generates and binds hardware API key per store', async () => {
  const hwKeyRow = await db.get("SELECT value FROM system_settings WHERE key = 'hardware_api_key'");
  assert.ok(hwKeyRow && hwKeyRow.value, 'hardware_api_key must exist in system_settings');
  assert.ok(hwKeyRow.value.startsWith('asrs_hw_'), 'Device key must have standard asrs_hw_ prefix');

  // Verify registered in store_devices
  const dev = await db.get("SELECT * FROM store_devices WHERE device_key = ?", [hwKeyRow.value]);
  assert.ok(dev, 'Hardware device must be registered in store_devices');
  assert.equal(dev.store_id, 'store_default_001');
  assert.equal(dev.status, 'active');
});

test('49. Startup Provisioning Idempotency: Repeated initDb calls preserve credentials and hardware keys', async () => {
  const bossBefore = await db.get("SELECT password_hash, salt FROM users WHERE user_id = 'testboss'");
  assert.ok(bossBefore, 'testboss must exist');

  const hwKeyBefore = await db.get("SELECT value FROM system_settings WHERE key = 'hardware_api_key'");
  assert.ok(hwKeyBefore && hwKeyBefore.value, 'hardware_api_key must exist');

  const devBefore = await db.get("SELECT device_key FROM store_devices WHERE store_id = 'store_default_001'");
  assert.ok(devBefore, 'Default store device must exist');

  // Trigger repeated initDb calls
  await db.initDb();
  await db.initDb();

  const bossAfter = await db.get("SELECT password_hash, salt FROM users WHERE user_id = 'testboss'");
  assert.equal(bossAfter.password_hash, bossBefore.password_hash, 'Password hash must remain identical');
  assert.equal(bossAfter.salt, bossBefore.salt, 'Salt must remain identical');

  const hwKeyAfter = await db.get("SELECT value FROM system_settings WHERE key = 'hardware_api_key'");
  assert.equal(hwKeyAfter.value, hwKeyBefore.value, 'Hardware API key must not be regenerated');

  const devAfter = await db.get("SELECT device_key FROM store_devices WHERE store_id = 'store_default_001'");
  assert.equal(devAfter.device_key, devBefore.device_key, 'Store device key must remain unchanged');
});

test('50. First-Owner Setup Concurrency: Concurrent /auth/setup requests guarantee single owner and 409 Conflict', async () => {
  // Temporarily deactivate boss accounts to simulate clean initial state
  await db.run("UPDATE users SET active = 0 WHERE role = 'boss'");

  try {
    const userA = 'concurrent_owner_a';
    const userB = 'concurrent_owner_b';

    // Dispatch two concurrent setup requests simultaneously
    const [resA, resB] = await Promise.all([
      api('/auth/setup', {
        method: 'POST',
        body: JSON.stringify({
          userId: userA,
          password: 'PasswordA123!',
          displayName: 'Owner Candidate A',
          warehouseName: 'Concurrent WH A',
          warehouseCode: 'CWH-A',
          location: 'Hub A'
        })
      }),
      api('/auth/setup', {
        method: 'POST',
        body: JSON.stringify({
          userId: userB,
          password: 'PasswordB123!',
          displayName: 'Owner Candidate B',
          warehouseName: 'Concurrent WH B',
          warehouseCode: 'CWH-B',
          location: 'Hub B'
        })
      })
    ]);

    // Exactly one must succeed (200) and the loser must be rejected with 409 Conflict
    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [200, 409], 'One request must succeed (200) and one must fail with conflict (409)');

    const losingRes = resA.status === 409 ? resA : resB;
    assert.match(losingRes.data.error, /already exists/i, 'Losing request receives descriptive conflict error');

    // Database must have strictly ONE active boss
    const activeBosses = await db.all("SELECT user_id FROM users WHERE role = 'boss' AND active = 1");
    assert.equal(activeBosses.length, 1, 'Strictly one active boss account must exist in the database');
  } finally {
    // Clean up test candidates and restore original testboss
    await db.run("DELETE FROM users WHERE user_id IN ('concurrent_owner_a', 'concurrent_owner_b')");
    await db.run("DELETE FROM store_memberships WHERE user_id IN ('concurrent_owner_a', 'concurrent_owner_b')");
    await db.run("UPDATE users SET active = 1 WHERE user_id = 'testboss'");
    await db.run("UPDATE stores SET owner_user_id = 'testboss' WHERE id = 'store_default_001'");
  }
});

test('51. First-Time Admin OTP Activation Concurrency: Concurrent /auth/setup-admin/verify requests guarantee single owner and 409 Conflict', async () => {
  const otpService = require('../otp-service');
  const capturedOtps = {};
  otpService.setTestOtpListener(({ userId, type, otp, purpose }) => {
    if (purpose === 'admin_registration') {
      if (!capturedOtps[userId]) capturedOtps[userId] = {};
      capturedOtps[userId][type] = otp;
    }
  });

  // Temporarily deactivate boss accounts
  await db.run("UPDATE users SET active = 0 WHERE role = 'boss'");

  try {
    // Request OTP for candidate 1
    const req1 = await api('/auth/setup-admin/request', {
      method: 'POST',
      body: JSON.stringify({
        userId: 'candidate_admin_1',
        password: 'AdminPassword1!',
        displayName: 'Candidate Admin 1',
        email: 'cand1@warehouse.com',
        phone: '+919811111111',
        warehouseName: 'Hub One',
        warehouseCode: 'HB-01',
        location: 'City 1'
      })
    });
    assert.equal(req1.status, 200);

    // Request OTP for candidate 2 (both requested while active boss count is 0)
    const req2 = await api('/auth/setup-admin/request', {
      method: 'POST',
      body: JSON.stringify({
        userId: 'candidate_admin_2',
        password: 'AdminPassword2!',
        displayName: 'Candidate Admin 2',
        email: 'cand2@warehouse.com',
        phone: '+919822222222',
        warehouseName: 'Hub Two',
        warehouseCode: 'HB-02',
        location: 'City 2'
      })
    });
    assert.equal(req2.status, 200);

    assert.ok(capturedOtps['candidate_admin_1']?.email);
    assert.ok(capturedOtps['candidate_admin_1']?.phone);
    assert.ok(capturedOtps['candidate_admin_2']?.email);
    assert.ok(capturedOtps['candidate_admin_2']?.phone);

    // Both candidates now hold valid OTPs and active = 0.
    // Concurrently trigger verification and activation for both
    const [ver1, ver2] = await Promise.all([
      api('/auth/setup-admin/verify', {
        method: 'POST',
        body: JSON.stringify({
          userId: 'candidate_admin_1',
          emailOtp: capturedOtps['candidate_admin_1'].email,
          phoneOtp: capturedOtps['candidate_admin_1'].phone
        })
      }),
      api('/auth/setup-admin/verify', {
        method: 'POST',
        body: JSON.stringify({
          userId: 'candidate_admin_2',
          emailOtp: capturedOtps['candidate_admin_2'].email,
          phoneOtp: capturedOtps['candidate_admin_2'].phone
        })
      })
    ]);

    // One must succeed (200), one must be rejected (409)
    const verifyStatuses = [ver1.status, ver2.status].sort();
    assert.deepEqual(verifyStatuses, [200, 409], 'One verification must succeed (200) and the loser must receive 409 Conflict');

    const losingVerify = ver1.status === 409 ? ver1 : ver2;
    assert.match(losingVerify.data.error, /already exists|Setup is closed/i);

    // Strictly one active boss account exists
    const activeBosses = await db.all("SELECT user_id FROM users WHERE role = 'boss' AND active = 1");
    assert.equal(activeBosses.length, 1, 'Only one platform owner could be activated');
  } finally {
    otpService.setTestOtpListener(null);
    // Clean up simulated users and OTPs
    await db.run("DELETE FROM users WHERE user_id IN ('candidate_admin_1', 'candidate_admin_2')");
    await db.run("DELETE FROM user_sessions WHERE user_id IN ('candidate_admin_1', 'candidate_admin_2')");
    await db.run("DELETE FROM otp_verifications WHERE user_id IN ('candidate_admin_1', 'candidate_admin_2')");
    await db.run("DELETE FROM store_memberships WHERE user_id IN ('candidate_admin_1', 'candidate_admin_2')");
    await db.run("UPDATE users SET active = 1 WHERE user_id = 'testboss'");
    await db.run("UPDATE stores SET owner_user_id = 'testboss' WHERE id = 'store_default_001'");
  }
});
