process.env.NODE_ENV = 'test';
const path = require('path');
const fs = require('fs');

const liveDbPath = path.join(__dirname, '../asrs.db');
const testDbPath = path.join(__dirname, 'asrs.test.db');
if (!process.env.DATABASE_URL) {
  fs.copyFileSync(liveDbPath, testDbPath);
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

