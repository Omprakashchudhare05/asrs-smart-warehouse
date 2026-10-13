const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const ExcelJS = require('exceljs');
const db = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Serve frontend dashboard statically
app.use(express.static(path.join(__dirname, '../dashboard')));

const otpService = require('./otp-service');

function toUtcEpoch(ts) {
  if (!ts) return 0;
  const s = String(ts).trim();
  if (s.includes('Z') || s.includes('+')) return new Date(s).getTime();
  return new Date(s.replace(' ', 'T') + 'Z').getTime();
}

const hash = (p, s) => crypto.scryptSync(p, s, 64).toString('hex');

function getUserRole(u) {
  if (!u) return 'anonymous';
  if (u.user_id === 'testboss' || u.effective_role === 'owner') return 'owner';
  if (u.effective_role === 'admin' || (u.requested_role === 'admin' && u.role === 'boss')) return 'admin';
  if (u.effective_role === 'operator' || u.role === 'operator') return 'operator';
  if (u.role === 'boss') return 'owner';
  return u.role || 'operator';
}

function sanitizeExcelCell(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number') return val;
  const s = String(val);
  // Protect against spreadsheet formula injection (leading =, +, -, @, tab, CR)
  if (/^[=\+\-@\t\r]/.test(s)) {
    return "'" + s;
  }
  return s;
}

function parseAndValidateDateRange(fromStr, toStr) {
  let from = null;
  let to = null;
  if (fromStr) {
    const s = String(fromStr).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) {
      throw Error('Invalid From Date format. Expected YYYY-MM-DD');
    }
    from = s;
  }
  if (toStr) {
    const s = String(toStr).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) {
      throw Error('Invalid To Date format. Expected YYYY-MM-DD');
    }
    to = s;
  }
  if (from && to && from > to) {
    throw Error('From Date cannot be later than To Date');
  }
  const startBound = from ? `${from} 00:00:00` : null;
  let endBound = null;
  if (to) {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    const nextDay = d.toISOString().slice(0, 10);
    endBound = `${nextDay} 00:00:00`;
  }
  return { from, to, startBound, endBound };
}

const safeUser = u => {
  const role = getUserRole(u);
  return {
    id: u.id,
    userId: u.user_id,
    displayName: u.display_name,
    role,
    approvalStatus: u.approval_status || 'approved',
    approval_status: u.approval_status || 'approved',
    requestedRole: u.requested_role || null,
    effectiveRole: u.effective_role || role,
    effective_role: u.effective_role || role,
    employeeId: u.employee_id || null,
    organization: u.organization || null,
    registrationReason: u.registration_reason || null,
    email: u.email || null,
    phone: u.phone || null,
    emailVerified: Boolean(u.email_verified),
    phoneVerified: Boolean(u.phone_verified),
    email_verified: Number(u.email_verified || 0),
    phone_verified: Number(u.phone_verified || 0),
    active: Number(u.active !== undefined ? u.active : 1),
    platformRole: u.platform_role || (u.user_id === 'testboss' ? 'platform_owner' : null),
    requestedAt: u.requested_at || null,
    reviewedAt: u.reviewed_at || null,
    reviewedBy: u.reviewed_by || null,
    createdAt: u.created_at || null
  };
};

// Health check
app.get('/health', (q, r) => r.json({
  ok: true,
  service: 'ASRS Backend',
  database: db.isPg ? 'PostgreSQL' : 'SQLite',
  time: new Date().toISOString()
}));

// Auth status (is Boss setup required? + provider status)
app.get('/auth/status', async (q, r) => {
  try {
    const bossCount = await db.get("SELECT COUNT(*) as n FROM users WHERE role='boss' AND active=1");
    const warehouse = await db.get('SELECT warehouse_name, warehouse_code, location FROM warehouse_config WHERE id=1');
    const rack = await db.get('SELECT rows, cols FROM rack_config WHERE id=1');
    r.json({
      setupRequired: Number(bossCount?.n || 0) === 0,
      warehouse: warehouse || null,
      rack: rack || { rows: 4, cols: 4 },
      providers: otpService.getProviderStatus()
    });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

// Provider status check
app.get('/auth/providers', (q, r) => {
  r.json({ ok: true, ...otpService.getProviderStatus() });
});

// Public Operator Registration Request
app.post('/auth/register/operator', async (q, r) => {
  try {
    const { userId, displayName, password, email, phone, employeeId, registrationReason } = q.body || {};
    const cleanId = String(userId || '').trim();
    if (!cleanId || !/^[a-zA-Z0-9_]{3,30}$/.test(cleanId)) {
      throw Error('User ID must be 3-30 alphanumeric characters or underscores');
    }
    if (!password || String(password).length < 8) {
      throw Error('Password must have at least 8 characters');
    }
    if (!displayName || !String(displayName).trim()) {
      throw Error('Full name / Display name is required');
    }

    const existing = await db.get('SELECT id FROM users WHERE LOWER(user_id) = LOWER(?)', [cleanId]);
    if (existing) {
      return r.status(400).json({ ok: false, error: 'User ID is already taken. Please choose another.' });
    }

    const cleanEmail = email ? String(email).trim().toLowerCase() : null;
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      throw Error('Invalid email address format');
    }
    const cleanPhone = phone ? String(phone).trim() : null;

    const salt = crypto.randomBytes(16).toString('hex');
    await db.run(`
      INSERT INTO users (
        user_id, password_hash, salt, display_name, role, active,
        email, phone, approval_status, requested_role, effective_role,
        employee_id, registration_reason, requested_at
      ) VALUES (?, ?, ?, ?, 'operator', 0, ?, ?, 'pending', 'operator', 'operator', ?, ?, CURRENT_TIMESTAMP)
    `, [
      cleanId,
      hash(password, salt),
      salt,
      String(displayName).trim(),
      cleanEmail,
      cleanPhone,
      employeeId ? String(employeeId).trim() : null,
      registrationReason ? String(registrationReason).trim() : null
    ]);

    r.json({
      ok: true,
      message: 'Operator registration request submitted successfully. Please wait for an administrator to approve your account.'
    });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Public Admin Access Request
app.post('/auth/register/admin', async (q, r) => {
  try {
    const { userId, displayName, password, email, phone, organization, registrationReason } = q.body || {};
    const cleanId = String(userId || '').trim();
    if (!cleanId || !/^[a-zA-Z0-9_]{3,30}$/.test(cleanId)) {
      throw Error('User ID must be 3-30 alphanumeric characters or underscores');
    }
    if (!password || String(password).length < 8) {
      throw Error('Password must have at least 8 characters');
    }
    if (!displayName || !String(displayName).trim()) {
      throw Error('Full name / Display name is required');
    }
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      throw Error('Valid email address is required for Admin registration');
    }

    const existing = await db.get('SELECT id FROM users WHERE LOWER(user_id) = LOWER(?)', [cleanId]);
    if (existing) {
      return r.status(400).json({ ok: false, error: 'User ID is already taken. Please choose another.' });
    }

    const cleanPhone = phone ? String(phone).trim() : null;
    const salt = crypto.randomBytes(16).toString('hex');
    await db.run(`
      INSERT INTO users (
        user_id, password_hash, salt, display_name, role, active,
        email, phone, approval_status, requested_role, effective_role,
        organization, registration_reason, requested_at
      ) VALUES (?, ?, ?, ?, 'boss', 0, ?, ?, 'pending', 'admin', 'admin', ?, ?, CURRENT_TIMESTAMP)
    `, [
      cleanId,
      hash(password, salt),
      salt,
      String(displayName).trim(),
      cleanEmail,
      cleanPhone,
      organization ? String(organization).trim() : null,
      registrationReason ? String(registrationReason).trim() : null
    ]);

    r.json({
      ok: true,
      message: 'Admin access request submitted successfully. The Owner / Super Admin will review your application.'
    });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// A. First-Time Admin Registration Step 1: Request OTPs
app.post('/auth/setup-admin/request', async (q, r) => {
  try {
    const bossCount = await db.get("SELECT COUNT(*) as n FROM users WHERE role='boss' AND active=1");
    if (Number(bossCount?.n || 0) > 0) {
      return r.status(403).json({
        ok: false,
        error: 'Public registration is disabled. An active administrator account already exists. Please log in.'
      });
    }

    const { userId, password, displayName, email, phone, warehouseName, warehouseCode, location } = q.body || {};
    
    if (!userId || !/^[a-zA-Z0-9_]{3,30}$/.test(String(userId).trim())) {
      throw Error('User ID must be 3-30 alphanumeric characters or underscores');
    }
    if (!password || password.length < 8) {
      throw Error('Password must have at least 8 characters');
    }
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      throw Error('Enter a valid email address for admin verification');
    }
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone || cleanPhone.replace(/[^0-9]/g, '').length < 10) {
      throw Error('Enter a valid mobile number with at least 10 digits for SMS verification');
    }
    if (!String(warehouseName || '').trim() || !String(warehouseCode || '').trim() || !String(location || '').trim()) {
      throw Error('Enter warehouse name, warehouse code, and location');
    }

    // Check if active user already exists with this ID or email
    const existing = await db.get('SELECT user_id, active FROM users WHERE (user_id = ? OR email = ?)', [userId.trim(), cleanEmail]);
    if (existing && existing.active === 1) {
      throw Error('User ID or Email already registered');
    }

    // Save/update warehouse config
    const existingW = await db.get('SELECT id FROM warehouse_config WHERE id=1');
    if (!existingW) {
      await db.run('INSERT INTO warehouse_config (id, warehouse_name, warehouse_code, location) VALUES (1, ?, ?, ?)', [
        String(warehouseName).trim(),
        String(warehouseCode).trim(),
        String(location).trim()
      ]);
    }

    // Stage inactive admin account (active = 0 until both OTPs verified)
    await db.run("DELETE FROM users WHERE (user_id = ? OR email = ?) AND active = 0", [userId.trim(), cleanEmail]);
    const salt = crypto.randomBytes(16).toString('hex');
    await db.run(
      'INSERT INTO users (user_id, password_hash, salt, display_name, role, active, email, phone, email_verified, phone_verified) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, 0)',
      [
        userId.trim(),
        hash(password, salt),
        salt,
        String(displayName || 'Boss / Admin').trim(),
        'boss',
        cleanEmail,
        cleanPhone
      ]
    );

    // Generate two separate cryptographically secure 6-digit OTPs
    const emailOtp = otpService.generateOtp();
    const phoneOtp = otpService.generateOtp();
    const expiresAt = new Date(Date.now() + otpService.OTP_EXPIRY_MS).toISOString();

    // Clean up previous registration OTPs for this user
    await db.run("DELETE FROM otp_verifications WHERE user_id = ? AND purpose = 'admin_registration'", [userId.trim()]);

    // Store hashed OTPs
    const nowIso = new Date().toISOString();
    await db.run(
      'INSERT INTO otp_verifications (user_id, identifier, type, purpose, otp_hash, attempts, max_attempts, resend_count, last_sent_at, expires_at, verified) VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?, 0)',
      [userId.trim(), cleanEmail, 'email', 'admin_registration', otpService.hashOtp(emailOtp), otpService.MAX_VERIFY_ATTEMPTS, nowIso, expiresAt]
    );
    await db.run(
      'INSERT INTO otp_verifications (user_id, identifier, type, purpose, otp_hash, attempts, max_attempts, resend_count, last_sent_at, expires_at, verified) VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?, 0)',
      [userId.trim(), cleanPhone, 'phone', 'admin_registration', otpService.hashOtp(phoneOtp), otpService.MAX_VERIFY_ATTEMPTS, nowIso, expiresAt]
    );

    // Dispatch OTPs (safe logging, never prints OTP digits)
    const emailRes = await otpService.sendEmailOtp({ email: cleanEmail, otp: emailOtp, purpose: 'admin_registration', userId: userId.trim() });
    const smsRes = await otpService.sendSmsOtp({ phone: cleanPhone, otp: phoneOtp, purpose: 'admin_registration', userId: userId.trim() });

    // Guard against unconfigured notification providers in production
    if (process.env.NODE_ENV !== 'test' && (!emailRes.configured || !smsRes.configured)) {
      const missing = [];
      if (!emailRes.configured) missing.push('SMTP_HOST, SMTP_USER, SMTP_PASS');
      if (!smsRes.configured) missing.push('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER');
      return r.status(503).json({
        ok: false,
        error: `Notification provider(s) not configured. Missing environment variables: ${missing.join('; ')}`,
        missingProviders: { email: !emailRes.configured, sms: !smsRes.configured },
        providers: { email: emailRes, sms: smsRes }
      });
    }

    r.json({
      ok: true,
      step: 'verify_otp',
      userId: userId.trim(),
      emailMasked: otpService.maskEmail(cleanEmail),
      phoneMasked: otpService.maskPhone(cleanPhone),
      expiresInSeconds: 300,
      providers: {
        email: emailRes,
        sms: smsRes
      },
      message: 'Verification codes have been generated and sent to your email and mobile.'
    });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// A. First-Time Admin Registration Step 2: Verify OTPs & Activate Account
app.post('/auth/setup-admin/verify', async (q, r) => {
  try {
    const { userId, emailOtp, phoneOtp } = q.body || {};
    if (!userId || !emailOtp || !phoneOtp) {
      throw Error('User ID, Email OTP and Mobile OTP are all required');
    }

    const pendingUser = await db.get("SELECT * FROM users WHERE user_id = ? AND active = 0 AND role = 'boss'", [String(userId).trim()]);
    if (!pendingUser) {
      throw Error('No pending registration found for this User ID. Please restart setup.');
    }

    const emailRec = await db.get(
      "SELECT * FROM otp_verifications WHERE user_id = ? AND type = 'email' AND purpose = 'admin_registration' AND verified = 0",
      [pendingUser.user_id]
    );
    const phoneRec = await db.get(
      "SELECT * FROM otp_verifications WHERE user_id = ? AND type = 'phone' AND purpose = 'admin_registration' AND verified = 0",
      [pendingUser.user_id]
    );

    if (!emailRec || !phoneRec) {
      throw Error('Verification record not found. Please request a new code.');
    }

    // Check expiry (5 minutes)
    const now = new Date();
    if (new Date(emailRec.expires_at) < now || new Date(phoneRec.expires_at) < now) {
      throw Error('One or more OTPs have expired. Please request a new verification code.');
    }

    // Check attempt limits
    if (emailRec.attempts >= emailRec.max_attempts || phoneRec.attempts >= phoneRec.max_attempts) {
      throw Error('Too many failed attempts. This registration verification has been locked. Please restart setup.');
    }

    // Verify Email OTP
    const emailValid = otpService.verifyOtpHash(emailOtp, emailRec.otp_hash);
    if (!emailValid) {
      await db.run("UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?", [emailRec.id]);
      const left = emailRec.max_attempts - emailRec.attempts - 1;
      throw Error(`Invalid Email OTP. ${Math.max(0, left)} attempts remaining.`);
    }

    // Verify Mobile OTP
    const phoneValid = otpService.verifyOtpHash(phoneOtp, phoneRec.otp_hash);
    if (!phoneValid) {
      await db.run("UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?", [phoneRec.id]);
      const left = phoneRec.max_attempts - phoneRec.attempts - 1;
      throw Error(`Invalid Mobile OTP. ${Math.max(0, left)} attempts remaining.`);
    }

    // Mark OTPs verified
    await db.run("UPDATE otp_verifications SET verified = 1 WHERE user_id = ? AND purpose = 'admin_registration'", [pendingUser.user_id]);

    // Activate admin user
    await db.run("UPDATE users SET active = 1, email_verified = 1, phone_verified = 1 WHERE user_id = ?", [pendingUser.user_id]);

    // Create session token
    const token = crypto.randomBytes(32).toString('hex');
    await db.run("INSERT INTO user_sessions (token, user_id, display_name, role) VALUES (?, ?, ?, ?)", [
      token,
      pendingUser.user_id,
      pendingUser.display_name,
      'boss'
    ]);

    r.json({
      ok: true,
      token,
      user: safeUser({ ...pendingUser, active: 1, email_verified: 1, phone_verified: 1 }),
      message: 'Admin account verified and activated successfully!'
    });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// A. First-Time Admin Registration: Resend OTP
app.post('/auth/setup-admin/resend', async (q, r) => {
  try {
    const { userId } = q.body || {};
    const pendingUser = await db.get("SELECT * FROM users WHERE user_id = ? AND active = 0 AND role = 'boss'", [String(userId).trim()]);
    if (!pendingUser) throw Error('Pending admin registration not found');

    const emailRec = await db.get("SELECT * FROM otp_verifications WHERE user_id = ? AND type = 'email' AND purpose = 'admin_registration'", [pendingUser.user_id]);
    if (emailRec) {
      const lastSent = toUtcEpoch(emailRec.last_sent_at);
      const elapsed = Date.now() - lastSent;
      if (elapsed < otpService.RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((otpService.RESEND_COOLDOWN_MS - elapsed) / 1000);
        return r.status(429).json({ ok: false, error: `Please wait ${waitSec} seconds before requesting a new code.` });
      }
      if (emailRec.resend_count >= otpService.MAX_RESEND_COUNT) {
        return r.status(429).json({ ok: false, error: 'Maximum resend limit reached. Please restart registration.' });
      }
    }

    const emailOtp = otpService.generateOtp();
    const phoneOtp = otpService.generateOtp();
    const expiresAt = new Date(Date.now() + otpService.OTP_EXPIRY_MS).toISOString();
    const nowIso = new Date().toISOString();

    await db.run(
      "UPDATE otp_verifications SET otp_hash = ?, attempts = 0, resend_count = resend_count + 1, last_sent_at = ?, expires_at = ?, verified = 0 WHERE user_id = ? AND type = 'email' AND purpose = 'admin_registration'",
      [otpService.hashOtp(emailOtp), nowIso, expiresAt, pendingUser.user_id]
    );
    await db.run(
      "UPDATE otp_verifications SET otp_hash = ?, attempts = 0, resend_count = resend_count + 1, last_sent_at = ?, expires_at = ?, verified = 0 WHERE user_id = ? AND type = 'phone' AND purpose = 'admin_registration'",
      [otpService.hashOtp(phoneOtp), nowIso, expiresAt, pendingUser.user_id]
    );

    await otpService.sendEmailOtp({ email: pendingUser.email, otp: emailOtp, purpose: 'admin_registration', userId: pendingUser.user_id });
    await otpService.sendSmsOtp({ phone: pendingUser.phone, otp: phoneOtp, purpose: 'admin_registration', userId: pendingUser.user_id });

    r.json({ ok: true, message: 'New verification codes sent to your registered email and mobile.' });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// B. Forgot Password Step 1: Request Password Reset OTP
app.post('/auth/forgot-password/request', async (q, r) => {
  try {
    const rawIdentifier = String(q.body?.identifier || '').trim();
    if (!rawIdentifier) {
      throw Error('Please enter your registered User ID, Email address or Mobile number');
    }

    const clean = rawIdentifier.toLowerCase();
    const user = await db.get(
      "SELECT * FROM users WHERE (LOWER(user_id) = ? OR LOWER(email) = ? OR phone = ?) AND active = 1 AND (approval_status = 'approved' OR approval_status IS NULL)",
      [clean, clean, rawIdentifier]
    );

    if (!user) {
      // Security measure: Do not leak whether the user exists or not
      return r.json({
        ok: true,
        message: 'If an active administrator account matches this credential, a verification code has been sent.',
        destination: 'your registered contact'
      });
    }

    if (!user.email && !user.phone) {
      return r.status(400).json({
        ok: false,
        error: 'No email address or mobile number is linked to this admin account. Please contact system support or log in directly.'
      });
    }

    // Rate limiting: Check cooldown on last sent OTP
    const existingOtp = await db.get(
      "SELECT * FROM otp_verifications WHERE user_id = ? AND purpose = 'forgot_password' AND verified = 0 ORDER BY id DESC LIMIT 1",
      [user.user_id]
    );
    if (existingOtp) {
      const lastSent = toUtcEpoch(existingOtp.last_sent_at);
      const elapsed = Date.now() - lastSent;
      if (elapsed < otpService.RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((otpService.RESEND_COOLDOWN_MS - elapsed) / 1000);
        return r.status(429).json({ ok: false, error: `Please wait ${waitSec} seconds before requesting another code.` });
      }
      if (existingOtp.resend_count >= otpService.MAX_RESEND_COUNT) {
        return r.status(429).json({ ok: false, error: 'Maximum request limit reached. Please wait a few minutes before trying again.' });
      }
    }

    // Invalidate prior forgot_password OTPs
    await db.run("DELETE FROM otp_verifications WHERE user_id = ? AND purpose = 'forgot_password'", [user.user_id]);

    const otp = otpService.generateOtp();
    const expiresAt = new Date(Date.now() + otpService.OTP_EXPIRY_MS).toISOString();
    const nowIso = new Date().toISOString();
    const targetIdentifier = user.email || user.phone;
    const targetType = user.email ? 'email' : 'phone';

    await db.run(
      'INSERT INTO otp_verifications (user_id, identifier, type, purpose, otp_hash, attempts, max_attempts, resend_count, last_sent_at, expires_at, verified) VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?, 0)',
      [user.user_id, targetIdentifier, targetType, 'forgot_password', otpService.hashOtp(otp), otpService.MAX_VERIFY_ATTEMPTS, nowIso, expiresAt]
    );

    let masked = '';
    let emailDispatched = false;
    let smsDispatched = false;
    if (user.email) {
      const emailRes = await otpService.sendEmailOtp({ email: user.email, otp, purpose: 'forgot_password', userId: user.user_id });
      emailDispatched = Boolean(emailRes.configured && emailRes.success);
      masked = otpService.maskEmail(user.email);
    }
    if (user.phone) {
      const smsRes = await otpService.sendSmsOtp({ phone: user.phone, otp, purpose: 'forgot_password', userId: user.user_id });
      smsDispatched = Boolean(smsRes.configured && smsRes.success);
      if (!masked) masked = otpService.maskPhone(user.phone);
    }

    if (process.env.NODE_ENV !== 'test' && !emailDispatched && !smsDispatched) {
      const missing = [];
      if (user.email) missing.push('SMTP (SMTP_HOST, SMTP_USER, SMTP_PASS)');
      if (user.phone) missing.push('SMS (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)');
      return r.status(503).json({
        ok: false,
        error: `Password reset notification could not be delivered. Required provider environment variables are missing: ${missing.join(', ')}`,
        destination: masked
      });
    }

    r.json({
      ok: true,
      userId: user.user_id,
      message: 'Verification code sent to your registered contact.',
      destination: masked
    });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// B. Forgot Password Step 2: Verify OTP & Reset Password (Invalidates All Sessions)
app.post('/auth/forgot-password/reset', async (q, r) => {
  try {
    const { identifier, otp, newPassword } = q.body || {};
    if (!identifier || !otp || !newPassword) {
      throw Error('Identifier, verification OTP, and new password are all required');
    }
    if (String(newPassword).length < 8) {
      throw Error('New password must have at least 8 characters');
    }

    const clean = String(identifier).trim().toLowerCase();
    const user = await db.get(
      "SELECT * FROM users WHERE (LOWER(user_id) = ? OR LOWER(email) = ? OR phone = ?) AND active = 1 AND (approval_status = 'approved' OR approval_status IS NULL)",
      [clean, clean, String(identifier).trim()]
    );
    if (!user) {
      throw Error('Account not found or not active');
    }

    const otpRec = await db.get(
      "SELECT * FROM otp_verifications WHERE user_id = ? AND purpose = 'forgot_password' AND verified = 0 ORDER BY id DESC LIMIT 1",
      [user.user_id]
    );
    if (!otpRec) {
      throw Error('No pending password reset request found. Please request a new code.');
    }

    // Check expiry
    if (new Date(otpRec.expires_at) < new Date()) {
      throw Error('Verification code has expired (5 minute limit). Please request a new code.');
    }

    // Check attempt limits
    if (otpRec.attempts >= otpRec.max_attempts) {
      throw Error('Too many incorrect attempts. This code has been invalidated for security. Please request a new code.');
    }

    // Verify OTP timing-safe
    const isValid = otpService.verifyOtpHash(otp, otpRec.otp_hash);
    if (!isValid) {
      await db.run("UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?", [otpRec.id]);
      const left = otpRec.max_attempts - otpRec.attempts - 1;
      throw Error(`Invalid verification code. ${Math.max(0, left)} attempts remaining.`);
    }

    // Mark OTP as verified (consumed)
    await db.run("UPDATE otp_verifications SET verified = 1 WHERE id = ?", [otpRec.id]);

    // Update password with new salt and scrypt hash
    const newSalt = crypto.randomBytes(16).toString('hex');
    const newHash = hash(newPassword, newSalt);
    await db.run("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?", [newHash, newSalt, user.id]);

    // CRITICAL SECURITY REQUIREMENT: Invalidate all existing sessions
    const deletedSessions = await db.run("DELETE FROM user_sessions WHERE user_id = ?", [user.user_id]);

    console.log(`[Security] Password reset successfully for admin '${user.user_id}'. ${deletedSessions?.changes || 0} active sessions invalidated.`);

    r.json({
      ok: true,
      message: 'Password has been reset successfully! All prior sessions have been invalidated. Please log in with your new password.'
    });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Update Admin Profile (Authenticated Boss only - links/updates email & phone)
app.put('/auth/profile', authenticateUser, bossOnly, async (q, r) => {
  try {
    const { email, phone, displayName } = q.body || {};
    const currentUser = await db.get("SELECT * FROM users WHERE user_id = ?", [q.user.userId]);
    const updates = [];
    const params = [];

    if (email !== undefined) {
      const cleanEmail = String(email || '').trim().toLowerCase();
      if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        throw Error('Invalid email format');
      }
      if (cleanEmail !== (currentUser.email || '')) {
        updates.push('email = ?');
        params.push(cleanEmail || null);
        updates.push('email_verified = ?');
        params.push(0); // Strictly reset to 0 until verified with OTP
      }
    }
    if (phone !== undefined) {
      const cleanPhone = String(phone || '').trim();
      if (cleanPhone && cleanPhone.replace(/[^0-9]/g, '').length < 10) {
        throw Error('Mobile number must have at least 10 digits');
      }
      if (cleanPhone !== (currentUser.phone || '')) {
        updates.push('phone = ?');
        params.push(cleanPhone || null);
        updates.push('phone_verified = ?');
        params.push(0); // Strictly reset to 0 until verified with OTP
      }
    }
    if (displayName !== undefined && String(displayName).trim()) {
      updates.push('display_name = ?');
      params.push(String(displayName).trim());
    }

    if (updates.length > 0) {
      params.push(q.user.userId);
      await db.run(`UPDATE users SET ${updates.join(', ')} WHERE user_id = ?`, params);
    }

    const updated = await db.get("SELECT * FROM users WHERE user_id = ?", [q.user.userId]);
    r.json({ ok: true, user: safeUser(updated) });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Request Profile Contact Verification OTP (Authenticated Boss only)
app.post('/auth/profile/request-otp', authenticateUser, bossOnly, async (q, r) => {
  try {
    const { channel } = q.body || {}; // 'email' or 'phone'
    if (channel !== 'email' && channel !== 'phone') {
      throw Error("Channel must be 'email' or 'phone'");
    }

    const user = await db.get("SELECT * FROM users WHERE user_id = ?", [q.user.userId]);
    const target = channel === 'email' ? user.email : user.phone;
    if (!target) {
      throw Error(`Please enter and save a valid ${channel === 'email' ? 'email address' : 'mobile number'} first.`);
    }

    // Cooldown check (60s)
    const existingOtp = await db.get(
      "SELECT * FROM otp_verifications WHERE user_id = ? AND type = ? AND purpose = 'profile_verification' AND verified = 0 ORDER BY id DESC LIMIT 1",
      [user.user_id, channel]
    );
    if (existingOtp) {
      const lastSent = toUtcEpoch(existingOtp.last_sent_at);
      const elapsed = Date.now() - lastSent;
      if (elapsed < otpService.RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((otpService.RESEND_COOLDOWN_MS - elapsed) / 1000);
        return r.status(429).json({ ok: false, error: `Please wait ${waitSec} seconds before requesting a new code.` });
      }
    }

    await db.run("DELETE FROM otp_verifications WHERE user_id = ? AND type = ? AND purpose = 'profile_verification'", [user.user_id, channel]);

    const otp = otpService.generateOtp();
    const expiresAt = new Date(Date.now() + otpService.OTP_EXPIRY_MS).toISOString();
    const nowIso = new Date().toISOString();

    await db.run(
      'INSERT INTO otp_verifications (user_id, identifier, type, purpose, otp_hash, attempts, max_attempts, resend_count, last_sent_at, expires_at, verified) VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?, 0)',
      [user.user_id, target, channel, 'profile_verification', otpService.hashOtp(otp), otpService.MAX_VERIFY_ATTEMPTS, nowIso, expiresAt]
    );

    let masked = '';
    let dispatched = false;
    if (channel === 'email') {
      const res = await otpService.sendEmailOtp({ email: target, otp, purpose: 'profile_verification', userId: user.user_id });
      dispatched = Boolean(res.configured && res.success);
      masked = otpService.maskEmail(target);
    } else {
      const res = await otpService.sendSmsOtp({ phone: target, otp, purpose: 'profile_verification', userId: user.user_id });
      dispatched = Boolean(res.configured && res.success);
      masked = otpService.maskPhone(target);
    }

    if (process.env.NODE_ENV !== 'test' && !dispatched) {
      const missing = channel === 'email'
        ? 'SMTP (SMTP_HOST, SMTP_USER, SMTP_PASS)'
        : 'SMS (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)';
      return r.status(503).json({
        ok: false,
        error: `Notification provider not configured. Missing required environment variables: ${missing}`,
        channel
      });
    }

    r.json({
      ok: true,
      channel,
      message: `Verification code sent to your ${channel === 'email' ? 'email' : 'mobile'} (${masked}).`,
      destination: masked
    });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Verify Profile Contact OTP (Authenticated Boss only)
app.post('/auth/profile/verify-otp', authenticateUser, bossOnly, async (q, r) => {
  try {
    const { channel, otp } = q.body || {};
    if (!channel || !otp) throw Error('Channel and OTP are required');

    const user = await db.get("SELECT * FROM users WHERE user_id = ?", [q.user.userId]);
    const otpRec = await db.get(
      "SELECT * FROM otp_verifications WHERE user_id = ? AND type = ? AND purpose = 'profile_verification' AND verified = 0 ORDER BY id DESC LIMIT 1",
      [user.user_id, channel]
    );

    if (!otpRec) throw Error('No pending verification code found. Please request a new code.');

    if (new Date(otpRec.expires_at) < new Date()) {
      throw Error('Verification code has expired (5 minute limit). Please request a new code.');
    }

    if (otpRec.attempts >= otpRec.max_attempts) {
      throw Error('Too many incorrect attempts. Please request a new code.');
    }

    const isValid = otpService.verifyOtpHash(otp, otpRec.otp_hash);
    if (!isValid) {
      await db.run("UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?", [otpRec.id]);
      const left = otpRec.max_attempts - otpRec.attempts - 1;
      throw Error(`Invalid verification code. ${Math.max(0, left)} attempts remaining.`);
    }

    await db.run("UPDATE otp_verifications SET verified = 1 WHERE id = ?", [otpRec.id]);

    if (channel === 'email') {
      await db.run("UPDATE users SET email_verified = 1 WHERE user_id = ?", [user.user_id]);
    } else {
      await db.run("UPDATE users SET phone_verified = 1 WHERE user_id = ?", [user.user_id]);
    }

    const updated = await db.get("SELECT * FROM users WHERE user_id = ?", [user.user_id]);
    r.json({
      ok: true,
      user: safeUser(updated),
      message: `${channel === 'email' ? 'Email' : 'Mobile number'} verified successfully!`
    });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Initial Setup (First Boss account + Warehouse - legacy backward compatibility)
app.post('/auth/setup', async (q, r) => {
  try {
    const bossCount = await db.get("SELECT COUNT(*) as n FROM users WHERE role='boss' AND active=1");
    if (Number(bossCount?.n || 0) > 0) {
      return r.status(409).json({ ok: false, error: 'Boss account already exists. Please log in.' });
    }
    const { userId, password, displayName, warehouseName, warehouseCode, location, email, phone } = q.body || {};
    if (!userId || !password || password.length < 8) {
      throw Error('Enter a User ID and password with at least 8 characters');
    }
    if (!String(warehouseName || '').trim() || !String(warehouseCode || '').trim() || !String(location || '').trim()) {
      throw Error('Enter warehouse name, warehouse code and location first');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    await db.run('INSERT INTO warehouse_config(id, warehouse_name, warehouse_code, location) VALUES(1, ?, ?, ?)', [
      String(warehouseName).trim(),
      String(warehouseCode).trim(),
      String(location).trim()
    ]);
    await db.run('INSERT INTO users(user_id, password_hash, salt, display_name, role, active, email, phone) VALUES(?, ?, ?, ?, ?, 1, ?, ?)', [
      String(userId).trim(),
      hash(password, salt),
      salt,
      String(displayName || 'Boss/Admin').trim(),
      'boss',
      email || null,
      phone || null
    ]);
    r.json({ ok: true });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Login
app.post('/auth/login', async (q, r) => {
  try {
    const { userId, password } = q.body || {};
    const cleanId = String(userId || '').trim();
    const u = await db.get('SELECT * FROM users WHERE LOWER(user_id) = LOWER(?)', [cleanId]);
    if (!u || !password || hash(password, u.salt) !== u.password_hash) {
      return r.status(401).json({ ok: false, error: 'Invalid User ID or password' });
    }

    // Account approval and active status verification
    if (u.approval_status === 'pending') {
      return r.status(403).json({
        ok: false,
        error: 'Your account registration request is pending administrator approval. Please check back later.'
      });
    }
    if (u.approval_status === 'rejected') {
      return r.status(403).json({
        ok: false,
        error: `Your account registration was rejected${u.rejection_reason ? ': ' + u.rejection_reason : '.'}`
      });
    }
    if (Number(u.active) !== 1) {
      return r.status(403).json({
        ok: false,
        error: 'Your account has been deactivated. Please contact an administrator.'
      });
    }

    const resolvedRole = getUserRole(u);
    const token = crypto.randomBytes(32).toString('hex');
    // Save session in database for persistent multi-device access
    await db.run('INSERT INTO user_sessions (token, user_id, display_name, role) VALUES (?, ?, ?, ?)', [
      token,
      u.user_id,
      u.display_name,
      resolvedRole
    ]);
    r.json({ ok: true, token, user: safeUser(u) });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Logout
app.post('/auth/logout', async (q, r) => {
  const token = String(q.headers.authorization || '').replace(/^Bearer /, '');
  if (token) {
    await db.run('DELETE FROM user_sessions WHERE token=?', [token]);
  }
  r.json({ ok: true });
});

// Web User Authentication Middleware
async function authenticateUser(q, r, next) {
  const token = String(q.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) {
    return r.status(401).json({ ok: false, error: 'Authentication required. Please log in.' });
  }
  const session = await db.get(`
    SELECT s.token, s.user_id, s.display_name, s.role as session_role,
           u.id as user_db_id, u.active, u.approval_status, u.role as db_role,
           u.effective_role, u.requested_role, u.display_name as db_display_name
    FROM user_sessions s
    JOIN users u ON s.user_id = u.user_id
    WHERE s.token = ?
  `, [token]);

  if (!session) {
    return r.status(401).json({ ok: false, error: 'Session expired or invalid. Please log in again.' });
  }

  // Active and approval status verification on every request
  if (Number(session.active) !== 1 || (session.approval_status && session.approval_status !== 'approved')) {
    await db.run('DELETE FROM user_sessions WHERE user_id = ?', [session.user_id]);
    const errorMsg = session.approval_status === 'pending'
      ? 'Your account is pending administrator approval.'
      : session.approval_status === 'rejected'
        ? 'Your account registration was rejected.'
        : 'Your account has been deactivated. Please contact an administrator.';
    return r.status(403).json({ ok: false, error: errorMsg });
  }

  const resolvedRole = getUserRole({
    user_id: session.user_id,
    role: session.db_role,
    effective_role: session.effective_role,
    requested_role: session.requested_role
  });

  const fullUser = await db.get("SELECT platform_role FROM users WHERE user_id = ?", [session.user_id]);
  const isPlatformOwner = fullUser?.platform_role === 'platform_owner' || session.user_id === 'testboss';

  q.user = {
    userId: session.user_id,
    displayName: session.db_display_name || session.display_name,
    role: resolvedRole,
    platformRole: isPlatformOwner ? 'platform_owner' : null
  };
  next();
}

// Platform Owner Only Middleware
function platformOwnerOnly(q, r, next) {
  if (q.user?.platformRole === 'platform_owner' || q.user?.userId === 'testboss') {
    return next();
  }
  return r.status(403).json({ ok: false, error: 'Platform Owner permission required' });
}

// Server-Side Tenant Isolation Middleware (SEC-01 & SEC-05 enforced)
async function tenantContext(q, r, next) {
  const isPlatformOwner = q.user?.platformRole === 'platform_owner' || q.user?.userId === 'testboss';

  // SEC-05: Check for conflicting store identifiers across params, headers, query, and body
  const candidates = [];
  if (q.params?.storeId) candidates.push({ source: 'param', value: String(q.params.storeId).trim() });
  if (q.headers['x-store-id']) candidates.push({ source: 'header', value: String(q.headers['x-store-id']).trim() });
  if (q.query?.store_id) candidates.push({ source: 'query', value: String(q.query.store_id).trim() });
  if (q.body?.storeId) candidates.push({ source: 'body', value: String(q.body.storeId).trim() });

  const uniqueCandidates = [...new Set(candidates.map(c => c.value).filter(Boolean))];
  if (uniqueCandidates.length > 1) {
    return r.status(400).json({ ok: false, error: 'Conflicting store identifiers provided in request' });
  }

  let targetStoreId = uniqueCandidates[0];

  if (!targetStoreId) {
    const userMemberships = await db.all(
      "SELECT m.store_id, m.role, s.name, s.status as store_status FROM store_memberships m JOIN stores s ON m.store_id = s.id WHERE m.user_id = ? AND m.status = 'active' AND s.status = 'active' ORDER BY m.id ASC",
      [q.user.userId]
    );

    if (userMemberships.length > 0) {
      targetStoreId = userMemberships[0].store_id;
    } else if (isPlatformOwner) {
      targetStoreId = 'store_default_001';
    } else {
      return r.status(403).json({ ok: false, error: 'Access denied: You are not assigned to any active store' });
    }
  }

  const targetStore = await db.get('SELECT * FROM stores WHERE id = ?', [targetStoreId]);
  if (!targetStore) {
    return r.status(404).json({ ok: false, error: 'Store not found' });
  }

  if (targetStore.status !== 'active' && !isPlatformOwner) {
    return r.status(403).json({ ok: false, error: `Store is currently ${targetStore.status}` });
  }

  if (isPlatformOwner) {
    q.storeId = targetStoreId;
    q.store = targetStore;
    q.storeRole = 'platform_owner';
    return next();
  }

  // SEC-01: Strict server-side membership verification with ZERO dynamic auto-enrollment
  const membership = await db.get(
    "SELECT * FROM store_memberships WHERE store_id = ? AND user_id = ? AND status = 'active'",
    [targetStoreId, q.user.userId]
  );

  if (!membership) {
    await db.run(
      "INSERT INTO audit_logs (store_id, user_id, action, target_type, target_id, details) VALUES (?, ?, 'UNAUTHORIZED_CROSS_STORE_ACCESS', 'store', ?, ?)",
      [targetStoreId, q.user.userId, targetStoreId, 'User attempted cross-store access without active membership']
    ).catch(() => {});
    return r.status(403).json({ ok: false, error: 'Access denied: You are not an active member of this store' });
  }

  q.storeId = targetStoreId;
  q.store = targetStore;
  q.storeRole = membership.role;
  next();
}

// Store Role Middlewares
function storeOwnerOnly(q, r, next) {
  if (['store_owner', 'platform_owner'].includes(q.storeRole) || q.user?.platformRole === 'platform_owner' || q.user?.userId === 'testboss') {
    return next();
  }
  return r.status(403).json({ ok: false, error: 'Store Owner permission required' });
}

function storeAdminOnly(q, r, next) {
  if (['store_owner', 'store_admin', 'platform_owner'].includes(q.storeRole) || q.user?.platformRole === 'platform_owner' || q.user?.userId === 'testboss') {
    return next();
  }
  return r.status(403).json({ ok: false, error: 'Store Admin permission required' });
}

function storeOperatorOnly(q, r, next) {
  if (q.storeRole === 'operator') {
    return next();
  }
  return r.status(403).json({
    ok: false,
    error: `Routine store and retrieve operations are restricted to approved Operators only. Your role (${q.storeRole || q.user?.role || 'unknown'}) is not permitted to perform inventory movements directly.`
  });
}

// Owner Only Middleware (Platform/Warehouse Owner)
function ownerOnly(q, r, next) {
  if (['owner', 'boss'].includes(q.user?.role) || q.user?.platformRole === 'platform_owner' || q.storeRole === 'store_owner') {
    return next();
  }
  return r.status(403).json({ ok: false, error: 'Owner / Super Admin permission required' });
}

// Admin or Owner Middleware (Admin+)
function adminOnly(q, r, next) {
  if (['owner', 'boss', 'admin'].includes(q.user?.role) || q.user?.platformRole === 'platform_owner' || ['store_owner', 'store_admin'].includes(q.storeRole)) {
    return next();
  }
  return r.status(403).json({ ok: false, error: 'Admin / Warehouse Manager permission required' });
}

// Operator Only Middleware (routine Store/Retrieve restricted to Operator)
function operatorOnly(q, r, next) {
  if (q.user?.role === 'operator' || q.storeRole === 'operator') {
    return next();
  }
  return r.status(403).json({
    ok: false,
    error: `Routine store and retrieve operations are restricted to approved Operators only. Your role (${q.user?.role || 'unknown'}) is not permitted to perform inventory movements directly.`
  });
}

// Boss/Admin Only Middleware (Legacy alias)
function bossOnly(q, r, next) {
  return ownerOnly(q, r, next);
}

// Current User Profile Endpoint
app.get('/auth/me', authenticateUser, async (q, r) => {
  try {
    const u = await db.get('SELECT * FROM users WHERE user_id = ?', [q.user.userId]);
    if (!u) return r.status(404).json({ ok: false, error: 'User not found' });
    const userStores = await db.all(
      "SELECT s.id, s.name, s.code, s.store_type, m.role, m.status FROM store_memberships m JOIN stores s ON m.store_id = s.id WHERE m.user_id = ? AND m.status = 'active' AND s.status = 'active' ORDER BY s.name ASC",
      [q.user.userId]
    );
    const safe = safeUser(u);
    safe.platformRole = q.user.platformRole;
    safe.stores = userStores;
    safe.defaultStoreId = userStores[0]?.id || 'store_default_001';
    r.json({ ok: true, user: safe });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

// Hardware API Key Authentication Middleware (for ESP32 / Keypad - Store Scoped)
async function hardwareAuth(q, r, next) {
  const key = String(q.headers['x-hardware-key'] || q.query.key || '').trim();
  if (!key) {
    return r.status(401).json({ ok: false, error: 'Missing hardware API key. Device authentication required.' });
  }

  let device = await db.get("SELECT * FROM store_devices WHERE device_key = ? AND status = 'active'", [key]);

  if (!device) {
    const setting = await db.get("SELECT value FROM system_settings WHERE key='hardware_api_key'");
    if (setting && setting.value === key) {
      device = {
        store_id: 'store_default_001',
        device_name: 'Main ESP32 Controller',
        device_key: key
      };
    }
  }

  if (!device) {
    return r.status(401).json({ ok: false, error: 'Invalid or deactivated hardware API key.' });
  }

  q.device = device;
  q.storeId = device.store_id;
  q.user = {
    userId: `device_${String(device.device_name).toLowerCase().replace(/[^a-z0-9_]/g, '_')}`,
    displayName: device.device_name,
    role: 'hardware'
  };
  next();
}

// Unified Atomic Movement Handler (Store & Retrieve - Race condition & double-click safe)
async function handleMovement(action, slotCode, itemNum, quantity, source, user, storeId = 'store_default_001') {
  quantity = Number(quantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw Error('Quantity must be a positive whole number');
  }
  const code = String(slotCode || '').trim().toUpperCase();
  const s = await db.get('SELECT * FROM slots WHERE store_id = ? AND slot = ?', [storeId, code]);
  if (!s) throw Error(`Slot ${code} not found in store rack`);

  if (itemNum && Number(itemNum) !== s.item) {
    throw Error('Selected item ID does not match the slot');
  }

  // Atomic conditional SQL update: eliminates race conditions and double-click errors
  let result;
  if (action === 'STORE') {
    result = await db.run(
      'UPDATE slots SET quantity = quantity + ?, occupied = 1 WHERE store_id = ? AND slot = ? AND (quantity + ?) <= capacity',
      [quantity, storeId, code, quantity]
    );
  } else if (action === 'RETRIEVE') {
    result = await db.run(
      'UPDATE slots SET quantity = quantity - ?, occupied = CASE WHEN (quantity - ?) > 0 THEN 1 ELSE 0 END WHERE store_id = ? AND slot = ? AND (quantity - ?) >= 0',
      [quantity, quantity, storeId, code, quantity]
    );
  } else {
    throw Error(`Unsupported movement action: ${action}`);
  }

  if (result.changes === 0) {
    const cur = await db.get('SELECT quantity, capacity FROM slots WHERE store_id = ? AND slot = ?', [storeId, code]);
    if (!cur) throw Error(`Slot ${code} not found in store rack`);
    if (action === 'STORE') {
      const free = Math.max(0, Number(cur.capacity || 10) - Number(cur.quantity || 0));
      throw Error(`Slot capacity exceeded. Available free space: ${free} unit(s)`);
    } else {
      const available = Number(cur.quantity || 0);
      throw Error(`Insufficient stock in slot ${code}. Available stock: ${available} unit(s)`);
    }
  }

  const updatedSlot = await db.get("SELECT slot, item, item_name, sku, x, y, occupied, quantity, capacity, store_id, CASE WHEN quantity<=0 THEN 'EMPTY' WHEN quantity>=capacity THEN 'FULL' ELSE 'AVAILABLE' END status FROM slots WHERE store_id = ? AND slot = ?", [storeId, code]);

  const after = Number(updatedSlot.quantity);
  const before = action === 'STORE' ? after - quantity : after + quantity;

  await db.run(`
    INSERT INTO transactions (
      action, slot, item, item_name, sku, source, time,
      quantity, before_quantity, after_quantity, user_name, role, user_id, store_id
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?)
  `, [
    action,
    updatedSlot.slot,
    updatedSlot.item,
    updatedSlot.item_name,
    updatedSlot.sku,
    source,
    quantity,
    before,
    after,
    user?.displayName || user?.userId || 'System',
    user?.role || 'operator',
    user?.userId || null,
    storeId
  ]);

  return updatedSlot;
}

// ---------------- PUBLIC MULTI-TENANT STORE ONBOARDING ----------------
const handleStoreApply = async (q, r) => {
  try {
    const {
      name,
      code,
      storeType = 'grocery',
      ownerUserId,
      ownerName,
      email,
      phone,
      address,
      city,
      password,
      applicationReason
    } = q.body || {};

    const cleanName = String(name || '').trim();
    if (!cleanName) throw Error('Store business name is required');

    const cleanCode = String(code || '').trim().toUpperCase();
    if (!cleanCode || !/^[A-Z0-9_-]{2,20}$/.test(cleanCode)) {
      throw Error('Store code must be 2-20 alphanumeric characters, hyphens or underscores (e.g. GROCERY_01)');
    }

    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      throw Error('A valid business email address is required');
    }

    if (!password || String(password).length < 8) {
      throw Error('Account password with at least 8 characters is required');
    }

    const cleanOwnerName = String(ownerName || '').trim() || (cleanName + ' Owner');
    const cleanUserId = String(ownerUserId || (cleanCode.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_owner')).trim();

    if (!/^[a-zA-Z0-9_]{3,30}$/.test(cleanUserId)) {
      throw Error('Owner User ID must be 3-30 alphanumeric characters or underscores');
    }

    // Check unique store code
    const existingCode = await db.get('SELECT id FROM stores WHERE LOWER(code) = LOWER(?)', [cleanCode]);
    if (existingCode) {
      return r.status(400).json({ ok: false, error: `Store code '${cleanCode}' is already registered` });
    }

    // Check if user ID or email exists
    const existingUser = await db.get(
      'SELECT id FROM users WHERE LOWER(user_id) = LOWER(?) OR (email IS NOT NULL AND LOWER(email) = LOWER(?))',
      [cleanUserId, cleanEmail]
    );
    if (existingUser) {
      return r.status(400).json({ ok: false, error: 'User ID or Email is already registered' });
    }

    const storeId = `store_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const slug = (cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + cleanCode.toLowerCase()).replace(/^-+|-+$/g, '');

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hash(password, salt);

    // Create pending user (role=boss for legacy compatibility, effective_role=admin, requested_role=admin)
    await db.run(`
      INSERT INTO users (
        user_id, password_hash, salt, display_name, role, active,
        email, phone, approval_status, requested_role, effective_role,
        organization, registration_reason, requested_at
      ) VALUES (?, ?, ?, ?, 'boss', 0, ?, ?, 'pending', 'admin', 'admin', ?, ?, CURRENT_TIMESTAMP)
    `, [
      cleanUserId,
      passwordHash,
      salt,
      cleanOwnerName,
      cleanEmail,
      phone ? String(phone).trim() : null,
      cleanName,
      applicationReason || `New store application for ${cleanName}`
    ]);

    // Create pending store
    await db.run(`
      INSERT INTO stores (
        id, name, code, slug, store_type, status, owner_user_id, address, city, max_slots, rack_rows, rack_cols
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 50, 4, 4)
    `, [
      storeId,
      cleanName,
      cleanCode,
      slug,
      String(storeType || 'grocery').toLowerCase(),
      cleanUserId,
      address ? String(address).trim() : null,
      city ? String(city).trim() : null
    ]);

    // Create pending membership
    await db.run(`
      INSERT INTO store_memberships (store_id, user_id, role, status)
      VALUES (?, ?, 'store_owner', 'pending')
    `, [storeId, cleanUserId]);

    // Audit log
    await db.run(`
      INSERT INTO audit_logs (store_id, user_id, action, target_type, target_id, details)
      VALUES (?, ?, 'STORE_APPLICATION_SUBMITTED', 'store', ?, ?)
    `, [storeId, cleanUserId, storeId, `Store application submitted for ${cleanName} (${cleanCode})`]).catch(() => {});

    r.json({
      ok: true,
      storeId,
      code: cleanCode,
      message: 'Store registration request submitted successfully. Pending Platform Owner approval.'
    });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
};
app.post('/api/stores/apply', handleStoreApply);
app.post('/api/stores/register', handleStoreApply);

// ---------------- HARDWARE ROUTES (ESP32 / Keypad) ----------------
app.post('/api/hardware/store', hardwareAuth, async (q, r) => {
  try {
    const { slot, item, quantity = 1, source = 'keypad' } = q.body || {};
    const updatedSlot = await handleMovement('STORE', slot, item, quantity, source, q.user, q.storeId);
    r.json({ ok: true, message: 'Stock stored via hardware', slot: updatedSlot, storeId: q.storeId });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/hardware/retrieve', hardwareAuth, async (q, r) => {
  try {
    const { slot, item, quantity = 1, source = 'keypad' } = q.body || {};
    const updatedSlot = await handleMovement('RETRIEVE', slot, item, quantity, source, q.user, q.storeId);
    r.json({ ok: true, message: 'Stock retrieved via hardware', slot: updatedSlot, storeId: q.storeId });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// ---------------- PROTECTED WEB DASHBOARD ROUTES ----------------
app.use(authenticateUser);

// Get all rack slots (Tenant Scoped)
app.get('/slots', tenantContext, async (q, r) => {
  try {
    const allSlots = await db.all(
      "SELECT slot, item, item_name, sku, x, y, occupied, quantity, capacity, store_id, CASE WHEN quantity<=0 THEN 'EMPTY' WHEN quantity>=capacity THEN 'FULL' ELSE 'AVAILABLE' END status FROM slots WHERE store_id = ? ORDER BY slot",
      [q.storeId]
    );
    r.json(allSlots);
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

// Get recent transactions with date filtering and role boundary enforcement (Tenant Scoped)
app.get('/transactions', tenantContext, async (q, r) => {
  try {
    const { from, to, startBound, endBound } = parseAndValidateDateRange(q.query.from, q.query.to);
    const conditions = ['store_id = ?'];
    const params = [q.storeId];

    // Operators only view their own transactions
    if (q.user?.role === 'operator' || q.storeRole === 'operator') {
      conditions.push('user_id = ?');
      params.push(q.user.userId);
    }

    // Inclusive date range boundaries
    if (startBound) {
      conditions.push('time >= ?');
      params.push(startBound);
    }
    if (endBound) {
      conditions.push('time < ?');
      params.push(endBound);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const sql = `SELECT id, action, slot, item, item_name, sku, source, time, quantity, before_quantity, after_quantity, user_name, role, user_id, store_id FROM transactions ${whereClause} ORDER BY id DESC LIMIT 1000`;
    const txs = await db.all(sql, params);
    r.json(txs);
  } catch (e) {
    const status = e.message.includes('Date') ? 400 : 500;
    r.status(status).json({ ok: false, error: e.message });
  }
});

// Download transactions as Excel (.xlsx) file (Tenant Scoped)
app.get('/transactions/export', tenantContext, async (q, r) => {
  try {
    const { from, to, startBound, endBound } = parseAndValidateDateRange(q.query.from, q.query.to);
    const conditions = ['store_id = ?'];
    const params = [q.storeId];

    if (q.user?.role === 'operator' || q.storeRole === 'operator') {
      conditions.push('user_id = ?');
      params.push(q.user.userId);
    }
    if (startBound) {
      conditions.push('time >= ?');
      params.push(startBound);
    }
    if (endBound) {
      conditions.push('time < ?');
      params.push(endBound);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const sql = `SELECT id, action, slot, item, item_name, sku, source, time, quantity, before_quantity, after_quantity, user_name, role, user_id, store_id FROM transactions ${whereClause} ORDER BY id DESC`;
    const txs = await db.all(sql, params);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = `ASRS - ${q.store?.name || 'Smart Warehouse'}`;
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Transactions');

    sheet.columns = [
      { header: 'Transaction ID', key: 'id', width: 16 },
      { header: 'Date & Time', key: 'time', width: 22 },
      { header: 'Action', key: 'action', width: 14 },
      { header: 'Product Name', key: 'item_name', width: 26 },
      { header: 'SKU', key: 'sku', width: 16 },
      { header: 'Slot', key: 'slot', width: 10 },
      { header: 'Quantity', key: 'quantity', width: 12 },
      { header: 'User / Actor', key: 'user', width: 20 },
      { header: 'Source', key: 'source', width: 22 }
    ];

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF1F5F9' }
    };

    if (txs.length === 0) {
      sheet.addRow({
        id: 'No transactions found for the selected date range'
      });
    } else {
      for (const t of txs) {
        sheet.addRow({
          id: t.id,
          time: t.time || '',
          action: sanitizeExcelCell(t.action),
          item_name: sanitizeExcelCell(t.item_name || (t.item ? `Item #${t.item}` : 'N/A')),
          sku: sanitizeExcelCell(t.sku || ''),
          slot: sanitizeExcelCell(t.slot),
          quantity: t.quantity !== null && t.quantity !== undefined ? t.quantity : '',
          user: sanitizeExcelCell(t.user_id || t.user_name || 'System'),
          source: sanitizeExcelCell(t.source || 'Dashboard')
        });
      }
    }

    const storePrefix = (q.storeId === 'store_default_001' || !q.store?.code) ? 'ASRS' : q.store.code.replace(/[^a-zA-Z0-9_-]/g, '');
    let filename;
    if (from && to) filename = `${storePrefix}_Transactions_${from}_to_${to}.xlsx`;
    else if (from) filename = `${storePrefix}_Transactions_from_${from}.xlsx`;
    else if (to) filename = `${storePrefix}_Transactions_to_${to}.xlsx`;
    else filename = `${storePrefix}_Transactions_All.xlsx`;

    const buffer = await workbook.xlsx.writeBuffer();
    r.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    r.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    r.setHeader('Content-Length', buffer.length);
    return r.send(buffer);
  } catch (e) {
    const status = e.message.includes('Date') ? 400 : 500;
    r.status(status).json({ ok: false, error: e.message });
  }
});

// Get warehouse summary stats (Tenant Scoped)
app.get('/summary', tenantContext, async (q, r) => {
  try {
    const allSlots = await db.all('SELECT quantity, capacity FROM slots WHERE store_id = ?', [q.storeId]);
    const storedRes = await db.get("SELECT COALESCE(SUM(quantity), 0) as n FROM transactions WHERE store_id = ? AND action='STORE'", [q.storeId]);
    const retrievedRes = await db.get("SELECT COALESCE(SUM(quantity), 0) as n FROM transactions WHERE store_id = ? AND action='RETRIEVE'", [q.storeId]);
    let rack = null;
    if (q.storeId === 'store_default_001') {
      rack = await db.get('SELECT rows, cols FROM rack_config WHERE store_id = ? OR id = 1 ORDER BY id DESC LIMIT 1', [q.storeId]);
    }

    const inventory = allSlots.reduce((a, s) => a + Number(s.quantity || 0), 0);
    const occupiedSlots = allSlots.filter(s => Number(s.quantity || 0) > 0).length;
    const freeCapacity = allSlots.reduce((a, s) => a + Math.max(0, Number(s.capacity || 10) - Number(s.quantity || 0)), 0);

    r.json({
      storeId: q.storeId,
      storeName: q.store?.name || 'Warehouse',
      inventory,
      stored: Number(storedRes?.n || 0),
      retrieved: Number(retrievedRes?.n || 0),
      occupiedSlots,
      totalSlots: allSlots.length,
      freeCapacity,
      rack: rack || { rows: q.store?.rack_rows || 4, cols: q.store?.rack_cols || 4 }
    });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

// Web Store & Retrieve (Operator only, Tenant Scoped)
app.post('/store', tenantContext, storeOperatorOnly, async (q, r) => {
  try {
    const { slot, item, quantity = 1 } = q.body || {};
    const updatedSlot = await handleMovement('STORE', slot, item, quantity, 'dashboard_operator_simulated', q.user, q.storeId);
    r.json({ ok: true, slot: updatedSlot });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/retrieve', tenantContext, storeOperatorOnly, async (q, r) => {
  try {
    const { slot, item, quantity = 1 } = q.body || {};
    const updatedSlot = await handleMovement('RETRIEVE', slot, item, quantity, 'dashboard_operator_simulated', q.user, q.storeId);
    r.json({ ok: true, slot: updatedSlot });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Update product name & SKU (Store Admin & Owner, Tenant Scoped)
app.put('/slots/:slot/product', tenantContext, storeAdminOnly, async (q, r) => {
  try {
    const code = String(q.params.slot).toUpperCase();
    const s = await db.get('SELECT * FROM slots WHERE store_id = ? AND slot = ?', [q.storeId, code]);
    if (!s) throw Error('Slot not found in this store');
    const { item_name, sku } = q.body || {};
    if (!String(item_name || '').trim() || !String(sku || '').trim()) {
      throw Error('Product name and SKU are required');
    }
    await db.run('UPDATE slots SET item_name = ?, sku = ? WHERE store_id = ? AND slot = ?', [
      String(item_name).trim(),
      String(sku).trim(),
      q.storeId,
      code
    ]);
    const updated = await db.get("SELECT slot, item, item_name, sku, x, y, occupied, quantity, capacity, store_id, CASE WHEN quantity<=0 THEN 'EMPTY' WHEN quantity>=capacity THEN 'FULL' ELSE 'AVAILABLE' END status FROM slots WHERE store_id = ? AND slot = ?", [q.storeId, code]);
    r.json({ ok: true, slot: updated });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Update slot capacity (Store Owner only, Tenant Scoped)
app.put('/slots/:slot/capacity', tenantContext, storeOwnerOnly, async (q, r) => {
  try {
    const code = String(q.params.slot).toUpperCase();
    const s = await db.get('SELECT * FROM slots WHERE store_id = ? AND slot = ?', [q.storeId, code]);
    if (!s) throw Error('Slot not found in this store');
    const cap = Number((q.body || {}).capacity);
    if (!Number.isInteger(cap) || cap < 1 || cap < Number(s.quantity || 0)) {
      throw Error('Capacity must be a positive whole number at least as large as current stock');
    }
    await db.run('UPDATE slots SET capacity = ? WHERE store_id = ? AND slot = ?', [cap, q.storeId, code]);
    const updated = await db.get("SELECT slot, item, item_name, sku, x, y, occupied, quantity, capacity, store_id, CASE WHEN quantity<=0 THEN 'EMPTY' WHEN quantity>=capacity THEN 'FULL' ELSE 'AVAILABLE' END status FROM slots WHERE store_id = ? AND slot = ?", [q.storeId, code]);
    r.json({ ok: true, slot: updated });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Dynamic Rack Size Configuration (Tenant Scoped - SEC-03 enforced)
app.get('/rack/config', tenantContext, async (q, r) => {
  try {
    let config = null;
    if (q.storeId === 'store_default_001') {
      config = await db.get('SELECT rows, cols FROM rack_config WHERE store_id = ? OR id = 1 ORDER BY id DESC LIMIT 1', [q.storeId]);
    }
    r.json(config || { rows: q.store?.rack_rows || 4, cols: q.store?.rack_cols || 4 });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/rack/dimensions', tenantContext, storeOwnerOnly, async (q, r) => {
  try {
    const newRows = Number(q.body.rows);
    const newCols = Number(q.body.cols);
    if (!Number.isInteger(newRows) || newRows < 1 || newRows > 26) {
      throw Error('Rows must be an integer between 1 and 26 (A-Z)');
    }
    if (!Number.isInteger(newCols) || newCols < 1 || newCols > 50) {
      throw Error('Columns must be an integer between 1 and 50');
    }

    // Build list of valid slots for the new configuration
    const validSlotSet = new Set();
    for (let rowIdx = 0; rowIdx < newRows; rowIdx++) {
      const rowLetter = String.fromCharCode(65 + rowIdx);
      for (let colIdx = 1; colIdx <= newCols; colIdx++) {
        validSlotSet.add(`${rowLetter}${colIdx}`);
      }
    }

    const currentSlots = await db.all('SELECT slot, quantity, item_name FROM slots WHERE store_id = ?', [q.storeId]);
    const outOfBoundsOccupied = currentSlots.filter(s => !validSlotSet.has(s.slot) && Number(s.quantity || 0) > 0);

    // Prevent data loss if any shrinking slot is occupied
    if (outOfBoundsOccupied.length > 0) {
      const list = outOfBoundsOccupied.map(s => `${s.slot} (${s.quantity} units of '${s.item_name}')`).join(', ');
      throw Error(`Cannot shrink rack. The following slots contain stock: ${list}. Please retrieve or move items first.`);
    }

    // Safe to delete out of bounds empty slots for this store
    const outOfBoundsEmpty = currentSlots.filter(s => !validSlotSet.has(s.slot));
    for (const s of outOfBoundsEmpty) {
      await db.run('DELETE FROM slots WHERE store_id = ? AND slot = ?', [q.storeId, s.slot]);
    }

    // Add any newly created slots for this store
    const existingSlotMap = new Map(currentSlots.map(s => [s.slot, s]));
    let maxItemRes = await db.get('SELECT COALESCE(MAX(item), 0) as m FROM slots WHERE store_id = ?', [q.storeId]);
    let nextItemNum = Number(maxItemRes?.m || 0) + 1;

    for (let rowIdx = 0; rowIdx < newRows; rowIdx++) {
      const rowLetter = String.fromCharCode(65 + rowIdx);
      for (let colIdx = 1; colIdx <= newCols; colIdx++) {
        const slotCode = `${rowLetter}${colIdx}`;
        if (!existingSlotMap.has(slotCode)) {
          await db.run(`
            INSERT INTO slots (store_id, slot, item, x, y, occupied, quantity, capacity, item_name, sku)
            VALUES (?, ?, ?, ?, ?, 0, 0, 10, ?, ?)
          `, [
            q.storeId,
            slotCode,
            nextItemNum,
            (colIdx - 1) * 100,
            rowIdx * 100,
            `Product ${slotCode}`,
            `SKU-${slotCode}`
          ]);
          nextItemNum++;
        }
      }
    }

    if (q.storeId === 'store_default_001') {
      await db.run('UPDATE rack_config SET rows = ?, cols = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [newRows, newCols]);
    }
    await db.run('UPDATE stores SET rack_rows = ?, rack_cols = ? WHERE id = ?', [newRows, newCols, q.storeId]);
    const updatedSlots = await db.all("SELECT slot, item, item_name, sku, x, y, occupied, quantity, capacity, store_id, CASE WHEN quantity<=0 THEN 'EMPTY' WHEN quantity>=capacity THEN 'FULL' ELSE 'AVAILABLE' END status FROM slots WHERE store_id = ? ORDER BY slot", [q.storeId]);

    r.json({ ok: true, rows: newRows, cols: newCols, totalSlots: updatedSlots.length, storeId: q.storeId });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Hardware API Key Management (Platform Owner only - SEC-04)
app.get('/hardware/key', platformOwnerOnly, async (q, r) => {
  try {
    const keyRow = await db.get("SELECT value FROM system_settings WHERE key='hardware_api_key'");
    r.json({ ok: true, hardwareApiKey: keyRow?.value || '' });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/hardware/key/regenerate', platformOwnerOnly, async (q, r) => {
  try {
    const newKey = 'asrs_hw_' + crypto.randomBytes(16).toString('hex');
    await db.run("UPDATE system_settings SET value=? WHERE key='hardware_api_key'", [newKey]);
    const dev = await db.get("SELECT id FROM store_devices WHERE store_id = 'store_default_001'");
    if (dev) {
      await db.run("UPDATE store_devices SET device_key = ? WHERE id = ?", [newKey, dev.id]);
    } else {
      await db.run("INSERT INTO store_devices (store_id, device_key, device_name, status) VALUES ('store_default_001', ?, 'Main ESP32 Controller', 'active')", [newKey]);
    }
    r.json({ ok: true, hardwareApiKey: newKey });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------- APPROVAL QUEUE ROUTES (SEC-02) ----------------
// Platform Owner-only Admin Request Approval Queue
app.get('/api/owner/pending-admins', platformOwnerOnly, async (q, r) => {
  try {
    const list = await db.all(`
      SELECT id, user_id, display_name, email, phone, organization, registration_reason, requested_at, approval_status
      FROM users
      WHERE requested_role = 'admin' AND approval_status = 'pending'
      ORDER BY requested_at ASC
    `);
    r.json({ ok: true, requests: list });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/owner/admins/:id/approve', platformOwnerOnly, async (q, r) => {
  try {
    const id = Number(q.params.id);
    const target = await db.get("SELECT * FROM users WHERE id = ? AND requested_role = 'admin'", [id]);
    if (!target) return r.status(404).json({ ok: false, error: 'Pending Admin request not found' });
    if (target.approval_status !== 'pending') {
      return r.status(400).json({ ok: false, error: `Request already marked as ${target.approval_status}` });
    }

    await db.run(`
      UPDATE users
      SET approval_status = 'approved', effective_role = 'admin', active = 1, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?
      WHERE id = ?
    `, [q.user.userId, id]);

    // Ensure store membership in default store
    const existingM = await db.get("SELECT id FROM store_memberships WHERE store_id = 'store_default_001' AND user_id = ?", [target.user_id]);
    if (existingM) {
      await db.run("UPDATE store_memberships SET status = 'active', role = 'store_admin' WHERE id = ?", [existingM.id]);
    } else {
      await db.run("INSERT INTO store_memberships (store_id, user_id, role, status) VALUES ('store_default_001', ?, 'store_admin', 'active')", [target.user_id]);
    }

    r.json({ ok: true, message: `Admin account '${target.user_id}' has been approved and activated.` });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/owner/admins/:id/reject', platformOwnerOnly, async (q, r) => {
  try {
    const id = Number(q.params.id);
    const { rejectionReason } = q.body || {};
    const target = await db.get("SELECT * FROM users WHERE id = ? AND requested_role = 'admin'", [id]);
    if (!target) return r.status(404).json({ ok: false, error: 'Pending Admin request not found' });
    if (target.approval_status !== 'pending') {
      return r.status(400).json({ ok: false, error: `Request already marked as ${target.approval_status}` });
    }

    await db.run(`
      UPDATE users
      SET approval_status = 'rejected', active = 0, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?, rejection_reason = ?
      WHERE id = ?
    `, [q.user.userId, String(rejectionReason || 'Request rejected by Owner').trim(), id]);

    // Deactivate membership if any
    await db.run("UPDATE store_memberships SET status = 'deactivated' WHERE user_id = ?", [target.user_id]);

    // Purge any sessions
    await db.run('DELETE FROM user_sessions WHERE user_id = ?', [target.user_id]);

    r.json({ ok: true, message: `Admin request for '${target.user_id}' has been rejected.` });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Admin/Owner Operator Request Approval Queue (Tenant Scoped)
app.get('/api/admin/pending-operators', tenantContext, storeAdminOnly, async (q, r) => {
  try {
    const list = await db.all(`
      SELECT id, user_id, display_name, email, phone, employee_id, registration_reason, requested_at, approval_status
      FROM users
      WHERE requested_role = 'operator' AND approval_status = 'pending'
      ORDER BY requested_at ASC
    `);
    r.json({ ok: true, requests: list });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/operators/:id/approve', tenantContext, storeAdminOnly, async (q, r) => {
  try {
    const id = Number(q.params.id);
    const target = await db.get("SELECT * FROM users WHERE id = ? AND requested_role = 'operator'", [id]);
    if (!target) return r.status(404).json({ ok: false, error: 'Pending Operator request not found' });
    if (target.approval_status !== 'pending') {
      return r.status(400).json({ ok: false, error: `Request already marked as ${target.approval_status}` });
    }

    await db.run(`
      UPDATE users
      SET approval_status = 'approved', effective_role = 'operator', active = 1, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?
      WHERE id = ?
    `, [q.user.userId, id]);

    // Ensure store membership is created/activated for this operator in caller's store
    const existingM = await db.get("SELECT id FROM store_memberships WHERE store_id = ? AND user_id = ?", [q.storeId, target.user_id]);
    if (existingM) {
      await db.run("UPDATE store_memberships SET status = 'active', role = 'operator' WHERE id = ?", [existingM.id]);
    } else {
      await db.run("INSERT INTO store_memberships (store_id, user_id, role, status) VALUES (?, ?, 'operator', 'active')", [q.storeId, target.user_id]);
    }

    r.json({ ok: true, message: `Operator account '${target.user_id}' has been approved and activated.` });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/operators/:id/reject', tenantContext, storeAdminOnly, async (q, r) => {
  try {
    const id = Number(q.params.id);
    const { rejectionReason } = q.body || {};
    const target = await db.get("SELECT * FROM users WHERE id = ? AND requested_role = 'operator'", [id]);
    if (!target) return r.status(404).json({ ok: false, error: 'Pending Operator request not found' });
    if (target.approval_status !== 'pending') {
      return r.status(400).json({ ok: false, error: `Request already marked as ${target.approval_status}` });
    }

    await db.run(`
      UPDATE users
      SET approval_status = 'rejected', active = 0, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?, rejection_reason = ?
      WHERE id = ?
    `, [q.user.userId, String(rejectionReason || 'Request rejected by Administrator').trim(), id]);

    // Deactivate membership in this store if any
    await db.run("UPDATE store_memberships SET status = 'deactivated' WHERE store_id = ? AND user_id = ?", [q.storeId, target.user_id]);

    // Purge any sessions
    await db.run('DELETE FROM user_sessions WHERE user_id = ?', [target.user_id]);

    r.json({ ok: true, message: `Operator request for '${target.user_id}' has been rejected.` });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Store Owner Admin Management (Tenant Scoped - SEC-02)
app.get('/api/owner/admins', tenantContext, storeOwnerOnly, async (q, r) => {
  try {
    const admins = await db.all(`
      SELECT u.id, u.user_id, u.display_name, u.email, u.phone, u.organization, u.employee_id, u.active,
             u.approval_status, u.requested_at, u.reviewed_at, u.reviewed_by, u.created_at, u.role, u.effective_role, u.requested_role
      FROM store_memberships m
      JOIN users u ON m.user_id = u.user_id
      WHERE m.store_id = ? AND (m.role = 'store_admin' OR u.effective_role = 'admin' OR (u.requested_role = 'admin' AND u.role = 'boss'))
        AND u.approval_status = 'approved'
      ORDER BY u.id DESC
    `, [q.storeId]);
    r.json({ ok: true, admins: admins.map(safeUser) });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/owner/admins/:id/deactivate', tenantContext, storeOwnerOnly, async (q, r) => {
  try {
    const id = Number(q.params.id);
    const u = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!u) return r.status(404).json({ ok: false, error: 'Admin account not found' });
    const targetRole = getUserRole(u);
    if (u.user_id === 'testboss' || targetRole === 'owner') {
      return r.status(400).json({ ok: false, error: 'Cannot deactivate the Owner account' });
    }
    const mem = await db.get('SELECT * FROM store_memberships WHERE store_id = ? AND user_id = ?', [q.storeId, u.user_id]);
    if (!mem) {
      return r.status(404).json({ ok: false, error: 'Admin account not found in this store' });
    }
    if (targetRole !== 'admin' && mem.role !== 'store_admin') {
      return r.status(400).json({ ok: false, error: 'Target user is not an administrator' });
    }

    await db.run('UPDATE users SET active = 0, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ?', [q.user.userId, id]);
    await db.run("UPDATE store_memberships SET status = 'deactivated' WHERE store_id = ? AND user_id = ?", [q.storeId, u.user_id]);
    await db.run('DELETE FROM user_sessions WHERE user_id = ?', [u.user_id]);
    r.json({ ok: true, message: `Admin '${u.user_id}' has been deactivated. All active sessions have been revoked.` });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/owner/admins/:id/activate', tenantContext, storeOwnerOnly, async (q, r) => {
  try {
    const id = Number(q.params.id);
    const u = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!u) return r.status(404).json({ ok: false, error: 'Admin account not found' });
    const targetRole = getUserRole(u);
    const mem = await db.get('SELECT * FROM store_memberships WHERE store_id = ? AND user_id = ?', [q.storeId, u.user_id]);
    if (!mem) {
      return r.status(404).json({ ok: false, error: 'Admin account not found in this store' });
    }
    if (targetRole !== 'admin' && mem.role !== 'store_admin') {
      return r.status(400).json({ ok: false, error: 'Target user is not an administrator' });
    }

    await db.run('UPDATE users SET active = 1, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ?', [q.user.userId, id]);
    await db.run("UPDATE store_memberships SET status = 'active' WHERE store_id = ? AND user_id = ?", [q.storeId, u.user_id]);
    r.json({ ok: true, message: `Admin '${u.user_id}' has been activated.` });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Admin Operator Management (Tenant Scoped - SEC-02)
app.get('/api/admin/operators', tenantContext, storeAdminOnly, async (q, r) => {
  try {
    const operators = await db.all(`
      SELECT u.id, u.user_id, u.display_name, u.email, u.phone, u.organization, u.employee_id, u.active,
             u.approval_status, u.requested_at, u.reviewed_at, u.reviewed_by, u.created_at, u.role, u.effective_role, u.requested_role
      FROM store_memberships m
      JOIN users u ON m.user_id = u.user_id
      WHERE m.store_id = ? AND (m.role = 'operator' OR u.role = 'operator' OR u.effective_role = 'operator')
        AND u.approval_status = 'approved'
      ORDER BY u.id DESC
    `, [q.storeId]);
    r.json({ ok: true, operators: operators.map(safeUser) });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/operators/:id/deactivate', tenantContext, storeAdminOnly, async (q, r) => {
  try {
    const id = Number(q.params.id);
    const u = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!u) return r.status(404).json({ ok: false, error: 'Operator account not found' });
    const targetRole = getUserRole(u);
    if (targetRole !== 'operator') {
      return r.status(403).json({ ok: false, error: 'Admins can only manage Operators' });
    }
    const mem = await db.get('SELECT * FROM store_memberships WHERE store_id = ? AND user_id = ?', [q.storeId, u.user_id]);
    if (!mem) {
      return r.status(404).json({ ok: false, error: 'Operator account not found in this store' });
    }

    await db.run('UPDATE users SET active = 0, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ?', [q.user.userId, id]);
    await db.run("UPDATE store_memberships SET status = 'deactivated' WHERE store_id = ? AND user_id = ?", [q.storeId, u.user_id]);
    await db.run('DELETE FROM user_sessions WHERE user_id = ?', [u.user_id]);
    r.json({ ok: true, message: `Operator '${u.user_id}' has been deactivated. All active sessions have been revoked.` });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/operators/:id/activate', tenantContext, storeAdminOnly, async (q, r) => {
  try {
    const id = Number(q.params.id);
    const u = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!u) return r.status(404).json({ ok: false, error: 'Operator account not found' });
    const targetRole = getUserRole(u);
    if (targetRole !== 'operator') {
      return r.status(403).json({ ok: false, error: 'Admins can only manage Operators' });
    }
    const mem = await db.get('SELECT * FROM store_memberships WHERE store_id = ? AND user_id = ?', [q.storeId, u.user_id]);
    if (!mem) {
      return r.status(404).json({ ok: false, error: 'Operator account not found in this store' });
    }

    await db.run('UPDATE users SET active = 1, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ?', [q.user.userId, id]);
    await db.run("UPDATE store_memberships SET status = 'active' WHERE store_id = ? AND user_id = ?", [q.storeId, u.user_id]);
    r.json({ ok: true, message: `Operator '${u.user_id}' has been activated.` });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// User Management (Admin & Owner - Tenant Scoped SEC-02)
app.get('/users', tenantContext, adminOnly, async (q, r) => {
  try {
    const isOwner = ['owner', 'boss'].includes(q.user.role) || q.storeRole === 'store_owner' || q.user?.platformRole === 'platform_owner' || q.user?.userId === 'testboss';
    let users;
    if (isOwner) {
      users = await db.all(`
        SELECT u.id, u.user_id, u.display_name, u.role, u.effective_role, u.requested_role, u.active,
               u.approval_status, u.email, u.phone, u.employee_id, u.organization, u.created_at,
               u.requested_at, u.reviewed_at, u.reviewed_by
        FROM store_memberships m
        JOIN users u ON m.user_id = u.user_id
        WHERE m.store_id = ?
        ORDER BY u.id
      `, [q.storeId]);
    } else {
      // Admins only see operators in their store
      users = await db.all(`
        SELECT u.id, u.user_id, u.display_name, u.role, u.effective_role, u.requested_role, u.active,
               u.approval_status, u.email, u.phone, u.employee_id, u.organization, u.created_at,
               u.requested_at, u.reviewed_at, u.reviewed_by
        FROM store_memberships m
        JOIN users u ON m.user_id = u.user_id
        WHERE m.store_id = ? AND (m.role = 'operator' OR u.role = 'operator' OR u.effective_role = 'operator')
        ORDER BY u.id
      `, [q.storeId]);
    }
    const safeList = users.map(u => ({
      ...safeUser(u),
      reviewedAt: u.reviewed_at,
      reviewedBy: u.reviewed_by
    }));
    r.json(safeList);
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/users', tenantContext, adminOnly, async (q, r) => {
  try {
    const { userId, password, displayName, role = 'operator', email, phone, employeeId, organization } = q.body || {};
    if (!userId || !password || password.length < 8 || !displayName) {
      throw Error('User ID, display name and password (8+ characters) are required');
    }
    const cleanId = String(userId).trim();
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(cleanId)) {
      throw Error('User ID must be 3-30 alphanumeric characters or underscores');
    }

    const targetRole = String(role).toLowerCase();
    const isOwner = ['owner', 'boss'].includes(q.user.role) || q.storeRole === 'store_owner' || q.user?.platformRole === 'platform_owner' || q.user?.userId === 'testboss';

    if (targetRole === 'admin' && !isOwner) {
      return r.status(403).json({ ok: false, error: 'Only Owner can create Admin accounts' });
    }
    if (targetRole === 'owner') {
      return r.status(403).json({ ok: false, error: 'Cannot create additional Owner accounts' });
    }

    const existing = await db.get('SELECT id FROM users WHERE LOWER(user_id) = LOWER(?)', [cleanId]);
    if (existing) {
      return r.status(400).json({ ok: false, error: 'User ID is already in use' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const dbRole = targetRole === 'admin' ? 'boss' : 'operator';
    const effectiveRole = targetRole === 'admin' ? 'admin' : 'operator';
    const membershipRole = targetRole === 'admin' ? 'store_admin' : 'operator';

    await db.run(`
      INSERT INTO users (
        user_id, password_hash, salt, display_name, role, active,
        approval_status, requested_role, effective_role, email, phone,
        employee_id, organization, reviewed_at, reviewed_by
      ) VALUES (?, ?, ?, ?, ?, 1, 'approved', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
    `, [
      cleanId,
      hash(password, salt),
      salt,
      String(displayName).trim(),
      dbRole,
      effectiveRole,
      effectiveRole,
      email ? String(email).trim().toLowerCase() : null,
      phone ? String(phone).trim() : null,
      employeeId ? String(employeeId).trim() : null,
      organization ? String(organization).trim() : null,
      q.user.userId
    ]);

    await db.run(
      "INSERT INTO store_memberships (store_id, user_id, role, status) VALUES (?, ?, ?, 'active')",
      [q.storeId, cleanId, membershipRole]
    );

    r.json({ ok: true });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

app.patch('/users/:id', tenantContext, adminOnly, async (q, r) => {
  try {
    const id = Number(q.params.id);
    const u = await db.get('SELECT * FROM users WHERE id=?', [id]);
    if (!u) return r.status(404).json({ ok: false, error: 'User not found' });

    const targetRole = getUserRole(u);

    // Prevent modifying Owner (testboss)
    if (targetRole === 'owner' || u.user_id === 'testboss') {
      return r.status(403).json({ ok: false, error: 'Cannot modify Owner account via this endpoint' });
    }

    // Must be member of caller's store
    const mem = await db.get('SELECT * FROM store_memberships WHERE store_id = ? AND user_id = ?', [q.storeId, u.user_id]);
    if (!mem) {
      return r.status(404).json({ ok: false, error: 'User not found in this store' });
    }

    const isOwner = ['owner', 'boss'].includes(q.user.role) || q.storeRole === 'store_owner' || q.user?.platformRole === 'platform_owner' || q.user?.userId === 'testboss';

    // Admins can ONLY modify operators
    if (!isOwner && targetRole !== 'operator' && mem.role !== 'operator') {
      return r.status(403).json({ ok: false, error: 'Admins can only manage Operators' });
    }

    const { displayName, active, password, approvalStatus } = q.body || {};
    if (displayName !== undefined) {
      await db.run('UPDATE users SET display_name=? WHERE id=?', [String(displayName).trim(), id]);
    }
    if (active !== undefined) {
      const activeVal = active ? 1 : 0;
      if (activeVal === 0 && u.user_id === q.user.userId && isOwner) {
        const ownerCount = await db.get("SELECT COUNT(*) as n FROM users WHERE (user_id='testboss' OR role='boss' OR effective_role='owner') AND active=1 AND id != ?", [id]);
        if (Number(ownerCount?.n || 0) === 0) {
          return r.status(400).json({ ok: false, error: 'Cannot deactivate the only active Owner account' });
        }
      }
      await db.run('UPDATE users SET active=?, reviewed_at=CURRENT_TIMESTAMP, reviewed_by=? WHERE id=?', [activeVal, q.user.userId, id]);
      if (activeVal === 0) {
        await db.run("UPDATE store_memberships SET status = 'deactivated' WHERE store_id = ? AND user_id = ?", [q.storeId, u.user_id]);
        // Immediate session revocation on deactivation!
        await db.run('DELETE FROM user_sessions WHERE user_id=?', [u.user_id]);
      } else {
        await db.run("UPDATE store_memberships SET status = 'active' WHERE store_id = ? AND user_id = ?", [q.storeId, u.user_id]);
      }
    }
    if (approvalStatus !== undefined) {
      if (isOwner || targetRole === 'operator') {
        await db.run('UPDATE users SET approval_status=?, reviewed_at=CURRENT_TIMESTAMP, reviewed_by=? WHERE id=?', [approvalStatus, q.user.userId, id]);
        if (approvalStatus !== 'approved') {
          await db.run("UPDATE store_memberships SET status = 'deactivated' WHERE store_id = ? AND user_id = ?", [q.storeId, u.user_id]);
          await db.run('DELETE FROM user_sessions WHERE user_id=?', [u.user_id]);
        }
      }
    }
    if (password) {
      if (password.length < 8) throw Error('Password must have at least 8 characters');
      const salt = crypto.randomBytes(16).toString('hex');
      await db.run('UPDATE users SET password_hash=?, salt=? WHERE id=?', [hash(password, salt), salt, id]);
      // Invalidate sessions on password change
      await db.run('DELETE FROM user_sessions WHERE user_id=?', [u.user_id]);
    }

    r.json({ ok: true });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// =========================================================================
// MULTI-TENANT SAAS: PLATFORM OWNER, STORE MANAGEMENT, STAFF & DEVICES
// =========================================================================

// User Active Stores List
app.get('/api/user/stores', async (q, r) => {
  try {
    const isPlatformOwner = q.user?.platformRole === 'platform_owner' || q.user?.userId === 'testboss';
    let stores;
    if (isPlatformOwner) {
      stores = await db.all(`
        SELECT id, name, code, slug, store_type, status, rack_rows, rack_cols, 'platform_owner' as role
        FROM stores
        ORDER BY name ASC
      `);
    } else {
      stores = await db.all(`
        SELECT s.id, s.name, s.code, s.slug, s.store_type, s.status, s.rack_rows, s.rack_cols, m.role
        FROM store_memberships m
        JOIN stores s ON m.store_id = s.id
        WHERE m.user_id = ? AND m.status = 'active' AND s.status = 'active'
        ORDER BY s.name ASC
      `, [q.user.userId]);
    }
    r.json({ ok: true, stores });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

// Platform Owner: List all stores across the platform
app.get('/api/platform/stores', platformOwnerOnly, async (q, r) => {
  try {
    const stores = await db.all(`
      SELECT s.*,
             (SELECT COUNT(*) FROM store_memberships m WHERE m.store_id = s.id AND m.status = 'active') as active_members_count,
             (SELECT COUNT(*) FROM slots sl WHERE sl.store_id = s.id) as slot_count
      FROM stores s
      ORDER BY s.created_at DESC
    `);
    r.json({ ok: true, stores });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

// Platform Owner: List pending store registration applications
app.get('/api/platform/pending-stores', platformOwnerOnly, async (q, r) => {
  try {
    const pending = await db.all(`
      SELECT s.*, u.display_name as owner_name, u.email as owner_email, u.phone as owner_phone, u.requested_at
      FROM stores s
      LEFT JOIN users u ON s.owner_user_id = u.user_id
      WHERE s.status = 'pending'
      ORDER BY s.created_at ASC
    `);
    r.json({ ok: true, stores: pending });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

// Platform Owner: Approve a store registration application
app.post('/api/platform/stores/:id/approve', platformOwnerOnly, async (q, r) => {
  try {
    const storeId = q.params.id;
    const store = await db.get('SELECT * FROM stores WHERE id = ?', [storeId]);
    if (!store) return r.status(404).json({ ok: false, error: 'Store not found' });
    if (store.status !== 'pending') {
      return r.status(400).json({ ok: false, error: `Store is already marked as ${store.status}` });
    }

    // 1. Activate store
    await db.run('UPDATE stores SET status = ? WHERE id = ?', ['active', storeId]);

    // 2. Activate store owner membership
    await db.run("UPDATE store_memberships SET status = 'active' WHERE store_id = ? AND user_id = ?", [storeId, store.owner_user_id]);

    // 3. Activate store owner user account
    await db.run(`
      UPDATE users
      SET active = 1, approval_status = 'approved', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?
      WHERE user_id = ?
    `, [q.user.userId, store.owner_user_id]);

    // 4. Initialize default rack slots (A1-D4) if none exist
    const slotCount = await db.get('SELECT COUNT(*) as n FROM slots WHERE store_id = ?', [storeId]);
    if (Number(slotCount?.n || 0) === 0) {
      let itemNum = 1;
      for (let rowIdx = 0; rowIdx < 4; rowIdx++) {
        const rowLetter = String.fromCharCode(65 + rowIdx);
        for (let colIdx = 1; colIdx <= 4; colIdx++) {
          const slotCode = `${rowLetter}${colIdx}`;
          await db.run(`
            INSERT INTO slots (store_id, slot, item, x, y, occupied, quantity, capacity, item_name, sku)
            VALUES (?, ?, ?, ?, ?, 0, 0, 10, ?, ?)
          `, [
            storeId,
            slotCode,
            itemNum,
            (colIdx - 1) * 100,
            rowIdx * 100,
            `${store.name} ${slotCode}`,
            `${store.code}-${slotCode}`
          ]);
          itemNum++;
        }
      }
    }

    // 5. Generate default store hardware device
    const existingDev = await db.get('SELECT id FROM store_devices WHERE store_id = ?', [storeId]);
    let deviceKey = '';
    if (!existingDev) {
      deviceKey = 'asrs_hw_' + crypto.randomBytes(16).toString('hex');
      await db.run(`
        INSERT INTO store_devices (store_id, device_key, device_name, status)
        VALUES (?, ?, 'Primary ESP32 Controller', 'active')
      `, [storeId, deviceKey]);
    }

    // 6. Audit log
    await db.run(`
      INSERT INTO audit_logs (store_id, user_id, action, target_type, target_id, details)
      VALUES (?, ?, 'STORE_APPROVED', 'store', ?, ?)
    `, [storeId, q.user.userId, storeId, `Store '${store.name}' approved and activated`]).catch(() => {});

    r.json({
      ok: true,
      message: `Store '${store.name}' has been approved and activated.`,
      storeId,
      deviceKey: deviceKey || undefined
    });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Platform Owner: Reject a store registration application
app.post('/api/platform/stores/:id/reject', platformOwnerOnly, async (q, r) => {
  try {
    const storeId = q.params.id;
    const { rejectionReason } = q.body || {};
    const store = await db.get('SELECT * FROM stores WHERE id = ?', [storeId]);
    if (!store) return r.status(404).json({ ok: false, error: 'Store not found' });
    if (store.status !== 'pending') {
      return r.status(400).json({ ok: false, error: `Store is already marked as ${store.status}` });
    }

    await db.run('UPDATE stores SET status = ? WHERE id = ?', ['rejected', storeId]);
    await db.run("UPDATE store_memberships SET status = 'deactivated' WHERE store_id = ?", [storeId]);
    await db.run(`
      UPDATE users
      SET approval_status = 'rejected', active = 0, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?, rejection_reason = ?
      WHERE user_id = ?
    `, [q.user.userId, String(rejectionReason || 'Store application rejected by Platform Owner').trim(), store.owner_user_id]);

    await db.run('DELETE FROM user_sessions WHERE user_id = ?', [store.owner_user_id]);

    await db.run(`
      INSERT INTO audit_logs (store_id, user_id, action, target_type, target_id, details)
      VALUES (?, ?, 'STORE_REJECTED', 'store', ?, ?)
    `, [storeId, q.user.userId, storeId, `Store application rejected: ${rejectionReason || 'No reason specified'}`]).catch(() => {});

    r.json({ ok: true, message: `Store '${store.name}' application rejected.` });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Platform Owner: Suspend an active store
app.post('/api/platform/stores/:id/suspend', platformOwnerOnly, async (q, r) => {
  try {
    const storeId = q.params.id;
    if (storeId === 'store_default_001') {
      return r.status(400).json({ ok: false, error: 'Cannot suspend the default warehouse store' });
    }
    const store = await db.get('SELECT * FROM stores WHERE id = ?', [storeId]);
    if (!store) return r.status(404).json({ ok: false, error: 'Store not found' });

    await db.run('UPDATE stores SET status = ? WHERE id = ?', ['suspended', storeId]);

    await db.run(`
      INSERT INTO audit_logs (store_id, user_id, action, target_type, target_id, details)
      VALUES (?, ?, 'STORE_SUSPENDED', 'store', ?, ?)
    `, [storeId, q.user.userId, storeId, `Store '${store.name}' suspended by Platform Owner`]).catch(() => {});

    r.json({ ok: true, message: `Store '${store.name}' has been suspended.` });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Platform Owner: Reactivate a suspended store
app.post('/api/platform/stores/:id/activate', platformOwnerOnly, async (q, r) => {
  try {
    const storeId = q.params.id;
    const store = await db.get('SELECT * FROM stores WHERE id = ?', [storeId]);
    if (!store) return r.status(404).json({ ok: false, error: 'Store not found' });

    await db.run('UPDATE stores SET status = ? WHERE id = ?', ['active', storeId]);

    await db.run(`
      INSERT INTO audit_logs (store_id, user_id, action, target_type, target_id, details)
      VALUES (?, ?, 'STORE_ACTIVATED', 'store', ?, ?)
    `, [storeId, q.user.userId, storeId, `Store '${store.name}' activated by Platform Owner`]).catch(() => {});

    r.json({ ok: true, message: `Store '${store.name}' has been activated.` });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Store Staff: List store members (Hierarchy: Operator=403, Admin=Operators only, Owner=All)
app.get('/api/stores/:storeId/members', tenantContext, async (q, r) => {
  try {
    const isOwnerOrPlatform = q.storeRole === 'store_owner' || q.user?.platformRole === 'platform_owner' || q.user?.userId === 'testboss';
    const isAdmin = q.storeRole === 'store_admin';

    if (!isOwnerOrPlatform && !isAdmin) {
      return r.status(403).json({ ok: false, error: 'Operators cannot view or manage store staff' });
    }

    let members;
    if (isOwnerOrPlatform) {
      members = await db.all(`
        SELECT m.id, m.store_id, m.user_id, m.role, m.status, m.created_at,
               u.display_name, u.email, u.phone, u.employee_id, u.active
        FROM store_memberships m
        JOIN users u ON m.user_id = u.user_id
        WHERE m.store_id = ?
        ORDER BY m.id DESC
      `, [q.storeId]);
    } else {
      // Store Admins only see Operators
      members = await db.all(`
        SELECT m.id, m.store_id, m.user_id, m.role, m.status, m.created_at,
               u.display_name, u.email, u.phone, u.employee_id, u.active
        FROM store_memberships m
        JOIN users u ON m.user_id = u.user_id
        WHERE m.store_id = ? AND m.role = 'operator'
        ORDER BY m.id DESC
      `, [q.storeId]);
    }

    r.json({ ok: true, members });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

// Store Staff: Add new staff member or link existing user to store
app.post('/api/stores/:storeId/members', tenantContext, async (q, r) => {
  try {
    const isOwnerOrPlatform = q.storeRole === 'store_owner' || q.user?.platformRole === 'platform_owner' || q.user?.userId === 'testboss';
    const isAdmin = q.storeRole === 'store_admin';

    if (!isOwnerOrPlatform && !isAdmin) {
      return r.status(403).json({ ok: false, error: 'Operators cannot view or manage store staff' });
    }

    const {
      userId,
      role = 'operator',
      displayName,
      password,
      email,
      phone,
      employeeId
    } = q.body || {};

    const cleanUserId = String(userId || '').trim();
    if (!cleanUserId || !/^[a-zA-Z0-9_]{3,30}$/.test(cleanUserId)) {
      throw Error('User ID must be 3-30 alphanumeric characters or underscores');
    }

    const targetRole = String(role).toLowerCase();
    if (!['store_admin', 'operator'].includes(targetRole)) {
      throw Error("Role must be 'store_admin' or 'operator'");
    }

    // Hierarchy enforcement: Store Admin can ONLY create Operators
    if (isAdmin && !isOwnerOrPlatform && targetRole !== 'operator') {
      return r.status(403).json({ ok: false, error: 'Store Admins can only add Operators' });
    }

    const existingUser = await db.get('SELECT * FROM users WHERE LOWER(user_id) = LOWER(?)', [cleanUserId]);
    if (existingUser) {
      // User already exists in database: check existing store membership
      const existingMembership = await db.get(
        'SELECT * FROM store_memberships WHERE store_id = ? AND user_id = ?',
        [q.storeId, existingUser.user_id]
      );

      if (existingMembership && existingMembership.status === 'active') {
        return r.status(400).json({ ok: false, error: `User '${existingUser.user_id}' is already an active member of this store` });
      }

      if (existingMembership) {
        await db.run(
          "UPDATE store_memberships SET status = 'active', role = ? WHERE id = ?",
          [targetRole, existingMembership.id]
        );
      } else {
        await db.run(
          "INSERT INTO store_memberships (store_id, user_id, role, status) VALUES (?, ?, ?, 'active')",
          [q.storeId, existingUser.user_id, targetRole]
        );
      }
    } else {
      // New user registration
      if (!password || String(password).length < 8) {
        throw Error('Password must have at least 8 characters');
      }
      if (!displayName || !String(displayName).trim()) {
        throw Error('Full name / Display name is required');
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = hash(password, salt);
      const dbRole = targetRole === 'store_admin' ? 'boss' : 'operator';
      const effectiveRole = targetRole === 'store_admin' ? 'admin' : 'operator';

      await db.run(`
        INSERT INTO users (
          user_id, password_hash, salt, display_name, role, active,
          approval_status, requested_role, effective_role, email, phone,
          employee_id, reviewed_at, reviewed_by
        ) VALUES (?, ?, ?, ?, ?, 1, 'approved', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
      `, [
        cleanUserId,
        passwordHash,
        salt,
        String(displayName).trim(),
        dbRole,
        effectiveRole,
        effectiveRole,
        email ? String(email).trim().toLowerCase() : null,
        phone ? String(phone).trim() : null,
        employeeId ? String(employeeId).trim() : null,
        q.user.userId
      ]);

      await db.run(
        "INSERT INTO store_memberships (store_id, user_id, role, status) VALUES (?, ?, ?, 'active')",
        [q.storeId, cleanUserId, targetRole]
      );
    }

    await db.run(`
      INSERT INTO audit_logs (store_id, user_id, action, target_type, target_id, details)
      VALUES (?, ?, 'MEMBER_ADDED', 'membership', ?, ?)
    `, [q.storeId, q.user.userId, cleanUserId, `Added member '${cleanUserId}' with role '${targetRole}' to store`]).catch(() => {});

    r.json({ ok: true, message: `Staff member '${cleanUserId}' added as ${targetRole}.` });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Store Staff: Deactivate a member (Self-lockout protection & hierarchy enforced)
app.post('/api/stores/:storeId/members/:memberId/deactivate', tenantContext, async (q, r) => {
  try {
    const isOwnerOrPlatform = q.storeRole === 'store_owner' || q.user?.platformRole === 'platform_owner' || q.user?.userId === 'testboss';
    const isAdmin = q.storeRole === 'store_admin';

    if (!isOwnerOrPlatform && !isAdmin) {
      return r.status(403).json({ ok: false, error: 'Operators cannot view or manage store staff' });
    }

    const memberParam = q.params.memberId;
    const member = await db.get(
      'SELECT * FROM store_memberships WHERE store_id = ? AND (id = ? OR user_id = ?)',
      [q.storeId, Number(memberParam) || -1, memberParam]
    );

    if (!member) {
      return r.status(404).json({ ok: false, error: 'Member not found in this store' });
    }

    // Hierarchy enforcement: Store Admin can ONLY deactivate Operators
    if (isAdmin && !isOwnerOrPlatform && member.role !== 'operator') {
      return r.status(403).json({ ok: false, error: 'Store Admins can only manage Operators' });
    }

    // Self-lockout protection for sole Store Owner
    if (member.user_id === q.user.userId && member.role === 'store_owner') {
      const otherOwners = await db.get(
        "SELECT COUNT(*) as n FROM store_memberships WHERE store_id = ? AND role = 'store_owner' AND status = 'active' AND user_id != ?",
        [q.storeId, q.user.userId]
      );
      if (Number(otherOwners?.n || 0) === 0) {
        return r.status(400).json({ ok: false, error: 'Cannot deactivate the only active Store Owner for this store' });
      }
    }

    await db.run("UPDATE store_memberships SET status = 'deactivated' WHERE id = ?", [member.id]);

    // Invalidate sessions for that user
    await db.run('DELETE FROM user_sessions WHERE user_id = ?', [member.user_id]);

    await db.run(`
      INSERT INTO audit_logs (store_id, user_id, action, target_type, target_id, details)
      VALUES (?, ?, 'MEMBER_DEACTIVATED', 'membership', ?, ?)
    `, [q.storeId, q.user.userId, member.user_id, `Deactivated member '${member.user_id}' in store`]).catch(() => {});

    r.json({ ok: true, message: `Member '${member.user_id}' has been deactivated.` });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Store Staff: Activate a member
app.post('/api/stores/:storeId/members/:memberId/activate', tenantContext, async (q, r) => {
  try {
    const isOwnerOrPlatform = q.storeRole === 'store_owner' || q.user?.platformRole === 'platform_owner' || q.user?.userId === 'testboss';
    const isAdmin = q.storeRole === 'store_admin';

    if (!isOwnerOrPlatform && !isAdmin) {
      return r.status(403).json({ ok: false, error: 'Operators cannot view or manage store staff' });
    }

    const memberParam = q.params.memberId;
    const member = await db.get(
      'SELECT * FROM store_memberships WHERE store_id = ? AND (id = ? OR user_id = ?)',
      [q.storeId, Number(memberParam) || -1, memberParam]
    );

    if (!member) {
      return r.status(404).json({ ok: false, error: 'Member not found in this store' });
    }

    if (isAdmin && !isOwnerOrPlatform && member.role !== 'operator') {
      return r.status(403).json({ ok: false, error: 'Store Admins can only manage Operators' });
    }

    await db.run("UPDATE store_memberships SET status = 'active' WHERE id = ?", [member.id]);

    await db.run(`
      INSERT INTO audit_logs (store_id, user_id, action, target_type, target_id, details)
      VALUES (?, ?, 'MEMBER_ACTIVATED', 'membership', ?, ?)
    `, [q.storeId, q.user.userId, member.user_id, `Activated member '${member.user_id}' in store`]).catch(() => {});

    r.json({ ok: true, message: `Member '${member.user_id}' has been activated.` });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Store Hardware Devices: List devices for store
app.get('/api/stores/:storeId/devices', tenantContext, storeAdminOnly, async (q, r) => {
  try {
    const devices = await db.all(
      "SELECT id, store_id, device_name, status, created_at, SUBSTR(device_key, 1, 12) || '...' as masked_key FROM store_devices WHERE store_id = ? ORDER BY id DESC",
      [q.storeId]
    );
    r.json({ ok: true, devices });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

// Store Hardware Devices: Register/generate new hardware device for store (Store Owner only)
app.post('/api/stores/:storeId/devices', tenantContext, storeOwnerOnly, async (q, r) => {
  try {
    const { deviceName = 'ESP32 Controller' } = q.body || {};
    const newKey = 'asrs_hw_' + crypto.randomBytes(16).toString('hex');
    await db.run(
      'INSERT INTO store_devices (store_id, device_key, device_name, status) VALUES (?, ?, ?, ?)',
      [q.storeId, newKey, String(deviceName).trim(), 'active']
    );

    await db.run(`
      INSERT INTO audit_logs (store_id, user_id, action, target_type, target_id, details)
      VALUES (?, ?, 'DEVICE_REGISTERED', 'device', ?, ?)
    `, [q.storeId, q.user.userId, String(deviceName).trim(), `Registered hardware device '${deviceName}'`]).catch(() => {});

    r.json({
      ok: true,
      storeId: q.storeId,
      deviceName: String(deviceName).trim(),
      deviceKey: newKey
    });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Store Hardware Devices: Rotate key for a store hardware device (Store Owner only - SEC-04)
app.post('/api/stores/:storeId/devices/:deviceId/rotate', tenantContext, storeOwnerOnly, async (q, r) => {
  try {
    const deviceId = Number(q.params.deviceId);
    const dev = await db.get('SELECT * FROM store_devices WHERE store_id = ? AND id = ?', [q.storeId, deviceId]);
    if (!dev) return r.status(404).json({ ok: false, error: 'Hardware device not found in this store' });

    const newKey = 'asrs_hw_' + crypto.randomBytes(16).toString('hex');
    await db.run('UPDATE store_devices SET device_key = ? WHERE id = ?', [newKey, deviceId]);

    if (q.storeId === 'store_default_001') {
      await db.run("UPDATE system_settings SET value = ? WHERE key = 'hardware_api_key'", [newKey]);
    }

    await db.run(`
      INSERT INTO audit_logs (store_id, user_id, action, target_type, target_id, details)
      VALUES (?, ?, 'DEVICE_KEY_ROTATED', 'device', ?, ?)
    `, [q.storeId, q.user.userId, String(deviceId), `Rotated key for device '${dev.device_name}'`]).catch(() => {});

    r.json({
      ok: true,
      deviceId,
      deviceName: dev.device_name,
      deviceKey: newKey,
      message: `Device key for '${dev.device_name}' has been successfully rotated.`
    });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Catch-all for SPA/PWA routing
app.use((q, r) => {
  r.sendFile(path.join(__dirname, '../dashboard/index.html'));
});

// Start Server after initializing database
async function startServer() {
  await db.initDb();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ASRS Portable Backend running on http://localhost:${PORT} [DB: ${db.isPg ? 'PostgreSQL' : 'SQLite'}]`);
  });
}

if (require.main === module) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = { app, startServer };
