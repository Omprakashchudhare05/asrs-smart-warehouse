/**
 * ASRS Secure OTP Service
 * Handles cryptographically secure OTP generation, hashing, rate limiting,
 * and delivery via Email (SMTP) and SMS (Twilio / Gateway).
 * 
 * STRICT SECURITY:
 * - Plaintext OTP is NEVER stored in database.
 * - Plaintext OTP is NEVER printed in logs or API responses.
 * - OTP expiration: strictly 5 minutes (300 seconds).
 * - Max attempt enforcement & cooldown limits.
 */

const crypto = require('crypto');
const nodemailer = require('nodemailer');

const OTP_SECRET = process.env.OTP_SECRET || 'asrs_secure_otp_salt_v2026';
const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
const MAX_VERIFY_ATTEMPTS = 5;
const MAX_RESEND_COUNT = 3;

// Test event hook: ONLY used during automated tests with isolated test DB
let testOtpListener = null;
function setTestOtpListener(listener) {
  if (process.env.NODE_ENV === 'test') {
    testOtpListener = listener;
  }
}

/**
 * Generate cryptographically random 6-digit OTP string
 */
function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * Hash an OTP using HMAC-SHA256 with server salt
 */
function hashOtp(otp) {
  return crypto.createHmac('sha256', OTP_SECRET).update(String(otp).trim()).digest('hex');
}

/**
 * Timing-safe comparison of provided OTP against stored hash
 */
function verifyOtpHash(inputOtp, storedHash) {
  if (!inputOtp || !storedHash) return false;
  try {
    const inputHash = hashOtp(inputOtp);
    const bufA = Buffer.from(inputHash, 'hex');
    const bufB = Buffer.from(storedHash, 'hex');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Mask email for safe logging and response display
 * e.g. "admin.boss@example.com" -> "a***s@example.com"
 */
function maskEmail(email) {
  if (!email || !email.includes('@')) return '***@***';
  const [local, domain] = email.split('@');
  if (local.length <= 2) {
    return `${local[0]}*@${domain}`;
  }
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

/**
 * Mask phone number for safe logging and response display
 * e.g. "+919876543210" -> "+91*****3210"
 */
function maskPhone(phone) {
  if (!phone) return '***';
  const s = String(phone).trim();
  if (s.length <= 4) return '***';
  return s.slice(0, 3) + '*****' + s.slice(-4);
}

/**
 * Inspect configured providers from environment
 */
function getProviderStatus() {
  const brevoConfigured = Boolean(process.env.BREVO_API_KEY && process.env.BREVO_API_KEY.trim());
  const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  const emailConfigured = brevoConfigured || smtpConfigured;

  let emailProvider = 'None (requires BREVO_API_KEY or SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM)';
  if (brevoConfigured) {
    emailProvider = 'Brevo HTTPS API';
  } else if (smtpConfigured) {
    emailProvider = 'SMTP (' + process.env.SMTP_HOST + ')';
  }

  const smsConfigured = Boolean(
    (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) ||
    (process.env.SMS_GATEWAY_URL && process.env.SMS_API_KEY)
  );
  return {
    email: {
      configured: emailConfigured,
      provider: emailProvider
    },
    sms: {
      configured: smsConfigured,
      provider: smsConfigured
        ? (process.env.TWILIO_ACCOUNT_SID ? 'Twilio SMS' : 'Custom SMS Gateway')
        : 'Disabled (zero recurring cost policy)'
    }
  };
}

/**
 * Dispatch Email via Brevo HTTPS API (primary) or SMTP (fallback)
 */
async function dispatchEmail({ to, subject, text, html, purpose, logLabel = 'Email' }) {
  const { email: emailStatus } = getProviderStatus();
  if (!emailStatus.configured) {
    console.warn(`[OTP Service] ${logLabel} queued for ${maskEmail(to)}${purpose ? ' (' + purpose + ')' : ''}, but email credentials are not configured in environment.`);
    return {
      success: false,
      configured: false,
      provider: 'none',
      message: 'Email credentials not configured in environment variables (BREVO_API_KEY or SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM).'
    };
  }

  const brevoApiKey = (process.env.BREVO_API_KEY || '').trim();

  // Primary: Brevo HTTPS REST API (Port 443 - zero SMTP port block)
  if (brevoApiKey) {
    try {
      const senderEmail = (process.env.BREVO_SENDER_EMAIL || process.env.SMTP_USER || 'asrs.warehouse.system@gmail.com').trim();
      const senderName = (process.env.BREVO_SENDER_NAME || 'ASRS Smart Warehouse').trim();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'api-key': brevoApiKey,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: [{ email: to }],
          subject,
          textContent: text,
          htmlContent: html
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const errMsg = data.message || `Brevo API returned HTTP ${res.status}`;
        console.error(`[OTP Service] Failed to send ${logLabel.toLowerCase()} to ${maskEmail(to)} via Brevo:`, errMsg);
        return { success: false, configured: true, provider: 'brevo_https', error: errMsg };
      }

      console.log(`[OTP Service] ${logLabel} successfully dispatched to ${maskEmail(to)} via Brevo HTTPS API.`);
      return { success: true, configured: true, provider: 'brevo_https', messageId: data.messageId };
    } catch (err) {
      console.error(`[OTP Service] Brevo HTTPS request error for ${maskEmail(to)}:`, err.message);
      return { success: false, configured: true, provider: 'brevo_https', error: err.message };
    }
  }

  // Fallback: SMTP (e.g. for local environment or non-blocked environments)
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      },
      connectionTimeout: 10000
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || `"ASRS System" <${process.env.SMTP_USER}>`,
      to,
      subject,
      text,
      html
    });

    console.log(`[OTP Service] ${logLabel} successfully dispatched to ${maskEmail(to)} via SMTP.`);
    return { success: true, configured: true, provider: 'smtp' };
  } catch (err) {
    console.error(`[OTP Service] Failed to send ${logLabel.toLowerCase()} to ${maskEmail(to)} via SMTP:`, err.message);
    return { success: false, configured: true, provider: 'smtp', error: err.message };
  }
}

/**
 * Dispatch Email OTP via Brevo HTTPS API (primary) or SMTP (fallback)
 */
async function sendEmailOtp({ email, otp, purpose, userId }) {
  // Test hook for isolated testing
  if (process.env.NODE_ENV === 'test' && typeof testOtpListener === 'function') {
    testOtpListener({ type: 'email', identifier: email, otp, purpose, userId });
  }

  let subject = 'ASRS Smart Warehouse - Verification Code';
  if (purpose === 'admin_registration' || purpose === 'operator_registration' || purpose === 'registration') {
    subject = 'ASRS Smart Warehouse - Account Registration Verification Code';
  } else if (purpose === 'forgot_password' || purpose === 'password_reset') {
    subject = 'ASRS Smart Warehouse - Password Reset Verification Code';
  } else if (purpose === 'profile_verification') {
    subject = 'ASRS Smart Warehouse - Profile Email Verification Code';
  }

  const text = `Your ASRS verification code is: ${otp}\n\nThis code is valid for 5 minutes. Do not share this code with anyone.`;
  const html = `
    <div style="font-family: Arial, sans-serif; padding: 20px; color: #222;">
      <h2 style="color: #2463eb;">ASRS Smart Warehouse</h2>
      <p>Your one-time verification code is:</p>
      <div style="font-size: 28px; font-weight: bold; letter-spacing: 4px; background: #f1f5f9; padding: 12px 20px; border-radius: 6px; display: inline-block;">
        ${otp}
      </div>
      <p style="color: #64748b; font-size: 13px; margin-top: 16px;">This code expires in 5 minutes. If you did not request this, please ignore this email.</p>
    </div>
  `;

  return dispatchEmail({ to: email, subject, text, html, purpose, logLabel: 'Email OTP' });
}

/**
 * Send account confirmation email with User ID (NEVER includes plaintext password)
 */
async function sendRegistrationConfirmationEmail({ email, userId, displayName, storeName }) {
  if (process.env.NODE_ENV === 'test' && typeof testOtpListener === 'function') {
    testOtpListener({ type: 'email', identifier: email, purpose: 'registration_confirmation', userId });
  }

  const subject = 'ASRS Smart Warehouse - Account Registration Confirmed';
  const text = `Hello ${displayName || userId},\n\nYour ASRS registration request has been submitted successfully.\n\nAccount Details:\n- User ID: ${userId}\n- Email: ${email}\n${storeName ? `- Store: ${storeName}\n` : ''}- Status: Pending Administrator Approval\n\nNote: You will be able to log in once your store administrator approves your account.\n\nThank you,\nASRS Team`;
  const html = `
    <div style="font-family: Arial, sans-serif; padding: 20px; color: #222;">
      <h2 style="color: #2463eb;">ASRS Smart Warehouse</h2>
      <p>Hello <b>${displayName || userId}</b>,</p>
      <p>Your ASRS account registration request has been submitted successfully.</p>
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px; margin: 16px 0;">
        <p style="margin: 4px 0;"><b>User ID:</b> <code>${userId}</code></p>
        <p style="margin: 4px 0;"><b>Registered Email:</b> ${email}</p>
        ${storeName ? `<p style="margin: 4px 0;"><b>Assigned Store:</b> ${storeName}</p>` : ''}
        <p style="margin: 4px 0;"><b>Status:</b> <span style="color: #d97706; font-weight: bold;">Pending Administrator Approval</span></p>
      </div>
      <p style="color: #64748b; font-size: 13px;">Your store administrator will review your application. You will be able to sign in once approved.</p>
    </div>
  `;

  return dispatchEmail({ to: email, subject, text, html, purpose: 'registration_confirmation', logLabel: 'Registration Confirmation' });
}

/**
 * Send password reset token email
 */
async function sendPasswordResetTokenEmail({ email, userId, displayName, resetToken }) {
  if (process.env.NODE_ENV === 'test' && typeof testOtpListener === 'function') {
    testOtpListener({ type: 'email', identifier: email, purpose: 'password_reset_token', userId, resetToken });
  }

  const subject = 'ASRS Smart Warehouse - Password Reset Approved';
  const text = `Hello ${displayName || userId},\n\nYour password reset request has been approved by your store administrator.\n\nYour single-use password reset token is: ${resetToken}\n\nThis token is valid for 1 hour. Please complete your password reset in the ASRS dashboard.\n\nThank you,\nASRS Team`;
  const html = `
    <div style="font-family: Arial, sans-serif; padding: 20px; color: #222;">
      <h2 style="color: #2463eb;">ASRS Smart Warehouse</h2>
      <p>Hello <b>${displayName || userId}</b>,</p>
      <p>Your password reset request has been approved by your store administrator.</p>
      <p>Your single-use password reset token is:</p>
      <div style="font-family: monospace; font-size: 18px; font-weight: bold; background: #f1f5f9; padding: 12px; border-radius: 6px; word-break: break-all;">
        ${resetToken}
      </div>
      <p style="color: #64748b; font-size: 13px; margin-top: 14px;">This token expires in 1 hour. Please enter it in the password reset form to set your new password.</p>
    </div>
  `;

  return dispatchEmail({ to: email, subject, text, html, purpose: 'password_reset_token', logLabel: 'Password Reset Token' });
}

/**
 * Dispatch SMS OTP via Twilio or generic REST Gateway
 */
async function sendSmsOtp({ phone, otp, purpose, userId }) {
  // Test hook for isolated testing
  if (process.env.NODE_ENV === 'test' && typeof testOtpListener === 'function') {
    testOtpListener({ type: 'phone', identifier: phone, otp, purpose, userId });
  }

  const { sms: smsStatus } = getProviderStatus();
  if (!smsStatus.configured) {
    console.warn(`[OTP Service] Mobile OTP generated for ${maskPhone(phone)} (${purpose}), but SMS credentials are not configured in environment.`);
    return {
      success: false,
      configured: false,
      provider: 'sms',
      message: 'SMS provider credentials not configured in environment variables (TWILIO_ACCOUNT_SID or SMS_GATEWAY_URL).'
    };
  }

  // Option A: Twilio
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`;
      const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
      const body = new URLSearchParams({
        To: phone,
        From: process.env.TWILIO_PHONE_NUMBER,
        Body: `ASRS Verification Code: ${otp}. Valid for 5 minutes. Do not share.`
      });

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Twilio error (${res.status}): ${errText}`);
      }

      console.log(`[OTP Service] SMS OTP successfully sent to ${maskPhone(phone)} via Twilio.`);
      return { success: true, configured: true, provider: 'twilio' };
    } catch (err) {
      console.error(`[OTP Service] Failed to send SMS to ${maskPhone(phone)}:`, err.message);
      return { success: false, configured: true, provider: 'twilio', error: err.message };
    }
  }

  // Option B: Generic SMS Gateway URL
  if (process.env.SMS_GATEWAY_URL) {
    try {
      const res = await fetch(process.env.SMS_GATEWAY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.SMS_API_KEY ? { 'Authorization': `Bearer ${process.env.SMS_API_KEY}` } : {})
        },
        body: JSON.stringify({
          to: phone,
          message: `ASRS Verification Code: ${otp}. Valid for 5 minutes.`
        })
      });
      if (!res.ok) throw new Error(`Gateway returned HTTP ${res.status}`);
      console.log(`[OTP Service] SMS OTP successfully dispatched to ${maskPhone(phone)} via SMS Gateway.`);
      return { success: true, configured: true, provider: 'gateway' };
    } catch (err) {
      console.error(`[OTP Service] SMS gateway delivery failed:`, err.message);
      return { success: false, configured: true, provider: 'gateway', error: err.message };
    }
  }

  return { success: false, configured: false };
}

module.exports = {
  OTP_EXPIRY_MS,
  RESEND_COOLDOWN_MS,
  MAX_VERIFY_ATTEMPTS,
  MAX_RESEND_COUNT,
  generateOtp,
  hashOtp,
  verifyOtpHash,
  maskEmail,
  maskPhone,
  getProviderStatus,
  sendEmailOtp,
  sendSmsOtp,
  sendMobileOtp: sendSmsOtp,
  sendRegistrationConfirmationEmail,
  sendPasswordResetTokenEmail,
  setTestOtpListener
};
