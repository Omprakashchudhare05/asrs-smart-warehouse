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
    'boss'
  ]);
  bossToken = dummyToken;

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

test('5. Store and Retrieve operations validate inventory boundaries', async () => {
  const allSlots = (await api('/slots')).data;
  const sBefore = allSlots.find(s => s.quantity < s.capacity) || allSlots[1];
  const targetSlot = sBefore.slot;
  const initialQty = sBefore.quantity;

  // Store 1 unit
  const storeRes = await api('/store', {
    method: 'POST',
    body: JSON.stringify({ slot: targetSlot, quantity: 1, source: 'dashboard' })
  });
  assert.equal(storeRes.status, 200);
  assert.equal(storeRes.data.slot.quantity, initialQty + 1);

  // Retrieve 1 unit
  const retRes = await api('/retrieve', {
    method: 'POST',
    body: JSON.stringify({ slot: targetSlot, quantity: 1, source: 'dashboard' })
  });
  assert.equal(retRes.status, 200);
  assert.equal(retRes.data.slot.quantity, initialQty);

  // Attempt to retrieve excessive quantity
  const badRet = await api('/retrieve', {
    method: 'POST',
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

  // Add stock to slot E5 (outside 4x4)
  const storeE5 = await api('/store', {
    method: 'POST',
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

  // Retrieve stock from E5
  await api('/retrieve', {
    method: 'POST',
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

  // Temporarily deactivate boss to simulate first-time warehouse setup
  await db.run("UPDATE users SET active=0 WHERE user_id='testboss'");

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

  // Clean up simulated user & restore testboss
  await db.run("DELETE FROM users WHERE user_id='new_warehouse_boss'");
  await db.run("DELETE FROM otp_verifications WHERE user_id='new_warehouse_boss'");
  await db.run("UPDATE users SET active=1 WHERE user_id='testboss'");
});

test('14. Concurrency Protection: Double-clicks and simultaneous movements prevent negative stock and capacity overflow', async () => {
  // Setup slot A1 with exact known stock = 4, capacity = 10
  await db.run("UPDATE slots SET quantity = 4, occupied = 1, capacity = 10 WHERE slot = 'A1'");

  // 1. Race condition test: 5 concurrent retrievals of 2 units each (total requested = 10 units, available = 4)
  const retrievePromises = Array.from({ length: 5 }, () =>
    api('/retrieve', {
      method: 'POST',
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

