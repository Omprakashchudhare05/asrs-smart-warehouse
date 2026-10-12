const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
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
const safeUser = u => ({
  id: u.id,
  userId: u.user_id,
  displayName: u.display_name,
  role: u.role,
  email: u.email || null,
  phone: u.phone || null,
  emailVerified: Boolean(u.email_verified),
  phoneVerified: Boolean(u.phone_verified),
  email_verified: Number(u.email_verified || 0),
  phone_verified: Number(u.phone_verified || 0)
});

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
      "SELECT * FROM users WHERE (LOWER(user_id) = ? OR LOWER(email) = ? OR phone = ?) AND role = 'boss' AND active = 1",
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
      "SELECT * FROM users WHERE (LOWER(user_id) = ? OR LOWER(email) = ? OR phone = ?) AND role = 'boss' AND active = 1",
      [clean, clean, String(identifier).trim()]
    );
    if (!user) {
      throw Error('Administrator account not found');
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
    const u = await db.get('SELECT * FROM users WHERE user_id=? AND active=1', [String(userId || '')]);
    if (!u || !password || hash(password, u.salt) !== u.password_hash) {
      return r.status(401).json({ ok: false, error: 'Invalid User ID or password' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    // Save session in database for persistent multi-device access
    await db.run('INSERT INTO user_sessions (token, user_id, display_name, role) VALUES (?, ?, ?, ?)', [
      token,
      u.user_id,
      u.display_name,
      u.role
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
  const session = await db.get('SELECT * FROM user_sessions WHERE token=?', [token]);
  if (!session) {
    return r.status(401).json({ ok: false, error: 'Session expired or invalid. Please log in again.' });
  }
  q.user = {
    userId: session.user_id,
    displayName: session.display_name,
    role: session.role
  };
  next();
}

// Boss/Admin Only Middleware
function bossOnly(q, r, next) {
  if (q.user?.role === 'boss') {
    return next();
  }
  return r.status(403).json({ ok: false, error: 'Boss/Admin permission required' });
}

// Hardware API Key Authentication Middleware (for ESP32 / Keypad)
async function hardwareAuth(q, r, next) {
  const key = q.headers['x-hardware-key'] || q.query.key;
  if (!key) {
    return r.status(401).json({ ok: false, error: 'Missing hardware API key. Device authentication required.' });
  }
  const setting = await db.get("SELECT value FROM system_settings WHERE key='hardware_api_key'");
  if (!setting || setting.value !== String(key).trim()) {
    return r.status(401).json({ ok: false, error: 'Invalid hardware API key.' });
  }
  q.user = {
    userId: 'esp32_device',
    displayName: 'ESP32 Device',
    role: 'hardware'
  };
  next();
}

// Unified Atomic Movement Handler (Store & Retrieve - Race condition & double-click safe)
async function handleMovement(action, slotCode, itemNum, quantity, source, user) {
  quantity = Number(quantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw Error('Quantity must be a positive whole number');
  }
  const code = String(slotCode || '').trim().toUpperCase();
  const s = await db.get('SELECT * FROM slots WHERE slot=?', [code]);
  if (!s) throw Error(`Slot ${code} not found in warehouse rack`);

  if (itemNum && Number(itemNum) !== s.item) {
    throw Error('Selected item ID does not match the slot');
  }

  // Atomic conditional SQL update: eliminates race conditions and double-click errors
  let result;
  if (action === 'STORE') {
    result = await db.run(
      'UPDATE slots SET quantity = quantity + ?, occupied = 1 WHERE slot = ? AND (quantity + ?) <= capacity',
      [quantity, code, quantity]
    );
  } else if (action === 'RETRIEVE') {
    result = await db.run(
      'UPDATE slots SET quantity = quantity - ?, occupied = CASE WHEN (quantity - ?) > 0 THEN 1 ELSE 0 END WHERE slot = ? AND (quantity - ?) >= 0',
      [quantity, quantity, code, quantity]
    );
  } else {
    throw Error(`Unsupported movement action: ${action}`);
  }

  if (result.changes === 0) {
    const cur = await db.get('SELECT quantity, capacity FROM slots WHERE slot=?', [code]);
    if (!cur) throw Error(`Slot ${code} not found in warehouse rack`);
    if (action === 'STORE') {
      const free = Math.max(0, Number(cur.capacity || 10) - Number(cur.quantity || 0));
      throw Error(`Slot capacity exceeded. Available free space: ${free} unit(s)`);
    } else {
      const available = Number(cur.quantity || 0);
      throw Error(`Insufficient stock in slot ${code}. Available stock: ${available} unit(s)`);
    }
  }

  const updatedSlot = await db.get("SELECT slot, item, item_name, sku, x, y, occupied, quantity, capacity, CASE WHEN quantity<=0 THEN 'EMPTY' WHEN quantity>=capacity THEN 'FULL' ELSE 'AVAILABLE' END status FROM slots WHERE slot=?", [code]);

  const after = Number(updatedSlot.quantity);
  const before = action === 'STORE' ? after - quantity : after + quantity;

  await db.run(`
    INSERT INTO transactions (
      action, slot, item, item_name, sku, source, time,
      quantity, before_quantity, after_quantity, user_name, role
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?)
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
    user?.role || 'operator'
  ]);

  return updatedSlot;
}

// ---------------- HARDWARE ROUTES (ESP32 / Keypad) ----------------
app.post('/api/hardware/store', hardwareAuth, async (q, r) => {
  try {
    const { slot, item, quantity = 1, source = 'keypad' } = q.body || {};
    const updatedSlot = await handleMovement('STORE', slot, item, quantity, source, q.user);
    r.json({ ok: true, message: 'Stock stored via hardware', slot: updatedSlot });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/hardware/retrieve', hardwareAuth, async (q, r) => {
  try {
    const { slot, item, quantity = 1, source = 'keypad' } = q.body || {};
    const updatedSlot = await handleMovement('RETRIEVE', slot, item, quantity, source, q.user);
    r.json({ ok: true, message: 'Stock retrieved via hardware', slot: updatedSlot });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// ---------------- PROTECTED WEB DASHBOARD ROUTES ----------------
app.use(authenticateUser);

// Get all rack slots
app.get('/slots', async (q, r) => {
  try {
    const allSlots = await db.all("SELECT slot, item, item_name, sku, x, y, occupied, quantity, capacity, CASE WHEN quantity<=0 THEN 'EMPTY' WHEN quantity>=capacity THEN 'FULL' ELSE 'AVAILABLE' END status FROM slots ORDER BY slot");
    r.json(allSlots);
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

// Get recent transactions
app.get('/transactions', async (q, r) => {
  try {
    const txs = await db.all('SELECT id, action, slot, item, item_name, sku, source, time, quantity, before_quantity, after_quantity, user_name, role FROM transactions ORDER BY id DESC LIMIT 1000');
    r.json(txs);
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

// Get warehouse summary stats
app.get('/summary', async (q, r) => {
  try {
    const allSlots = await db.all('SELECT quantity, capacity FROM slots');
    const storedRes = await db.get("SELECT COALESCE(SUM(quantity), 0) as n FROM transactions WHERE action='STORE'");
    const retrievedRes = await db.get("SELECT COALESCE(SUM(quantity), 0) as n FROM transactions WHERE action='RETRIEVE'");
    const rack = await db.get('SELECT rows, cols FROM rack_config WHERE id=1');

    const inventory = allSlots.reduce((a, s) => a + Number(s.quantity || 0), 0);
    const occupiedSlots = allSlots.filter(s => Number(s.quantity || 0) > 0).length;
    const freeCapacity = allSlots.reduce((a, s) => a + Math.max(0, Number(s.capacity || 10) - Number(s.quantity || 0)), 0);

    r.json({
      inventory,
      stored: Number(storedRes?.n || 0),
      retrieved: Number(retrievedRes?.n || 0),
      occupiedSlots,
      totalSlots: allSlots.length,
      freeCapacity,
      rack: rack || { rows: 4, cols: 4 }
    });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

// Web Store & Retrieve
app.post('/store', async (q, r) => {
  try {
    const { slot, item, quantity = 1, source = 'dashboard' } = q.body || {};
    const updatedSlot = await handleMovement('STORE', slot, item, quantity, source, q.user);
    r.json({ ok: true, slot: updatedSlot });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/retrieve', async (q, r) => {
  try {
    const { slot, item, quantity = 1, source = 'dashboard' } = q.body || {};
    const updatedSlot = await handleMovement('RETRIEVE', slot, item, quantity, source, q.user);
    r.json({ ok: true, slot: updatedSlot });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Update product name & SKU
app.put('/slots/:slot/product', async (q, r) => {
  try {
    const code = String(q.params.slot).toUpperCase();
    const s = await db.get('SELECT * FROM slots WHERE slot=?', [code]);
    if (!s) throw Error('Slot not found');
    const { item_name, sku } = q.body || {};
    if (!String(item_name || '').trim() || !String(sku || '').trim()) {
      throw Error('Product name and SKU are required');
    }
    await db.run('UPDATE slots SET item_name=?, sku=? WHERE slot=?', [
      String(item_name).trim(),
      String(sku).trim(),
      code
    ]);
    const updated = await db.get("SELECT slot, item, item_name, sku, x, y, occupied, quantity, capacity, CASE WHEN quantity<=0 THEN 'EMPTY' WHEN quantity>=capacity THEN 'FULL' ELSE 'AVAILABLE' END status FROM slots WHERE slot=?", [code]);
    r.json({ ok: true, slot: updated });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Update slot capacity (Boss only)
app.put('/slots/:slot/capacity', bossOnly, async (q, r) => {
  try {
    const code = String(q.params.slot).toUpperCase();
    const s = await db.get('SELECT * FROM slots WHERE slot=?', [code]);
    if (!s) throw Error('Slot not found');
    const cap = Number((q.body || {}).capacity);
    if (!Number.isInteger(cap) || cap < 1 || cap < Number(s.quantity || 0)) {
      throw Error('Capacity must be a positive whole number at least as large as current stock');
    }
    await db.run('UPDATE slots SET capacity=? WHERE slot=?', [cap, code]);
    const updated = await db.get("SELECT slot, item, item_name, sku, x, y, occupied, quantity, capacity, CASE WHEN quantity<=0 THEN 'EMPTY' WHEN quantity>=capacity THEN 'FULL' ELSE 'AVAILABLE' END status FROM slots WHERE slot=?", [code]);
    r.json({ ok: true, slot: updated });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Dynamic Rack Size Configuration (Boss only)
app.get('/rack/config', async (q, r) => {
  try {
    const config = await db.get('SELECT rows, cols FROM rack_config WHERE id=1');
    r.json(config || { rows: 4, cols: 4 });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/rack/dimensions', bossOnly, async (q, r) => {
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

    const currentSlots = await db.all('SELECT slot, quantity, item_name FROM slots');
    const outOfBoundsOccupied = currentSlots.filter(s => !validSlotSet.has(s.slot) && Number(s.quantity || 0) > 0);

    // Prevent data loss if any shrinking slot is occupied
    if (outOfBoundsOccupied.length > 0) {
      const list = outOfBoundsOccupied.map(s => `${s.slot} (${s.quantity} units of '${s.item_name}')`).join(', ');
      throw Error(`Cannot shrink rack. The following slots contain stock: ${list}. Please retrieve or move items first.`);
    }

    // Safe to delete out of bounds empty slots
    const outOfBoundsEmpty = currentSlots.filter(s => !validSlotSet.has(s.slot));
    for (const s of outOfBoundsEmpty) {
      await db.run('DELETE FROM slots WHERE slot=?', [s.slot]);
    }

    // Add any newly created slots
    const existingSlotMap = new Map(currentSlots.map(s => [s.slot, s]));
    let maxItemRes = await db.get('SELECT COALESCE(MAX(item), 0) as m FROM slots');
    let nextItemNum = Number(maxItemRes?.m || 0) + 1;

    for (let rowIdx = 0; rowIdx < newRows; rowIdx++) {
      const rowLetter = String.fromCharCode(65 + rowIdx);
      for (let colIdx = 1; colIdx <= newCols; colIdx++) {
        const slotCode = `${rowLetter}${colIdx}`;
        if (!existingSlotMap.has(slotCode)) {
          await db.run(`
            INSERT INTO slots (slot, item, x, y, occupied, quantity, capacity, item_name, sku)
            VALUES (?, ?, ?, ?, 0, 0, 10, ?, ?)
          `, [
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

    await db.run('UPDATE rack_config SET rows=?, cols=?, updated_at=CURRENT_TIMESTAMP WHERE id=1', [newRows, newCols]);
    const updatedSlots = await db.all("SELECT slot, item, item_name, sku, x, y, occupied, quantity, capacity, CASE WHEN quantity<=0 THEN 'EMPTY' WHEN quantity>=capacity THEN 'FULL' ELSE 'AVAILABLE' END status FROM slots ORDER BY slot");

    r.json({ ok: true, rows: newRows, cols: newCols, totalSlots: updatedSlots.length });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

// Hardware API Key Management (Boss only)
app.get('/hardware/key', bossOnly, async (q, r) => {
  try {
    const keyRow = await db.get("SELECT value FROM system_settings WHERE key='hardware_api_key'");
    r.json({ ok: true, hardwareApiKey: keyRow?.value || '' });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/hardware/key/regenerate', bossOnly, async (q, r) => {
  try {
    const newKey = 'asrs_hw_' + crypto.randomBytes(16).toString('hex');
    await db.run("UPDATE system_settings SET value=? WHERE key='hardware_api_key'", [newKey]);
    r.json({ ok: true, hardwareApiKey: newKey });
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

// User Management (Boss only)
app.get('/users', bossOnly, async (q, r) => {
  try {
    const users = await db.all('SELECT id, user_id, display_name, role, active, email, phone, email_verified, phone_verified, created_at FROM users ORDER BY id');
    r.json(users);
  } catch (e) {
    r.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/users', bossOnly, async (q, r) => {
  try {
    const { userId, password, displayName } = q.body || {};
    if (!userId || !password || password.length < 8 || !displayName) {
      throw Error('User ID, display name and password (8+ characters) are required');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    await db.run("INSERT INTO users(user_id, password_hash, salt, display_name, role) VALUES(?, ?, ?, ?, 'operator')", [
      String(userId).trim(),
      hash(password, salt),
      salt,
      String(displayName).trim()
    ]);
    r.json({ ok: true });
  } catch (e) {
    r.status(400).json({ ok: false, error: e.message });
  }
});

app.patch('/users/:id', bossOnly, async (q, r) => {
  try {
    const id = Number(q.params.id);
    const u = await db.get('SELECT * FROM users WHERE id=?', [id]);
    if (!u || u.role === 'boss') throw Error('Operator not found');
    const { displayName, active, password } = q.body || {};
    if (displayName !== undefined) {
      await db.run('UPDATE users SET display_name=? WHERE id=?', [String(displayName).trim(), id]);
    }
    if (active !== undefined) {
      await db.run('UPDATE users SET active=? WHERE id=?', [active ? 1 : 0, id]);
    }
    if (password) {
      if (password.length < 8) throw Error('Password must have at least 8 characters');
      const salt = crypto.randomBytes(16).toString('hex');
      await db.run('UPDATE users SET password_hash=?, salt=? WHERE id=?', [hash(password, salt), salt, id]);
    }
    r.json({ ok: true });
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
