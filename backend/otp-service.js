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
  const emailConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);
  const smsConfigured = Boolean(
    (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) ||
    (process.env.SMS_GATEWAY_URL && process.env.SMS_API_KEY)
  );
  return {
    email: {
      configured: emailConfigured,
      provider: emailConfigured ? 'SMTP (' + process.env.SMTP_HOST + ')' : 'None (requires SMTP_HOST, SMTP_USER, SMTP_PASS)'
    },
    sms: {
      configured: smsConfigured,
      provider: smsConfigured
        ? (process.env.TWILIO_ACCOUNT_SID ? 'Twilio SMS' : 'Custom SMS Gateway')
        : 'None (requires TWILIO_ACCOUNT_SID or SMS_GATEWAY_URL)'
    }
  };
}

/**
 * Dispatch Email OTP via configured SMTP provider
 */
async function sendEmailOtp({ email, otp, purpose, userId }) {
  // Test hook for isolated testing
  if (process.env.NODE_ENV === 'test' && typeof testOtpListener === 'function') {
    testOtpListener({ type: 'email', identifier: email, otp, purpose, userId });
  }

  const { email: emailStatus } = getProviderStatus();
  if (!emailStatus.configured) {
    // Log clearly without revealing plaintext OTP
    console.warn(`[OTP Service] Email OTP generated for ${maskEmail(email)} (${purpose}), but SMTP credentials are not configured in environment.`);
    return {
      success: false,
      configured: false,
      provider: 'smtp',
      message: 'SMTP credentials not configured in environment variables (SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM).'
    };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    const subject = purpose === 'admin_registration'
      ? 'ASRS Smart Warehouse - Admin Registration Verification Code'
      : 'ASRS Smart Warehouse - Password Reset Verification Code';

    await transporter.sendMail({
      from: process.env.SMTP_FROM || `"ASRS System" <${process.env.SMTP_USER}>`,
      to: email,
      subject,
      text: `Your ASRS verification code is: ${otp}\n\nThis code is valid for 5 minutes. Do not share this code with anyone.`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #222;">
          <h2 style="color: #2463eb;">ASRS Smart Warehouse</h2>
          <p>Your one-time verification code is:</p>
          <div style="font-size: 28px; font-weight: bold; letter-spacing: 4px; background: #f1f5f9; padding: 12px 20px; border-radius: 6px; display: inline-block;">
            ${otp}
          </div>
          <p style="color: #64748b; font-size: 13px; margin-top: 16px;">This code expires in 5 minutes. If you did not request this, please ignore this email.</p>
        </div>
      `
    });

    console.log(`[OTP Service] Email OTP successfully dispatched to ${maskEmail(email)} via SMTP.`);
    return { success: true, configured: true, provider: 'smtp' };
  } catch (err) {
    console.error(`[OTP Service] Failed to send email to ${maskEmail(email)}:`, err.message);
    return { success: false, configured: true, provider: 'smtp', error: err.message };
  }
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
  setTestOtpListener
};
