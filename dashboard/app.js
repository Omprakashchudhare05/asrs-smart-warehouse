const BACKEND = window.location.origin;
let token = '', me = null, slots = [], transactions = [], users = [], page = 'dashboard';
let rackConfig = { rows: 4, cols: 4 };
let hardwareKey = '';
let inventoryFilter = '', historyFilter = '';
let refreshInterval = null;

// Multi-Tenant SaaS State
let userStores = [];
let activeStoreId = '';
let activeStore = null;
let isPlatformOwner = false;
let platformStoresList = [];
let platformPendingStoresList = [];
let storeMembersList = [];
let storeDevicesList = [];

const $ = id => document.getElementById(id);

const menus = {
  platform_owner: [
    ['dashboard', '▣', 'Dashboard'],
    ['inventory', '▤', 'Inventory'],
    ['rack', '▦', 'Dynamic Rack'],
    ['history', '◷', 'History & Export'],
    ['platform_stores', '🏬', 'Platform Stores'],
    ['approvals', '✓', 'Admin Approvals'],
    ['settings', '⚙', 'Settings & Hardware'],
    ['profile', '👤', 'My Profile']
  ],
  owner: [
    ['dashboard', '▣', 'Dashboard'],
    ['inventory', '▤', 'Inventory'],
    ['rack', '▦', 'Dynamic Rack'],
    ['history', '◷', 'History & Export'],
    ['store_staff', '👥', 'Store Staff'],
    ['store_devices', '📱', 'Store Devices'],
    ['approvals', '✓', 'Approval Queue'],
    ['admin_mgmt', '♟', 'Admin Management'],
    ['users', '👥', 'User Management'],
    ['settings', '⚙', 'Settings & Hardware'],
    ['profile', '👤', 'My Profile']
  ],
  admin: [
    ['dashboard', '▣', 'Dashboard'],
    ['inventory', '▤', 'Warehouse Inventory'],
    ['history', '◷', 'History & Export'],
    ['store_staff', '👥', 'Store Staff'],
    ['store_devices', '📱', 'Store Devices'],
    ['operator_mgmt', '♟', 'Operator Management'],
    ['profile', '👤', 'My Profile']
  ],
  operator: [
    ['dashboard', '▣', 'Dashboard'],
    ['store', '📥', 'Store Stock'],
    ['retrieve', '📤', 'Retrieve Stock'],
    ['inventory', '▤', 'Inventory Search'],
    ['history', '◷', 'My Movements'],
    ['profile', '👤', 'My Profile']
  ]
};
menus.boss = menus.owner;
menus.store_owner = menus.owner;
menus.store_admin = menus.admin;

function getCurrentStoreRole() {
  if (isPlatformOwner) return 'platform_owner';
  if (activeStore && activeStore.role) return activeStore.role;
  if (me && me.role) return me.role;
  return 'operator';
}

function formatStoreType(t) {
  const map = {
    grocery: 'Grocery Store',
    dark_store: 'Dark Store',
    supermarket: 'Supermarket',
    warehouse: 'Warehouse'
  };
  return map[t] || (t ? String(t).replace(/_/g, ' ') : 'Store');
}

async function fetchUserStores() {
  try {
    const res = await raw('/api/user/stores');
    userStores = res.stores || [];
    const select = $('storeSelect');
    if (!select) return;

    if (userStores.length === 0) {
      select.innerHTML = '<option value="">No authorized stores</option>';
      if ($('storeTypeBadge')) $('storeTypeBadge').textContent = 'None';
      activeStoreId = '';
      activeStore = null;
      return;
    }

    const savedStoreId = sessionStorage.getItem('asrsActiveStoreId');
    const matchedStore = userStores.find(s => s.id === savedStoreId);
    activeStore = matchedStore || userStores[0];
    activeStoreId = activeStore.id;
    sessionStorage.setItem('asrsActiveStoreId', activeStoreId);

    select.innerHTML = userStores.map(s =>
      `<option value="${s.id}" ${s.id === activeStoreId ? 'selected' : ''}>${esc(s.name)} (${esc(s.code)})</option>`
    ).join('');

    if ($('storeTypeBadge')) {
      $('storeTypeBadge').textContent = formatStoreType(activeStore.store_type);
    }
    if ($('topWarehouseLabel')) {
      $('topWarehouseLabel').textContent = `${(activeStore.name || 'WAREHOUSE').toUpperCase()} / ${activeStore.code || activeStore.id}`;
    }
  } catch (err) {
    console.error('Failed to load user stores:', err);
    if ($('storeSelect')) $('storeSelect').innerHTML = '<option value="">Failed to load stores</option>';
  }
}

async function switchStore(newStoreId) {
  if (!newStoreId || newStoreId === activeStoreId) return;
  const target = userStores.find(s => s.id === newStoreId);
  if (!target && !isPlatformOwner) {
    return toast('Unauthorized store selection', true);
  }

  // Clear stale data to prevent bleed
  slots = [];
  transactions = [];
  storeMembersList = [];
  storeDevicesList = [];
  rackConfig = { rows: target?.rack_rows || 4, cols: target?.rack_cols || 4 };

  activeStoreId = newStoreId;
  activeStore = target || { id: newStoreId, name: newStoreId, code: newStoreId };
  sessionStorage.setItem('asrsActiveStoreId', activeStoreId);

  if ($('storeTypeBadge')) {
    $('storeTypeBadge').textContent = formatStoreType(activeStore.store_type);
  }
  if ($('topWarehouseLabel')) {
    $('topWarehouseLabel').textContent = `${(activeStore.name || 'WAREHOUSE').toUpperCase()} / ${activeStore.code || activeStore.id}`;
  }

  const role = getCurrentStoreRole();
  $('userRole').textContent = isPlatformOwner ? 'Platform Owner / Super Admin' : (roleLabels[role] || roleLabels[me.role] || 'Warehouse User');

  buildNav();
  buildMobileNav();
  toast(`Switched active store to: ${activeStore.name}`);
  await load();
}

async function raw(path, opt = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(opt.headers || {})
  };

  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }

  // Central Tenant Header Resolution (SEC-05 compliance)
  // 1. If path explicitly specifies /api/stores/:storeId/..., use matching storeId
  const storeUrlMatch = path.match(/^\/api\/stores\/([^/?#]+)/);
  if (storeUrlMatch) {
    const urlStoreId = storeUrlMatch[1];
    if (urlStoreId !== 'register') {
      headers['x-store-id'] = urlStoreId;
    }
  } else {
    // 2. Attach x-store-id only to tenant-scoped routes (never to auth, public, or platform-only routes)
    const isGlobalOrAuth =
      path.startsWith('/health') ||
      path.startsWith('/auth/') ||
      path.startsWith('/api/platform/') ||
      path === '/api/user/stores' ||
      path === '/api/stores/register' ||
      path.startsWith('/hardware/key') ||
      path.startsWith('/api/owner/pending-admins');

    if (!isGlobalOrAuth && activeStoreId) {
      headers['x-store-id'] = activeStoreId;
    }
  }

  const r = await fetch(BACKEND + path, {
    ...opt,
    headers
  });

  // Handle session revocation (401)
  if (r.status === 401) {
    if (!path.startsWith('/auth/login') && !path.startsWith('/auth/forgot-password') && !path.startsWith('/auth/register')) {
      token = '';
      me = null;
      sessionStorage.clear();
      toast('Session expired or revoked. Please log in again.', true);
      setTimeout(() => location.reload(), 1500);
      throw Error('Session expired or revoked. Please log in again.');
    }
  }

  let d = {};
  try { d = await r.json(); } catch {}
  if (!r.ok || d.ok === false) throw Error(d.error || `Request failed (${r.status})`);
  return d;
}

function api(path, opt = {}) { return raw(path, opt); }

async function init() {
  try {
    const s = await raw('/auth/status');
    if (s.warehouse) {
      $('topWarehouseLabel').textContent = `${s.warehouse.warehouse_name.toUpperCase()} / ${s.warehouse.warehouse_code}`;
    }
    if (s.rack) {
      rackConfig = s.rack;
    }

    if (s.setupRequired) {
      $('loginTitle').textContent = 'Create Boss Account';
      $('loginHint').textContent = 'Register your warehouse once, then create your private administrator account.';
      $('setupFields').classList.remove('hidden');
      $('loginFields').classList.add('hidden');
      $('enterBtn').textContent = 'Create secure account →';
      $('loginNote').textContent = 'Use a strong password with at least 8 characters.';
      $('enterBtn').onclick = setup;
    } else {
      $('enterBtn').onclick = login;

      setupForgotPassHandlers();
      setupRegistrationHandlers();
      setupStoreRegHandlers();

      // Check for saved session in sessionStorage for seamless re-opening
      const savedToken = sessionStorage.getItem('asrsToken');
      const savedUser = sessionStorage.getItem('asrsUser');
      if (savedToken && savedUser) {
        token = savedToken;
        me = JSON.parse(savedUser);
        try {
          isPlatformOwner = me.platformRole === 'platform_owner' || me.userId === 'testboss';
          await fetchUserStores();
          showApp();
          await load();
          startAutoRefresh();
          return;
        } catch {
          // Token expired or invalid
          token = '';
          me = null;
          sessionStorage.clear();
        }
      }
    }
  } catch (e) {
    $('loginError').textContent = 'Cannot reach backend. Start server with start-backend.bat, then refresh.';
  }
}

let pendingRegistrationUserId = '';
let setupOtpTimerId = null;
let forgotOtpTimerId = null;
let forgotIdentifierTarget = '';

async function setup() {
  try {
    $('loginError').textContent = '';
    const userId = $('setupUser').value.trim();
    const password = $('setupPass').value;
    const email = $('setupEmail').value.trim();
    const phone = $('setupPhone').value.trim();
    const displayName = $('setupName').value.trim() || 'Boss / Admin';
    const warehouseName = $('warehouseName').value.trim();
    const warehouseCode = $('warehouseCode').value.trim();
    const location = $('warehouseLocation').value.trim();

    if (!userId || !password) throw Error('User ID and password are required');
    if (!email) throw Error('Admin Email is required for verification');
    if (!phone) throw Error('Mobile number is required for SMS verification');

    const res = await raw('/auth/setup-admin/request', {
      method: 'POST',
      body: JSON.stringify({
        userId,
        password,
        displayName,
        email,
        phone,
        warehouseName,
        warehouseCode,
        location
      })
    });

    pendingRegistrationUserId = userId;
    $('setupFields').classList.add('hidden');
    $('setupOtpFields').classList.remove('hidden');
    $('enterBtn').textContent = 'Verify & Activate Account →';
    $('enterBtn').onclick = verifySetupOtp;
    $('loginTitle').textContent = 'Verify Admin Account';
    $('loginHint').textContent = res.message || 'Enter verification codes sent to your email and mobile.';
    startCountdown('setupOtpTimer', 'setupResendBtn', 300, 60, resendSetupOtp);
  } catch (e) {
    $('loginError').textContent = e.message;
  }
}

async function verifySetupOtp() {
  try {
    $('loginError').textContent = '';
    const emailOtp = $('setupEmailOtp').value.trim();
    const phoneOtp = $('setupPhoneOtp').value.trim();
    if (!emailOtp || !phoneOtp) throw Error('Enter both Email and Mobile OTPs');

    const res = await raw('/auth/setup-admin/verify', {
      method: 'POST',
      body: JSON.stringify({
        userId: pendingRegistrationUserId,
        emailOtp,
        phoneOtp
      })
    });

    clearInterval(setupOtpTimerId);
    token = res.token;
    me = res.user;
    sessionStorage.setItem('asrsToken', token);
    sessionStorage.setItem('asrsUser', JSON.stringify(me));
    showApp();
    await load();
    startAutoRefresh();
  } catch (e) {
    $('loginError').textContent = e.message;
  }
}

async function resendSetupOtp() {
  try {
    $('loginError').textContent = '';
    const res = await raw('/auth/setup-admin/resend', {
      method: 'POST',
      body: JSON.stringify({ userId: pendingRegistrationUserId })
    });
    $('loginError').textContent = res.message;
    startCountdown('setupOtpTimer', 'setupResendBtn', 300, 60, resendSetupOtp);
  } catch (e) {
    $('loginError').textContent = e.message;
  }
}

function setupForgotPassHandlers() {
  const link = $('forgotPassLink');
  const back = $('forgotBackLink');
  const sendBtn = $('forgotSendBtn');
  const resetBtn = $('forgotResetBtn');

  if (link) {
    link.onclick = (e) => {
      e.preventDefault();
      $('loginFields').classList.add('hidden');
      $('enterBtn').classList.add('hidden');
      $('roleChoice').classList.add('hidden');
      $('loginNote').classList.add('hidden');
      $('forgotFields').classList.remove('hidden');
      $('forgotStep1').classList.remove('hidden');
      $('forgotStep2').classList.add('hidden');
      $('loginTitle').textContent = 'Reset Admin Password';
      $('loginHint').textContent = 'Verify your identity via registered Email or Mobile number.';
      $('loginError').textContent = '';
    };
  }

  if (back) {
    back.onclick = (e) => {
      e.preventDefault();
      $('forgotFields').classList.add('hidden');
      $('loginFields').classList.remove('hidden');
      $('enterBtn').classList.remove('hidden');
      $('roleChoice').classList.remove('hidden');
      $('loginNote').classList.remove('hidden');
      $('loginTitle').textContent = 'Welcome back';
      $('loginHint').textContent = 'Sign in to your warehouse control center.';
      $('loginError').textContent = '';
      clearInterval(forgotOtpTimerId);
    };
  }

  if (sendBtn) {
    sendBtn.onclick = async () => {
      try {
        $('loginError').textContent = '';
        const id = $('forgotIdentifier').value.trim();
        if (!id) throw Error('Enter your User ID, Email address or Mobile number');
        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending code...';
        const res = await raw('/auth/forgot-password/request', {
          method: 'POST',
          body: JSON.stringify({ identifier: id })
        });
        forgotIdentifierTarget = id;
        $('forgotStep1').classList.add('hidden');
        $('forgotStep2').classList.remove('hidden');
        $('forgotDestLabel').textContent = res.message + (res.destination ? ` (${res.destination})` : '');
        startCountdown('forgotOtpTimer', 'forgotResendBtn', 300, 60, resendForgotOtp);
      } catch (err) {
        $('loginError').textContent = err.message;
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Verification Code →';
      }
    };
  }

  if (resetBtn) {
    resetBtn.onclick = async () => {
      try {
        $('loginError').textContent = '';
        const otp = $('forgotOtp').value.trim();
        const newPass = $('forgotNewPass').value;
        const confirmPass = $('forgotConfirmPass').value;
        if (!otp) throw Error('Enter the 6-digit verification code');
        if (!newPass || newPass.length < 8) throw Error('New password must have at least 8 characters');
        if (newPass !== confirmPass) throw Error('Passwords do not match');

        resetBtn.disabled = true;
        resetBtn.textContent = 'Resetting password...';
        const res = await raw('/auth/forgot-password/reset', {
          method: 'POST',
          body: JSON.stringify({
            identifier: forgotIdentifierTarget,
            otp,
            newPassword: newPass
          })
        });

        clearInterval(forgotOtpTimerId);
        toast(res.message);
        if (back) back.click();
        $('loginError').textContent = 'Password reset! Sign in with your new password.';
        $('loginUser').value = forgotIdentifierTarget;
        $('loginPass').value = '';
      } catch (err) {
        $('loginError').textContent = err.message;
      } finally {
        resetBtn.disabled = false;
        resetBtn.textContent = 'Reset Password & Invalidate Sessions →';
      }
    };
  }
}

async function resendForgotOtp() {
  try {
    $('loginError').textContent = '';
    const res = await raw('/auth/forgot-password/request', {
      method: 'POST',
      body: JSON.stringify({ identifier: forgotIdentifierTarget })
    });
    $('loginError').textContent = res.message;
    startCountdown('forgotOtpTimer', 'forgotResendBtn', 300, 60, resendForgotOtp);
  } catch (err) {
    $('loginError').textContent = err.message;
  }
}

function startCountdown(timerId, btnId, totalSec, cooldownSec, resendCallback) {
  const timerEl = $(timerId);
  const btnEl = $(btnId);
  if (!timerEl || !btnEl) return;

  btnEl.disabled = true;
  let remaining = totalSec;
  let cooldown = cooldownSec;

  btnEl.onclick = () => {
    if (!btnEl.disabled && resendCallback) resendCallback();
  };

  const intervalId = setInterval(() => {
    remaining--;
    cooldown--;

    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    timerEl.textContent = remaining > 0 ? `Expires in ${m}:${String(s).padStart(2, '0')}` : 'Code expired';

    if (cooldown > 0) {
      btnEl.textContent = `Resend in ${cooldown}s`;
      btnEl.disabled = true;
    } else {
      btnEl.textContent = 'Resend Code';
      btnEl.disabled = false;
    }

    if (remaining <= 0) {
      clearInterval(intervalId);
      timerEl.textContent = 'Code expired. Request a new one.';
    }
  }, 1000);

  if (timerId === 'setupOtpTimer') {
    if (setupOtpTimerId) clearInterval(setupOtpTimerId);
    setupOtpTimerId = intervalId;
  } else {
    if (forgotOtpTimerId) clearInterval(forgotOtpTimerId);
    forgotOtpTimerId = intervalId;
  }
}

const roleLabels = {
  owner: 'Owner / Super Admin',
  boss: 'Owner / Super Admin',
  admin: 'Admin / Warehouse Manager',
  operator: 'Warehouse Operator'
};

function setupRegistrationHandlers() {
  const opLink = $('opRegLink');
  const adminLink = $('adminRegLink');
  const backLinks = document.querySelectorAll('.regBackLink');

  if (opLink) {
    opLink.onclick = (e) => {
      e.preventDefault();
      $('loginFields').classList.add('hidden');
      $('forgotFields').classList.add('hidden');
      $('adminRegFields').classList.add('hidden');
      $('opRegFields').classList.remove('hidden');
      $('enterBtn').classList.add('hidden');
      $('roleChoice')?.classList.add('hidden');
      $('loginNote')?.classList.add('hidden');
      $('loginFooterLinks')?.classList.add('hidden');
      $('loginTitle').textContent = 'Apply for Operator Access';
      $('loginHint').textContent = 'Submit your application for warehouse operator access.';
      $('loginError').textContent = '';
    };
  }

  if (adminLink) {
    adminLink.onclick = (e) => {
      e.preventDefault();
      $('loginFields').classList.add('hidden');
      $('forgotFields').classList.add('hidden');
      $('opRegFields').classList.add('hidden');
      $('adminRegFields').classList.remove('hidden');
      $('enterBtn').classList.add('hidden');
      $('roleChoice')?.classList.add('hidden');
      $('loginNote')?.classList.add('hidden');
      $('loginFooterLinks')?.classList.add('hidden');
      $('loginTitle').textContent = 'Apply for Admin Access';
      $('loginHint').textContent = 'Submit your application for warehouse manager access.';
      $('loginError').textContent = '';
    };
  }

  backLinks.forEach(b => {
    b.onclick = (e) => {
      e.preventDefault();
      $('opRegFields').classList.add('hidden');
      $('adminRegFields').classList.add('hidden');
      $('forgotFields').classList.add('hidden');
      $('loginFields').classList.remove('hidden');
      $('enterBtn').classList.remove('hidden');
      $('roleChoice')?.classList.remove('hidden');
      $('loginNote')?.classList.remove('hidden');
      $('loginFooterLinks')?.classList.remove('hidden');
      $('loginTitle').textContent = 'Welcome back';
      $('loginHint').textContent = 'Sign in to your warehouse control center.';
      $('loginError').textContent = '';
    };
  });

  const opSubmitBtn = $('opRegSubmitBtn');
  if (opSubmitBtn) {
    opSubmitBtn.onclick = async () => {
      try {
        $('loginError').textContent = '';
        const userId = $('opRegUser').value.trim();
        const displayName = $('opRegName').value.trim();
        const password = $('opRegPass').value;
        const email = $('opRegEmail').value.trim();
        const phone = $('opRegPhone').value.trim();
        const employeeId = $('opRegEmpId').value.trim();
        const registrationReason = $('opRegReason').value.trim();

        if (!userId || !displayName || !password) throw Error('User ID, Display Name, and Password (8+ chars) are required');
        opSubmitBtn.disabled = true;
        opSubmitBtn.textContent = 'Submitting application...';

        const res = await raw('/auth/register/operator', {
          method: 'POST',
          body: JSON.stringify({ userId, displayName, password, email, phone, employeeId, registrationReason })
        });

        toast(res.message);
        $('opRegFields').classList.add('hidden');
        $('loginFields').classList.remove('hidden');
        $('enterBtn').classList.remove('hidden');
        $('roleChoice')?.classList.remove('hidden');
        $('loginNote')?.classList.remove('hidden');
        $('loginFooterLinks')?.classList.remove('hidden');
        $('loginTitle').textContent = 'Application Submitted';
        $('loginHint').textContent = 'Your operator application is pending administrator approval.';
        $('loginError').textContent = res.message;
      } catch (err) {
        $('loginError').textContent = err.message;
      } finally {
        opSubmitBtn.disabled = false;
        opSubmitBtn.textContent = 'Submit Operator Application →';
      }
    };
  }

  const adminSubmitBtn = $('adminRegSubmitBtn');
  if (adminSubmitBtn) {
    adminSubmitBtn.onclick = async () => {
      try {
        $('loginError').textContent = '';
        const userId = $('adminRegUser').value.trim();
        const displayName = $('adminRegName').value.trim();
        const password = $('adminRegPass').value;
        const email = $('adminRegEmail').value.trim();
        const phone = $('adminRegPhone').value.trim();
        const organization = $('adminRegOrg').value.trim();
        const registrationReason = $('adminRegReason').value.trim();

        if (!userId || !displayName || !password || !email) throw Error('User ID, Full Name, Password (8+ chars), and Email are required');
        adminSubmitBtn.disabled = true;
        adminSubmitBtn.textContent = 'Submitting application...';

        const res = await raw('/auth/register/admin', {
          method: 'POST',
          body: JSON.stringify({ userId, displayName, password, email, phone, organization, registrationReason })
        });

        toast(res.message);
        $('adminRegFields').classList.add('hidden');
        $('loginFields').classList.remove('hidden');
        $('enterBtn').classList.remove('hidden');
        $('roleChoice')?.classList.remove('hidden');
        $('loginNote')?.classList.remove('hidden');
        $('loginFooterLinks')?.classList.remove('hidden');
        $('loginTitle').textContent = 'Application Submitted';
        $('loginHint').textContent = 'Your admin application is pending Owner / Super Admin approval.';
        $('loginError').textContent = res.message;
      } catch (err) {
        $('loginError').textContent = err.message;
      } finally {
        adminSubmitBtn.disabled = false;
        adminSubmitBtn.textContent = 'Submit Admin Application →';
      }
    };
  }
}

function setupStoreRegHandlers() {
  const storeLink = $('storeRegLink');
  const storeSubmitBtn = $('storeRegSubmitBtn');

  if (storeLink) {
    storeLink.onclick = (e) => {
      e.preventDefault();
      $('loginFields').classList.add('hidden');
      $('forgotFields').classList.add('hidden');
      $('opRegFields').classList.add('hidden');
      $('adminRegFields').classList.add('hidden');
      $('storeRegFields').classList.remove('hidden');
      $('enterBtn').classList.add('hidden');
      $('roleChoice')?.classList.add('hidden');
      $('loginNote')?.classList.add('hidden');
      $('loginFooterLinks')?.classList.add('hidden');
      $('loginTitle').textContent = 'Register New Store / Tenant';
      $('loginHint').textContent = 'Apply to onboard your grocery, dark store, supermarket, or warehouse.';
      $('loginError').textContent = '';
    };
  }

  if (storeSubmitBtn) {
    storeSubmitBtn.onclick = async () => {
      try {
        $('loginError').textContent = '';
        const name = $('storeRegName').value.trim();
        const code = $('storeRegCode').value.trim();
        const storeType = $('storeRegType').value;
        const city = $('storeRegCity').value.trim();
        const address = $('storeRegAddress').value.trim();
        const ownerName = $('storeRegOwnerName').value.trim();
        const ownerUserId = $('storeRegOwnerUser').value.trim();
        const email = $('storeRegEmail').value.trim();
        const phone = $('storeRegPhone').value.trim();
        const password = $('storeRegPass').value;
        const applicationReason = $('storeRegReason').value.trim();

        if (!name) throw Error('Store / Business name is required');
        if (!code) throw Error('Store code is required (e.g. FM_GROCERY_01)');
        if (!ownerUserId) throw Error('Owner User ID is required');
        if (!email) throw Error('Business email is required');
        if (!password || password.length < 8) throw Error('Password must be at least 8 characters');

        storeSubmitBtn.disabled = true;
        storeSubmitBtn.textContent = 'Submitting application...';

        const res = await raw('/api/stores/register', {
          method: 'POST',
          body: JSON.stringify({
            name,
            code,
            storeType,
            city,
            address,
            ownerName,
            ownerUserId,
            email,
            phone,
            password,
            applicationReason
          })
        });

        toast(res.message);
        $('storeRegFields').classList.add('hidden');
        $('loginFields').classList.remove('hidden');
        $('enterBtn').classList.remove('hidden');
        $('roleChoice')?.classList.remove('hidden');
        $('loginNote')?.classList.remove('hidden');
        $('loginFooterLinks')?.classList.remove('hidden');
        $('loginTitle').textContent = 'Application Submitted';
        $('loginHint').textContent = 'Your store registration has been submitted and is pending Platform Owner review.';
        $('loginError').textContent = res.message;
        $('loginUser').value = ownerUserId;
        $('loginPass').value = '';
      } catch (err) {
        $('loginError').textContent = err.message;
      } finally {
        storeSubmitBtn.disabled = false;
        storeSubmitBtn.textContent = 'Submit Store Registration Application →';
      }
    };
  }
}

async function login() {
  try {
    const d = await raw('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        userId: $('loginUser').value.trim(),
        password: $('loginPass').value
      })
    });
    token = d.token;
    me = d.user;
    sessionStorage.setItem('asrsToken', token);
    sessionStorage.setItem('asrsUser', JSON.stringify(me));
    isPlatformOwner = me.platformRole === 'platform_owner' || me.userId === 'testboss';
    await fetchUserStores();
    showApp();
    await load();
    startAutoRefresh();
  } catch (e) {
    $('loginError').textContent = e.message;
  }
}

function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  const role = getCurrentStoreRole();
  $('userName').textContent = me.displayName;
  $('userRole').textContent = isPlatformOwner ? 'Platform Owner / Super Admin' : (roleLabels[role] || roleLabels[me.role] || 'Warehouse User');
  $('avatar').textContent = (me.displayName || 'U')[0].toUpperCase();
  buildNav();
  buildMobileNav();
  navigate('dashboard');
}

$('logout').onclick = async () => {
  stopAutoRefresh();
  try { await api('/auth/logout', { method: 'POST' }); } catch {}
  token = '';
  me = null;
  sessionStorage.clear();
  location.reload();
};

function buildNav() {
  const role = getCurrentStoreRole();
  const currentMenu = menus[role] || menus.operator;
  $('nav').innerHTML = currentMenu.map(([id, ico, label]) =>
    `<button data-page="${id}"><span class="ico">${ico}</span><span>${label}</span></button>`
  ).join('');
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => navigate(b.dataset.page));
}

function buildMobileNav() {
  const el = $('mobileBottomNav');
  if (!el) return;
  const role = getCurrentStoreRole();
  let mobileTabs = [];
  if (role === 'platform_owner') {
    mobileTabs = [
      ['dashboard', '▣', 'Dashboard'],
      ['inventory', '▤', 'Inventory'],
      ['platform_stores', '🏬', 'Stores'],
      ['approvals', '✓', 'Approvals'],
      ['settings', '⚙', 'Settings']
    ];
  } else if (role === 'owner' || role === 'store_owner' || role === 'boss') {
    mobileTabs = [
      ['dashboard', '▣', 'Dashboard'],
      ['inventory', '▤', 'Inventory'],
      ['rack', '▦', 'Rack'],
      ['history', '◷', 'History'],
      ['store_staff', '👥', 'Staff']
    ];
  } else if (role === 'admin' || role === 'store_admin') {
    mobileTabs = [
      ['dashboard', '▣', 'Dashboard'],
      ['inventory', '▤', 'Inventory'],
      ['history', '◷', 'History'],
      ['store_staff', '👥', 'Staff'],
      ['profile', '👤', 'Profile']
    ];
  } else {
    mobileTabs = [
      ['dashboard', '▣', 'Dashboard'],
      ['inventory', '▤', 'Inventory'],
      ['store', '📥', 'Store'],
      ['retrieve', '📤', 'Retrieve'],
      ['profile', '👤', 'Profile']
    ];
  }

  el.innerHTML = mobileTabs.map(([id, ico, label]) =>
    `<button class="mobile-nav-btn ${page === id ? 'active' : ''}" data-page="${id}">
       <span class="mobile-nav-ico">${ico}</span>
       <span class="mobile-nav-lbl">${label}</span>
     </button>`
  ).join('');

  el.querySelectorAll('.mobile-nav-btn').forEach(b => {
    b.onclick = () => navigate(b.dataset.page);
  });
}

function navigate(p) {
  const role = getCurrentStoreRole();
  const currentMenu = menus[role] || menus.operator;
  if (!currentMenu.some(x => x[0] === p)) p = 'dashboard';
  page = p;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.page === p));
  document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === p));
  $('pageTitle').textContent = currentMenu.find(x => x[0] === p)?.[2] || p;
  render();
  load();
}

let pendingAdminsList = [];
let pendingOpsList = [];
let approvedAdminsList = [];
let approvedOpsList = [];
let txFromFilter = '';
let txToFilter = '';

async function load() {
  try {
    let txUrl = '/transactions';
    const qParams = [];
    if (txFromFilter) qParams.push(`from=${encodeURIComponent(txFromFilter)}`);
    if (txToFilter) qParams.push(`to=${encodeURIComponent(txToFilter)}`);
    if (qParams.length) txUrl += '?' + qParams.join('&');

    const [slotsData, txData] = await Promise.all([
      api('/slots'),
      api(txUrl)
    ]);
    slots = slotsData;
    transactions = txData;
    if (page === 'platform_stores' && isPlatformOwner) {
      try {
        const [storesRes, pendingRes] = await Promise.all([
          api('/api/platform/stores'),
          api('/api/platform/pending-stores')
        ]);
        platformStoresList = storesRes.stores || [];
        platformPendingStoresList = pendingRes.stores || [];
      } catch (err) {
        console.error('Failed to load platform stores:', err);
      }
    }
    if (page === 'store_staff' && activeStoreId) {
      try {
        const res = await api(`/api/stores/${activeStoreId}/members`);
        storeMembersList = res.members || [];
      } catch (err) {
        console.error('Failed to load store members:', err);
      }
    }
    if (page === 'store_devices' && activeStoreId) {
      try {
        const res = await api(`/api/stores/${activeStoreId}/devices`);
        storeDevicesList = res.devices || [];
      } catch (err) {
        console.error('Failed to load store devices:', err);
      }
    }
    if (page === 'users' && (me.role === 'owner' || me.role === 'boss')) {
      try { users = await api('/users'); } catch {}
    }
    if (page === 'admin_mgmt' && (me.role === 'owner' || me.role === 'boss')) {
      try {
        const resA = await api('/api/owner/admins');
        approvedAdminsList = resA.admins || [];
      } catch {}
    }
    if (page === 'operator_mgmt' && (me.role === 'admin' || me.role === 'owner' || me.role === 'boss')) {
      try {
        const resO = await api('/api/admin/operators');
        approvedOpsList = resO.operators || [];
      } catch {}
    }
    if (page === 'approvals') {
      if (me.role === 'owner' || me.role === 'boss' || isPlatformOwner) {
        try {
          const resA = await api('/api/owner/pending-admins');
          pendingAdminsList = resA.requests || [];
        } catch {}
      }
      if (me.role === 'owner' || me.role === 'boss' || me.role === 'admin' || isPlatformOwner) {
        try {
          const resO = await api('/api/admin/pending-operators');
          pendingOpsList = resO.requests || [];
        } catch {}
      }
    }
    if (page === 'settings' && (me.role === 'owner' || me.role === 'boss' || isPlatformOwner)) {
      try {
        const hw = await api('/hardware/key');
        hardwareKey = hw.hardwareApiKey;
      } catch {}
    }
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

async function loadSilent() {
  try {
    const [slotsData, txData] = await Promise.all([
      api('/slots'),
      api('/transactions')
    ]);
    slots = slotsData;
    transactions = txData;
    // Update live counts if on dashboard without re-rendering inputs
    if (page === 'dashboard') {
      const statsEl = document.querySelector('.stats');
      if (statsEl) statsEl.outerHTML = stats();
    }
  } catch {}
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshInterval = setInterval(() => {
    if (token && document.visibilityState === 'visible' && (page === 'dashboard' || page === 'rack' || page === 'history')) {
      loadSilent();
    }
  }, 4000);
}

function stopAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
}

function getRackDimensions() {
  let maxRowChar = 'A';
  let maxColNum = 1;
  slots.forEach(s => {
    const m = s.slot.match(/^([A-Z]+)(\d+)$/);
    if (m) {
      if (m[1] > maxRowChar) maxRowChar = m[1];
      const col = parseInt(m[2], 10);
      if (col > maxColNum) maxColNum = col;
    }
  });
  return {
    rows: Math.max(rackConfig.rows || 1, maxRowChar.charCodeAt(0) - 64),
    cols: Math.max(rackConfig.cols || 1, maxColNum)
  };
}

function qty() { return slots.reduce((a, s) => a + Number(s.quantity || 0), 0); }
function total(a) { return transactions.filter(t => t.action === a).reduce((n, t) => n + Number(t.quantity || 1), 0); }

function stats() {
  return `
    <div class="grid stats">
      <div class="stat">
        <div class="label">TOTAL ITEMS IN STOCK</div>
        <div class="num cyan">${qty()}</div>
        <div class="muted">Across all rack slots</div>
      </div>
      <div class="stat">
        <div class="label">TOTAL STORED</div>
        <div class="num green">${total('STORE')}</div>
        <div class="muted">Lifetime stored</div>
      </div>
      <div class="stat">
        <div class="label">TOTAL RETRIEVED</div>
        <div class="num orange">${total('RETRIEVE')}</div>
        <div class="muted">Lifetime retrieved</div>
      </div>
      <div class="stat">
        <div class="label">OCCUPIED SLOTS</div>
        <div class="num">${slots.filter(s => Number(s.quantity || 0) > 0).length} / ${slots.length}</div>
        <div class="muted">Active warehouse slots</div>
      </div>
      <div class="stat">
        <div class="label">FREE CAPACITY</div>
        <div class="num">${slots.reduce((a, s) => a + Math.max(0, Number(s.capacity || 10) - Number(s.quantity || 0)), 0)}</div>
        <div class="muted">Available space</div>
      </div>
    </div>
  `;
}

function slotCard(s) {
  let q = +s.quantity || 0, c = +s.capacity || 10, p = Math.min(100, Math.round(q / c * 100));
  return `
    <div class="slot ${q === 0 ? 'empty' : q >= c ? 'full' : ''}" data-slot="${s.slot}">
      <div class="slot-name">${s.slot} <span class="badge ${q === 0 ? 'red' : q >= c ? 'orange' : 'green'}">${s.status}</span></div>
      <div class="box">${q ? '📦' : '▫️'}</div>
      <div class="qty">${esc(s.item_name || 'Item ' + s.item)} · <b>${q}</b> / ${c} units</div>
      <div class="muted">SKU: ${esc(s.sku || '—')}</div>
      <div class="bar"><i style="width:${p}%"></i></div>
    </div>
  `;
}

function dashboard() {
  const dim = getRackDimensions();
  return `
    <div class="page-actions">
      <div>
        <b>Live Warehouse Overview</b>
        <div class="muted">${me.role === 'boss' ? 'Live monitoring of inventory occupancy and automated movements.' : 'Operator control for stock operations and slot monitoring.'}</div>
      </div>
      <button class="primary" id="refresh">↻ Refresh</button>
    </div>
    ${stats()}
    <div class="grid two">
      <div class="panel">
        <div class="panel-head">
          <h3>${dim.rows} × ${dim.cols} Smart Warehouse Rack</h3>
          <span class="muted">${slots.length} Slots Total (A1 → ${String.fromCharCode(64 + dim.rows)}${dim.cols})</span>
        </div>
        <div class="rack" style="grid-template-columns: repeat(${dim.cols}, minmax(0, 1fr))">
          ${slots.map(slotCard).join('')}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <h3>Recent Activity</h3>
          <span class="muted">Latest 8 Transactions</span>
        </div>
        ${activity(8)}
      </div>
    </div>
  `;
}

function activity(n = 100) {
  let list = transactions;
  if (historyFilter) {
    const f = historyFilter.toLowerCase();
    list = list.filter(t =>
      (t.slot || '').toLowerCase().includes(f) ||
      (t.item_name || '').toLowerCase().includes(f) ||
      (t.sku || '').toLowerCase().includes(f) ||
      (t.action || '').toLowerCase().includes(f) ||
      (t.source || '').toLowerCase().includes(f)
    );
  }
  return list.length ? `
    <div class="timeline">
      ${list.slice(0, n).map(t => `
        <div class="event">
          <b>${t.action === 'STORE' ? '📥' : '📤'} ${t.action} · ${t.quantity || 1} unit(s)</b>
          <div>${esc(t.item_name || ('Item ' + t.item))} · ${t.sku || '—'} · Slot: <b>${t.slot}</b> · Source: <i>${t.source || 'dashboard'}</i></div>
          <small>${esc(t.user_name || 'System')} (${t.role || 'operator'}) · ${t.time || ''}</small>
        </div>
      `).join('')}
    </div>
  ` : '<div class="empty">No matching activity records found.</div>';
}

function inventory() {
  let list = slots;
  if (inventoryFilter) {
    const f = inventoryFilter.toLowerCase();
    list = list.filter(s =>
      (s.slot || '').toLowerCase().includes(f) ||
      (s.item_name || '').toLowerCase().includes(f) ||
      (s.sku || '').toLowerCase().includes(f) ||
      (s.status || '').toLowerCase().includes(f)
    );
  }
  return `
    <div class="page-actions">
      <div>
        <b>Product Stock & Rack Inventory</b>
        <div class="muted">Edit product details or execute Store / Retrieve operations with instant validation.</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        <input class="search" id="invSearchInput" placeholder="🔍 Search slot, product, SKU..." value="${esc(inventoryFilter)}">
        <button class="primary" id="refresh">↻ Refresh</button>
      </div>
    </div>
    ${stats()}
    <div class="panel" style="margin-top:16px">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Location</th>
              <th>Product Name</th>
              <th>SKU</th>
              <th>Stock</th>
              <th>Stored</th>
              <th>Retrieved</th>
              <th>Capacity</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(s => {
              const sStored = transactions.filter(t => t.slot === s.slot && t.action === 'STORE').reduce((a, t) => a + Number(t.quantity || 1), 0);
              const sRetrieved = transactions.filter(t => t.slot === s.slot && t.action === 'RETRIEVE').reduce((a, t) => a + Number(t.quantity || 1), 0);
              return `
              <tr>
                <td><b>${s.slot}</b></td>
                <td><input class="search editname" data-slot="${s.slot}" value="${attr(s.item_name)}" aria-label="Product name ${s.slot}"></td>
                <td><input class="search editsku" data-slot="${s.slot}" value="${attr(s.sku)}" aria-label="SKU ${s.slot}"></td>
                <td><b class="cyan">${s.quantity}</b></td>
                <td><span class="muted">${sStored}</span></td>
                <td><span class="muted">${sRetrieved}</span></td>
                <td>${s.capacity}</td>
                <td><span class="badge ${s.quantity === 0 ? 'red' : s.quantity >= s.capacity ? 'orange' : 'green'}">${s.status}</span></td>
                <td>
                  ${me.role === 'operator' ? `
                    <button class="ghost action" data-action="store" data-slot="${s.slot}">📥 Store</button>
                    <button class="ghost action" data-action="retrieve" data-slot="${s.slot}">📤 Retrieve</button>
                  ` : `
                    <button class="primary saveProduct" data-slot="${s.slot}">Save</button>
                    <span class="badge" style="background:#f1f5f9;color:#64748b;margin-left:6px;" title="Movement execution restricted to floor Operators">Floor Operator Only</span>
                  `}
                </td>
              </tr>
            `}).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function rackPage() {
  const dim = getRackDimensions();
  return `
    <div class="panel">
      <div class="panel-head">
        <div>
          <h3>${dim.rows} × ${dim.cols} Rack & Slot Map</h3>
          <span class="muted">Click any slot to execute immediate stock Store or Retrieve</span>
        </div>
        <button class="primary" id="refresh">↻ Refresh</button>
      </div>
      <div class="rack" style="grid-template-columns: repeat(${dim.cols}, minmax(0, 1fr))">
        ${slots.map(slotCard).join('')}
      </div>
    </div>
  `;
}

function historyPage() {
  let list = transactions;
  if (historyFilter) {
    const f = historyFilter.toLowerCase();
    list = list.filter(t =>
      (t.slot || '').toLowerCase().includes(f) ||
      (t.item_name || '').toLowerCase().includes(f) ||
      (t.sku || '').toLowerCase().includes(f) ||
      (t.action || '').toLowerCase().includes(f) ||
      (t.source || '').toLowerCase().includes(f) ||
      (t.user_name || '').toLowerCase().includes(f) ||
      (t.user_id || '').toLowerCase().includes(f)
    );
  }
  return `
    <div class="panel">
      <div class="panel-head">
        <div>
          <h3>${me.role === 'operator' ? 'My Movement History' : 'Warehouse Transaction History'}</h3>
          <span class="muted">Total Logged: ${transactions.length} record(s)${txFromFilter || txToFilter ? ` (Filtered: ${txFromFilter || 'Earliest'} to ${txToFilter || 'Latest'})` : ''}</span>
        </div>
        <div style="display:flex;gap:10px;">
          <input class="search" id="histSearchInput" placeholder="🔍 Search current list..." value="${esc(historyFilter)}">
          <button class="primary" id="refresh">↻ Refresh</button>
        </div>
      </div>

      <!-- DATE FILTER & EXCEL TOOLBAR -->
      <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;background:#f8fafc;border-bottom:1px solid #e2e8f0;margin-bottom:12px;border-radius:6px;">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:13px;">
          <span style="font-weight:600;color:#475569;">Filter by Date:</span>
          <label style="display:flex;align-items:center;gap:6px;margin:0;">
            <span class="muted">From:</span>
            <input type="date" id="txFromDate" value="${esc(txFromFilter)}" style="padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;">
          </label>
          <label style="display:flex;align-items:center;gap:6px;margin:0;">
            <span class="muted">To:</span>
            <input type="date" id="txToDate" value="${esc(txToFilter)}" style="padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;">
          </label>
          <button class="primary" id="txApplyFilter" style="padding:7px 14px;font-size:13px;">Apply Filter</button>
          ${txFromFilter || txToFilter ? `<button class="ghost" id="txClearFilter" style="padding:7px 12px;font-size:13px;">✕ Clear Filter</button>` : ''}
        </div>
        <div>
          <button id="txExportExcel" class="primary" style="background:#059669;color:#fff;border-color:#059669;padding:7px 16px;font-size:13px;display:flex;align-items:center;gap:6px;">
            <span>📊</span><span>Download Excel (.xlsx)</span>
          </button>
        </div>
      </div>

      <div class="table-wrap">
        ${list.length ? `
          <table class="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Product</th>
                <th>SKU</th>
                <th>Slot</th>
                <th>Qty</th>
                <th>Before</th>
                <th>After</th>
                <th>User</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              ${list.map(t => `
                <tr>
                  <td>${t.time || ''}</td>
                  <td><span class="badge ${t.action === 'STORE' ? 'green' : 'orange'}">${t.action}</span></td>
                  <td>${esc(t.item_name || 'Item ' + t.item)}</td>
                  <td>${esc(t.sku || '—')}</td>
                  <td><b>${t.slot}</b></td>
                  <td><b>${t.quantity}</b></td>
                  <td>${t.before_quantity}</td>
                  <td>${t.after_quantity}</td>
                  <td>${esc(t.user_name || t.user_id || 'System')}</td>
                  <td><small class="muted">${esc(t.source || 'dashboard')}</small></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : `
          <div style="text-align:center;padding:40px 20px;color:#64748b;">
            <div style="font-size:32px;margin-bottom:8px;">📅</div>
            <p style="font-size:15px;font-weight:600;margin-bottom:4px;">No transactions found for the selected date range.</p>
            <small class="muted">Try adjusting your date filters or click "Clear Filter" to view all records.</small>
          </div>
        `}
      </div>
    </div>
  `;
}

function reports() {
  return `
    ${stats()}
    <div class="panel" style="margin-top:16px">
      <h3>Warehouse Activity Summary Report</h3>
      <p class="muted">Live analytics calculated from persistent transaction records.</p>
      ${activity(50)}
    </div>
  `;
}

function settings() {
  const dim = getRackDimensions();
  return `
    <div class="grid two">
      <!-- DYNAMIC RACK SIZE CONFIGURATION -->
      <div class="panel">
        <h3>📐 Dynamic Rack Size Configuration</h3>
        <p class="muted">Configure warehouse rack rows and columns. Existing data and occupied slots are safely protected.</p>
        <div class="form">
          <label>Rack Rows (A - Z, max 26)</label>
          <input id="rackRowsInput" type="number" min="1" max="26" value="${dim.rows}">
          <label>Rack Columns (1 - 50)</label>
          <input id="rackColsInput" type="number" min="1" max="50" value="${dim.cols}">
          <small class="muted">⚠️ Rack chhota karne par agar deleted slots mein stock hoga, toh request automatically protect/reject ho jayegi.</small>
          <div class="actions">
            <button class="primary" id="saveRackDim">Apply Rack Dimensions</button>
          </div>
        </div>
      </div>

      <!-- ESP32 HARDWARE INTEGRATION -->
      <div class="panel">
        <h3>🔑 ESP32 Hardware Integration</h3>
        <p class="muted">Configure your ESP32 Keypad & RFID microcontroller to communicate securely with this warehouse backend.</p>
        <div class="form">
          <label>Cloud Server Base URL</label>
          <div style="display:flex;gap:8px;">
            <input id="hwBaseUrlDisplay" type="text" readonly value="${window.location.origin}">
            <button class="ghost" id="copyHwBaseUrl" title="Copy Base URL">📋 Copy URL</button>
          </div>

          <label style="margin-top:10px;">Device Authentication Key</label>
          <div style="display:flex;gap:8px;">
            <input id="hwKeyDisplay" type="text" readonly value="${esc(hardwareKey || 'Loading...')}">
            <button class="primary" id="copyHwKey">📋 Copy Key</button>
            <button class="ghost" id="regenHwKey" title="Regenerate Key">🔄</button>
          </div>

          <div style="margin-top:12px; padding:10px; background:#0f172a; border-radius:6px; font-size:12px; line-height:1.6; color:#94a3b8;">
            <b style="color:#38bdf8;">ESP32 HTTP Integration Guide:</b><br>
            • <b>Header:</b> <code>X-Hardware-Key: ${esc(hardwareKey || '<API_KEY>')}</code><br>
            • <b>Store Endpoint:</b> <code>POST ${window.location.origin}/api/hardware/store</code><br>
            • <b>Retrieve Endpoint:</b> <code>POST ${window.location.origin}/api/hardware/retrieve</code><br>
            • <b>Payload:</b> <code>{"slot":"A1", "quantity":1, "source":"keypad"}</code>
          </div>
        </div>
      </div>

      <!-- ADMIN PROFILE & RECOVERY CONTACTS -->
      <div class="panel" style="grid-column: 1 / -1; margin-top: 8px;">
        <h3>👤 Administrator Profile & Recovery Contacts</h3>
        <p class="muted">Link your verified Email address and Mobile number to enable secure self-service OTP password recovery.</p>
        <div class="form">
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;">
            <div>
              <label>Admin User ID</label>
              <input type="text" readonly value="${esc(me?.userId || '')}">
            </div>
            <div>
              <label>Display Name</label>
              <input id="profileNameInput" type="text" value="${esc(me?.displayName || '')}">
            </div>
            <div>
              <label>Registered Email (for OTP)</label>
              <input id="profileEmailInput" type="email" placeholder="e.g. boss@company.com" value="${esc(me?.email || '')}">
            </div>
            <div>
              <label>Registered Mobile (for SMS OTP)</label>
              <input id="profilePhoneInput" type="tel" placeholder="e.g. +919876543210" value="${esc(me?.phone || '')}">
            </div>
          </div>
          <div class="actions" style="margin-top:14px">
            <button class="primary" id="saveProfileBtn">Save Profile & Contacts</button>
          </div>
        </div>
      </div>
    </div>

    <!-- SLOT CAPACITY CONFIGURATION -->
    <div class="panel" style="margin-top:16px">
      <h3>Slot Capacity Settings</h3>
      <p class="muted">Adjust maximum unit capacity for each individual warehouse slot.</p>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Location</th>
              <th>Product</th>
              <th>Current Stock</th>
              <th>Current Capacity</th>
              <th>New Capacity</th>
              <th>Save</th>
            </tr>
          </thead>
          <tbody>
            ${slots.map(s => `
              <tr>
                <td><b>${s.slot}</b></td>
                <td>${esc(s.item_name)}</td>
                <td>${s.quantity}</td>
                <td>${s.capacity}</td>
                <td><input class="search cap" data-slot="${s.slot}" type="number" min="${Math.max(1, s.quantity)}" value="${s.capacity}"></td>
                <td><button class="primary saveCap" data-slot="${s.slot}">Save</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function usersPage() {
  const isOwner = me.role === 'owner' || me.role === 'boss';
  return `
    <div class="grid two">
      <div class="panel">
        <h3>${isOwner ? 'Create User Account' : 'Create Operator Account'}</h3>
        <p class="muted">${isOwner ? 'Create an authorized Admin or Operator account directly.' : 'Create an authorized Operator account for warehouse staff.'}</p>
        <div class="form">
          ${isOwner ? `
            <label for="newRoleSelect">Account Role</label>
            <select id="newRoleSelect" class="search" style="width:100%;max-width:none;padding:12px;">
              <option value="operator">Operator (Floor movements)</option>
              <option value="admin">Admin (Warehouse management)</option>
            </select>
          ` : ''}
          <label for="opName">Display Name *</label>
          <input id="opName" placeholder="Full name">
          <label for="opId">User ID *</label>
          <input id="opId" placeholder="Unique user ID">
          <label for="opEmail">Email Address</label>
          <input id="opEmail" type="email" placeholder="user@warehouse.com">
          <label for="opPhone">Mobile Phone</label>
          <input id="opPhone" type="tel" placeholder="+919876543210">
          <label for="opPass">Temporary Password (8+ characters) *</label>
          <input id="opPass" type="password" placeholder="Min. 8 characters">
        </div>
        <div class="actions" style="margin-top:16px;">
          <button class="primary" id="createOp">Create Account</button>
        </div>
      </div>

      <div class="panel">
        <h3>${isOwner ? 'Warehouse Accounts' : 'Operator Accounts'}</h3>
        <div class="muted">${isOwner ? 'All registered warehouse accounts.' : 'Active warehouse operators.'}</div>
        <div style="margin-top:14px; max-height: 550px; overflow: auto;">
          ${users.map(u => `
            <div class="list-row">
              <div>
                <b>${esc(u.displayName || u.display_name)}</b>
                <span class="badge ${u.role === 'owner' || u.role === 'boss' ? 'cyan' : u.role === 'admin' ? 'orange' : 'green'}" style="margin-left:6px;">${roleLabels[u.role] || u.role}</span>
                <div class="muted">${esc(u.userId || u.user_id)} · ${u.active ? 'Active' : 'Disabled'} ${u.email ? '· ' + esc(u.email) : ''}</div>
              </div>
              <div>
                ${(u.userId !== 'testboss' && u.role !== 'owner') ? `
                  <button class="ghost toggleUser" data-id="${u.id}" data-active="${u.active ? 0 : 1}">
                    ${u.active ? 'Disable' : 'Enable'}
                  </button>
                ` : '<span class="badge green">Protected</span>'}
              </div>
            </div>
          `).join('') || '<div class="empty">No accounts found.</div>'}
        </div>
      </div>
    </div>
  `;
}

function approvalsPage() {
  const isOwner = me.role === 'owner' || me.role === 'boss';
  return `
    <div class="page-actions">
      <div>
        <b>Registration Approval Queues</b>
        <div class="muted">${isOwner ? 'Review and authorize pending Admin and Operator access requests.' : 'Review and authorize pending Operator floor requests.'}</div>
      </div>
      <button class="primary" id="refreshApprovals">↻ Refresh Queues</button>
    </div>

    ${isOwner ? `
      <div class="panel" style="margin-bottom:20px;">
        <div class="panel-head">
          <div>
            <h3>Pending Administrator Requests (${pendingAdminsList.length})</h3>
            <span class="muted">Owner / Super Admin review required for warehouse manager privileges.</span>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>User ID</th>
                <th>Full Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Organization</th>
                <th>Reason</th>
                <th>Requested At</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${pendingAdminsList.length ? pendingAdminsList.map(r => `
                <tr>
                  <td><b>${esc(r.user_id)}</b></td>
                  <td>${esc(r.display_name)}</td>
                  <td>${esc(r.email || '—')}</td>
                  <td>${esc(r.phone || '—')}</td>
                  <td>${esc(r.organization || '—')}</td>
                  <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;">${esc(r.registration_reason || '—')}</td>
                  <td><small class="muted">${r.requested_at || ''}</small></td>
                  <td>
                    <button class="primary approveAdminBtn" data-id="${r.id}" data-user="${esc(r.user_id)}">Approve</button>
                    <button class="danger rejectAdminBtn" data-id="${r.id}" data-user="${esc(r.user_id)}">Reject</button>
                  </td>
                </tr>
              `).join('') : '<tr><td colspan="8" class="empty">No pending administrator requests.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    ` : ''}

    <div class="panel">
      <div class="panel-head">
        <div>
          <h3>Pending Operator Requests (${pendingOpsList.length})</h3>
          <span class="muted">Review and activate floor worker registration applications.</span>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>User ID</th>
              <th>Display Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Employee ID</th>
              <th>Reason</th>
              <th>Requested At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${pendingOpsList.length ? pendingOpsList.map(r => `
              <tr>
                <td><b>${esc(r.user_id)}</b></td>
                <td>${esc(r.display_name)}</td>
                <td>${esc(r.email || '—')}</td>
                <td>${esc(r.phone || '—')}</td>
                <td>${esc(r.employee_id || '—')}</td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;">${esc(r.registration_reason || '—')}</td>
                <td><small class="muted">${r.requested_at || ''}</small></td>
                <td>
                  <button class="primary approveOpBtn" data-id="${r.id}" data-user="${esc(r.user_id)}">Approve</button>
                  <button class="danger rejectOpBtn" data-id="${r.id}" data-user="${esc(r.user_id)}">Reject</button>
                </td>
              </tr>
            `).join('') : '<tr><td colspan="8" class="empty">No pending operator requests.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function adminMgmtPage() {
  return `
    <div class="page-actions">
      <div>
        <b>Administrator Management</b>
        <div class="muted">Authorized warehouse managers. Only the Owner / Super Admin can manage administrative access.</div>
      </div>
      <button class="primary" id="refreshAdmins">↻ Refresh List</button>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div>
          <h3>Approved Administrators (${approvedAdminsList.length})</h3>
          <span class="muted">Active warehouse supervisors and managers.</span>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>User ID</th>
              <th>Full Name</th>
              <th>Work Email</th>
              <th>Department</th>
              <th>Account Status</th>
              <th>Approved Date</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${approvedAdminsList.length ? approvedAdminsList.map(a => `
              <tr>
                <td><b>${esc(a.userId)}</b></td>
                <td>${esc(a.displayName)}</td>
                <td>${esc(a.email || '—')}</td>
                <td>${esc(a.organization || '—')}</td>
                <td>
                  <span class="badge ${a.active ? 'green' : 'red'}">${a.active ? 'Active' : 'Deactivated'}</span>
                </td>
                <td><small class="muted">${a.reviewedAt || a.createdAt || '—'}</small></td>
                <td>
                  <button class="ghost viewAdminBtn" data-user='${JSON.stringify(a).replace(/'/g, "&apos;")}'>View Details</button>
                  ${a.active ? `
                    <button class="danger deactAdminBtn" data-id="${a.id}" data-name="${esc(a.displayName)}" data-user="${esc(a.userId)}">Deactivate Access</button>
                  ` : `
                    <button class="primary actAdminBtn" data-id="${a.id}" data-name="${esc(a.displayName)}" data-user="${esc(a.userId)}">Activate Access</button>
                  `}
                </td>
              </tr>
            `).join('') : '<tr><td colspan="7" class="empty">No approved administrators found. Approve applications in the Approval Queue.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function operatorMgmtPage() {
  return `
    <div class="page-actions">
      <div>
        <b>Operator Management</b>
        <div class="muted">Authorized warehouse floor workers permitted to execute Store and Retrieve movements.</div>
      </div>
      <button class="primary" id="refreshOperators">↻ Refresh List</button>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div>
          <h3>Approved Floor Operators (${approvedOpsList.length})</h3>
          <span class="muted">Active warehouse picking & storage operators.</span>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>User ID</th>
              <th>Full Name</th>
              <th>Employee ID</th>
              <th>Account Status</th>
              <th>Approved Date</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${approvedOpsList.length ? approvedOpsList.map(o => `
              <tr>
                <td><b>${esc(o.userId)}</b></td>
                <td>${esc(o.displayName)}</td>
                <td>${esc(o.employeeId || '—')}</td>
                <td>
                  <span class="badge ${o.active ? 'green' : 'red'}">${o.active ? 'Active' : 'Deactivated'}</span>
                </td>
                <td><small class="muted">${o.reviewedAt || o.createdAt || '—'}</small></td>
                <td>
                  <button class="ghost viewOpBtn" data-user='${JSON.stringify(o).replace(/'/g, "&apos;")}'>View Details</button>
                  ${o.active ? `
                    <button class="danger deactOpBtn" data-id="${o.id}" data-name="${esc(o.displayName)}" data-user="${esc(o.userId)}">Deactivate Access</button>
                  ` : `
                    <button class="primary actOpBtn" data-id="${o.id}" data-name="${esc(o.displayName)}" data-user="${esc(o.userId)}">Activate Access</button>
                  `}
                </td>
              </tr>
            `).join('') : '<tr><td colspan="6" class="empty">No approved operators found. Approve applications in Operator Approvals.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function storePage() {
  const availableSlots = slots.filter(s => Number(s.quantity || 0) < Number(s.capacity || 10));
  return `
    <div class="grid two">
      <div class="panel">
        <h3>📥 Store Stock (Operator Movement)</h3>
        <p class="muted">Select a rack slot and specify quantity to store items safely into warehouse storage.</p>
        <div class="form">
          <label for="storeSlotSelect">Select Target Slot *</label>
          <select id="storeSlotSelect" class="search" style="width:100%;max-width:none;padding:12px;">
            ${availableSlots.map(s => {
              const free = Number(s.capacity || 10) - Number(s.quantity || 0);
              return `<option value="${s.slot}">${s.slot} — ${esc(s.item_name)} (${s.quantity}/${s.capacity} in stock, ${free} space free)</option>`;
            }).join('') || '<option value="">No available slots with free capacity</option>'}
          </select>

          <label for="storeQtyInput" style="margin-top:12px;">Quantity to Store *</label>
          <input id="storeQtyInput" type="number" min="1" max="50" value="1">

          <div class="actions" style="margin-top:16px;">
            <button class="primary wide" id="execStoreBtn">Execute Store Movement →</button>
          </div>
        </div>
      </div>
      <div class="panel">
        <h3>Recent Movements</h3>
        <span class="muted">My movement activity</span>
        ${activity(10)}
      </div>
    </div>
  `;
}

function retrievePage() {
  const stockSlots = slots.filter(s => Number(s.quantity || 0) > 0);
  return `
    <div class="grid two">
      <div class="panel">
        <h3>📤 Retrieve Stock (Operator Movement)</h3>
        <p class="muted">Select a rack slot and specify quantity to pick and retrieve items from warehouse storage.</p>
        <div class="form">
          <label for="retSlotSelect">Select Stock Slot *</label>
          <select id="retSlotSelect" class="search" style="width:100%;max-width:none;padding:12px;">
            ${stockSlots.map(s => `
              <option value="${s.slot}">${s.slot} — ${esc(s.item_name)} (${s.quantity} unit(s) available)</option>
            `).join('') || '<option value="">No slots with available stock</option>'}
          </select>

          <label for="retQtyInput" style="margin-top:12px;">Quantity to Retrieve *</label>
          <input id="retQtyInput" type="number" min="1" max="50" value="1">

          <div class="actions" style="margin-top:16px;">
            <button class="primary wide" id="execRetBtn">Execute Retrieve Movement →</button>
          </div>
        </div>
      </div>
      <div class="panel">
        <h3>Recent Movements</h3>
        <span class="muted">My movement activity</span>
        ${activity(10)}
      </div>
    </div>
  `;
}

function platformStoresPage() {
  const activeStores = platformStoresList.filter(s => s.status === 'active');
  const suspendedStores = platformStoresList.filter(s => s.status === 'suspended');
  return `
    <div class="page-actions">
      <div>
        <b>Platform Stores Overview</b>
        <div class="muted">Platform Owner control center: onboard, inspect, approve, and govern all independent stores and dark store tenants.</div>
      </div>
      <button class="primary" id="refreshPlatformStores">↻ Refresh Stores</button>
    </div>

    <!-- PENDING APPLICATIONS -->
    <div class="panel" style="margin-bottom:20px;">
      <div class="panel-head">
        <div>
          <h3>Pending Store Registration Applications (${platformPendingStoresList.length})</h3>
          <span class="muted">Applications submitted by independent businesses awaiting platform approval.</span>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Store Name</th>
              <th>Code</th>
              <th>Type</th>
              <th>City</th>
              <th>Applicant / Owner</th>
              <th>Contact Details</th>
              <th>Reason</th>
              <th>Requested At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${platformPendingStoresList.length ? platformPendingStoresList.map(s => `
              <tr>
                <td><b>${esc(s.name)}</b></td>
                <td><code>${esc(s.code)}</code></td>
                <td><span class="badge cyan">${esc(formatStoreType(s.store_type))}</span></td>
                <td>${esc(s.city || '—')}</td>
                <td><b>${esc(s.owner_name || s.owner_user_id)}</b><br><small class="muted">ID: ${esc(s.owner_user_id)}</small></td>
                <td>${esc(s.owner_email || '—')}<br><small class="muted">${esc(s.owner_phone || '—')}</small></td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;">${esc(s.application_reason || '—')}</td>
                <td><small class="muted">${s.created_at || s.requested_at || '—'}</small></td>
                <td>
                  <div style="display:flex;gap:6px;">
                    <button class="primary approveStoreBtn" data-id="${s.id}" data-name="${attr(s.name)}">Approve</button>
                    <button class="danger rejectStoreBtn" data-id="${s.id}" data-name="${attr(s.name)}">Reject</button>
                  </div>
                </td>
              </tr>
            `).join('') : '<tr><td colspan="9" class="empty">No pending store registration applications.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <!-- ALL PLATFORM STORES -->
    <div class="panel">
      <div class="panel-head">
        <div>
          <h3>All Registered Platform Stores (${platformStoresList.length})</h3>
          <span class="muted">Active and suspended grocery stores, quick-commerce dark stores, and warehouses.</span>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Store Name</th>
              <th>Store Code</th>
              <th>Store Type</th>
              <th>Status</th>
              <th>Slots</th>
              <th>Active Staff</th>
              <th>Owner ID</th>
              <th>Created At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${platformStoresList.length ? platformStoresList.map(s => `
              <tr>
                <td>
                  <b>${esc(s.name)}</b>
                  ${s.id === activeStoreId ? '<span class="badge blue" style="margin-left:6px;">Active Store</span>' : ''}
                </td>
                <td><code>${esc(s.code)}</code></td>
                <td><span class="badge cyan">${esc(formatStoreType(s.store_type))}</span></td>
                <td>
                  <span class="badge ${s.status === 'active' ? 'green' : s.status === 'suspended' ? 'red' : 'orange'}">
                    ${s.status.toUpperCase()}
                  </span>
                </td>
                <td><b>${s.slot_count ?? 16}</b> slots</td>
                <td>${s.active_members_count ?? '—'}</td>
                <td><code>${esc(s.owner_user_id || 'testboss')}</code></td>
                <td><small class="muted">${s.created_at || '—'}</small></td>
                <td>
                  <div style="display:flex;gap:6px;align-items:center;">
                    ${s.id !== activeStoreId && s.status === 'active' ? `
                      <button class="ghost switchToStoreBtn" data-id="${s.id}">Switch To</button>
                    ` : ''}
                    ${s.id !== 'store_default_001' ? (
                      s.status === 'active' ? `
                        <button class="danger suspendStoreBtn" data-id="${s.id}" data-name="${attr(s.name)}">Suspend</button>
                      ` : s.status === 'suspended' ? `
                        <button class="primary activateStoreBtn" data-id="${s.id}" data-name="${attr(s.name)}">Reactivate</button>
                      ` : ''
                    ) : '<span class="badge green">Default Store</span>'}
                  </div>
                </td>
              </tr>
            `).join('') : '<tr><td colspan="9" class="empty">No registered stores found.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function storeStaffPage() {
  const currentRole = getCurrentStoreRole();
  const isOwner = currentRole === 'owner' || currentRole === 'store_owner' || currentRole === 'boss' || isPlatformOwner;

  return `
    <div class="page-actions">
      <div>
        <b>Store Staff & Access Control</b>
        <div class="muted">Manage operators and supervisors for <b>${esc(activeStore?.name || 'Active Store')}</b> (${esc(activeStore?.code || activeStoreId)}).</div>
      </div>
      <button class="primary" id="refreshStaff">↻ Refresh Staff</button>
    </div>

    <div class="grid two">
      <!-- ADD STAFF FORM -->
      <div class="panel">
        <h3>Add Staff Member</h3>
        <p class="muted">${isOwner ? 'Assign a new Store Admin or Operator to this store.' : 'Assign a new Operator to this store.'}</p>
        <div class="form">
          <label for="staffRoleSelect">Staff Role *</label>
          <select id="staffRoleSelect" class="search" style="width:100%;max-width:none;padding:12px;">
            <option value="operator">Operator (Picking, packing & stock movements)</option>
            ${isOwner ? '<option value="store_admin">Store Admin (Supervises store & operators)</option>' : ''}
          </select>

          <label for="staffUserId">User ID *</label>
          <input id="staffUserId" placeholder="e.g. op_john or existing user ID">

          <label for="staffDisplayName">Full Display Name *</label>
          <input id="staffDisplayName" placeholder="e.g. John Doe">

          <label for="staffPassword">Password (8+ chars) *</label>
          <input id="staffPassword" type="password" placeholder="Min. 8 characters">

          <label for="staffEmail">Work Email</label>
          <input id="staffEmail" type="email" placeholder="john@example.com">

          <label for="staffPhone">Mobile Phone</label>
          <input id="staffPhone" type="tel" placeholder="+919876543210">

          <label for="staffEmpId">Employee Badge / ID #</label>
          <input id="staffEmpId" placeholder="e.g. EMP-101">

          <div class="actions" style="margin-top:16px;">
            <button class="primary wide" id="addStaffBtn">Add Staff Member →</button>
          </div>
        </div>
      </div>

      <!-- CURRENT STAFF LIST -->
      <div class="panel">
        <div class="panel-head">
          <div>
            <h3>Current Store Members (${storeMembersList.length})</h3>
            <span class="muted">Authorized users with active or deactivated memberships in this store.</span>
          </div>
        </div>
        <div style="margin-top:14px; max-height: 550px; overflow: auto;">
          ${storeMembersList.length ? storeMembersList.map(m => `
            <div class="list-row" style="display:flex;justify-content:space-between;align-items:center;padding:12px;border-bottom:1px solid #e2e8f0;">
              <div>
                <b>${esc(m.display_name || m.user_id)}</b>
                <span class="badge ${m.role === 'store_owner' ? 'cyan' : m.role === 'store_admin' ? 'orange' : 'green'}" style="margin-left:6px;">
                  ${m.role === 'store_owner' ? 'Owner' : m.role === 'store_admin' ? 'Admin' : 'Operator'}
                </span>
                <div class="muted">
                  ID: <code>${esc(m.user_id)}</code> · Status: <span class="badge ${m.status === 'active' ? 'green' : 'red'}" style="padding:2px 6px;font-size:10px;">${m.status}</span>
                  ${m.email ? ' · ' + esc(m.email) : ''}
                  ${m.employee_id ? ' · Badge: ' + esc(m.employee_id) : ''}
                </div>
              </div>
              <div>
                ${(m.role !== 'store_owner' && m.user_id !== 'testboss') ? (
                  m.status === 'active' ? `
                    <button class="danger deactMemberBtn" data-id="${m.id}" data-name="${attr(m.display_name || m.user_id)}" data-user="${esc(m.user_id)}">Deactivate</button>
                  ` : `
                    <button class="primary actMemberBtn" data-id="${m.id}" data-name="${attr(m.display_name || m.user_id)}" data-user="${esc(m.user_id)}">Activate</button>
                  `
                ) : '<span class="badge green">Protected</span>'}
              </div>
            </div>
          `).join('') : '<div class="empty">No staff members found for this store.</div>'}
        </div>
      </div>
    </div>
  `;
}

function storeDevicesPage() {
  const currentRole = getCurrentStoreRole();
  const isOwner = currentRole === 'owner' || currentRole === 'store_owner' || currentRole === 'boss' || isPlatformOwner;

  return `
    <div class="page-actions">
      <div>
        <b>Store Hardware Devices & Controllers</b>
        <div class="muted">Manage edge controllers, ESP32 microcontrollers, and picking stations for <b>${esc(activeStore?.name || 'Active Store')}</b>.</div>
      </div>
      <button class="primary" id="refreshDevices">↻ Refresh Devices</button>
    </div>

    <!-- HARDWARE CONNECTION INFO -->
    <div class="panel" style="margin-bottom:20px;">
      <div class="panel-head">
        <div>
          <h3>Edge Hardware Connection Details</h3>
          <span class="muted">Microcontrollers (ESP32) connect via HTTP with store-specific device authentication.</span>
        </div>
      </div>
      <div class="grid two" style="margin-top:10px;">
        <div class="field">
          <label>Cloud Base URL</label>
          <div style="display:flex;gap:8px;">
            <input type="text" readonly value="${window.location.origin}" id="deviceBaseUrlInput">
            <button class="ghost" id="copyDeviceBaseUrl">Copy</button>
          </div>
        </div>
        <div class="field">
          <label>Movement Endpoints</label>
          <input type="text" readonly value="POST /api/hardware/store &nbsp;|&nbsp; POST /api/hardware/retrieve">
        </div>
      </div>
      <small class="muted" style="display:block;margin-top:8px;">
        Send header: <code>x-api-key: &lt;DEVICE_KEY&gt;</code> with JSON payload: <code>{"slot": "A1", "quantity": 1}</code>.
      </small>
    </div>

    <div class="grid two">
      <!-- REGISTER NEW DEVICE (Store Owner only) -->
      ${isOwner ? `
        <div class="panel">
          <h3>Register New Hardware Device</h3>
          <p class="muted">Add an ESP32 controller, keypad, or barcode station to this store.</p>
          <div class="form">
            <label for="newDeviceName">Device Name / Location *</label>
            <input id="newDeviceName" placeholder="e.g. Shelf Rack 1 ESP32 Controller">

            <div class="actions" style="margin-top:16px;">
              <button class="primary wide" id="registerDeviceBtn">Register Hardware Device →</button>
            </div>
          </div>
        </div>
      ` : ''}

      <!-- REGISTERED DEVICES LIST -->
      <div class="panel" style="${isOwner ? '' : 'grid-column: 1 / -1;'}">
        <div class="panel-head">
          <div>
            <h3>Active Store Devices (${storeDevicesList.length})</h3>
            <span class="muted">Authorized hardware controllers assigned to this store.</span>
          </div>
        </div>
        <div class="table-wrap" style="margin-top:10px;">
          <table class="table">
            <thead>
              <tr>
                <th>Device Name</th>
                <th>Status</th>
                <th>Masked Key</th>
                <th>Registered At</th>
                ${isOwner ? '<th>Actions</th>' : ''}
              </tr>
            </thead>
            <tbody>
              ${storeDevicesList.length ? storeDevicesList.map(d => `
                <tr>
                  <td><b>${esc(d.device_name)}</b></td>
                  <td><span class="badge ${d.status === 'active' ? 'green' : 'orange'}">${d.status}</span></td>
                  <td><code>${esc(d.masked_key || 'asrs_hw_****')}</code></td>
                  <td><small class="muted">${d.created_at || '—'}</small></td>
                  ${isOwner ? `
                    <td>
                      <button class="danger rotateDeviceBtn" data-id="${d.id}" data-name="${attr(d.device_name)}">Rotate Key</button>
                    </td>
                  ` : ''}
                </tr>
              `).join('') : '<tr><td colspan="5" class="empty">No hardware devices registered for this store.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function profilePage() {
  return `
    <div class="panel" style="max-width:650px; margin: 0 auto;">
      <div class="panel-head">
        <div>
          <h3>👤 My Profile & Contact Verification</h3>
          <span class="muted">Manage your personal details and contact verification for account recovery.</span>
        </div>
      </div>
      <div class="form">
        <label>User ID</label>
        <input type="text" readonly value="${esc(me?.userId || '')}">

        <label style="margin-top:10px;">Role</label>
        <div>
          <span class="badge ${me?.role === 'owner' || me?.role === 'boss' ? 'cyan' : me?.role === 'admin' ? 'orange' : 'green'}">${roleLabels[me?.role] || me?.role}</span>
        </div>

        <label style="margin-top:10px;">Display Name</label>
        <input id="profileNameInput" type="text" value="${esc(me?.displayName || '')}">

        <label style="margin-top:10px;">Registered Email Address</label>
        <div style="display:flex;gap:8px;">
          <input id="profileEmailInput" type="email" placeholder="e.g. you@company.com" value="${esc(me?.email || '')}">
          <span class="badge ${me?.emailVerified || me?.email_verified ? 'green' : 'orange'}" style="align-self:center;">${me?.emailVerified || me?.email_verified ? '✓ Verified' : 'Unverified'}</span>
        </div>

        <label style="margin-top:10px;">Registered Mobile Number</label>
        <div style="display:flex;gap:8px;">
          <input id="profilePhoneInput" type="tel" placeholder="e.g. +919876543210" value="${esc(me?.phone || '')}">
          <span class="badge ${me?.phoneVerified || me?.phone_verified ? 'green' : 'orange'}" style="align-self:center;">${me?.phoneVerified || me?.phone_verified ? '✓ Verified' : 'Unverified'}</span>
        </div>

        <div class="actions" style="margin-top:16px">
          <button class="primary" id="saveProfileBtn">Save Profile & Contacts</button>
        </div>
      </div>
    </div>
  `;
}

function render() {
  const c = $('content');
  if (!c) return;
  c.innerHTML = page === 'dashboard' ? dashboard() :
    page === 'inventory' ? inventory() :
    page === 'rack' ? rackPage() :
    page === 'history' ? historyPage() :
    page === 'platform_stores' ? platformStoresPage() :
    page === 'store_staff' ? storeStaffPage() :
    page === 'store_devices' ? storeDevicesPage() :
    page === 'users' ? usersPage() :
    page === 'operators' ? usersPage() :
    page === 'admin_mgmt' ? adminMgmtPage() :
    page === 'operator_mgmt' ? operatorMgmtPage() :
    page === 'approvals' ? approvalsPage() :
    page === 'store' ? storePage() :
    page === 'retrieve' ? retrievePage() :
    page === 'profile' ? profilePage() :
    page === 'reports' ? reports() :
    settings();
  wire();
}

function wire() {
  // Store Switcher
  $('storeSelect')?.addEventListener('change', e => {
    switchStore(e.target.value);
  });

  $('refresh')?.addEventListener('click', load);
  $('refreshApprovals')?.addEventListener('click', load);
  $('refreshAdmins')?.addEventListener('click', load);
  $('refreshOperators')?.addEventListener('click', load);
  $('refreshPlatformStores')?.addEventListener('click', load);
  $('refreshStaff')?.addEventListener('click', load);
  $('refreshDevices')?.addEventListener('click', load);

  // Platform Stores handlers
  document.querySelectorAll('.approveStoreBtn').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const name = b.dataset.name;
    if (!confirm(`Approve store registration for '${name}'?\n\nThis will activate the store, initialize default rack slots (A1-D4), activate the store owner account, and generate a primary hardware device key.`)) return;
    try {
      const res = await api(`/api/platform/stores/${id}/approve`, { method: 'POST' });
      toast(res.message);
      if (res.deviceKey) {
        alert(`Store '${name}' Approved Successfully!\n\nDefault Hardware API Key:\n${res.deviceKey}\n\nSave this key securely. It can also be rotated in Store Devices.`);
      }
      await fetchUserStores();
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  document.querySelectorAll('.rejectStoreBtn').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const name = b.dataset.name;
    const reason = prompt(`Enter rejection reason for store '${name}':`, 'Application does not meet platform requirements');
    if (reason === null) return;
    try {
      const res = await api(`/api/platform/stores/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ rejectionReason: reason })
      });
      toast(res.message);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  document.querySelectorAll('.suspendStoreBtn').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const name = b.dataset.name;
    if (!confirm(`Are you sure you want to suspend store '${name}'?\n\nAll operations in this store will be blocked until reactivated.`)) return;
    try {
      const res = await api(`/api/platform/stores/${id}/suspend`, { method: 'POST' });
      toast(res.message);
      await fetchUserStores();
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  document.querySelectorAll('.activateStoreBtn').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const name = b.dataset.name;
    if (!confirm(`Reactivate store '${name}'?`)) return;
    try {
      const res = await api(`/api/platform/stores/${id}/activate`, { method: 'POST' });
      toast(res.message);
      await fetchUserStores();
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  document.querySelectorAll('.switchToStoreBtn').forEach(b => b.onclick = () => {
    const id = b.dataset.id;
    switchStore(id);
  });

  // Store Staff handlers
  $('addStaffBtn')?.addEventListener('click', async () => {
    const role = $('staffRoleSelect')?.value || 'operator';
    const userId = $('staffUserId')?.value.trim();
    const displayName = $('staffDisplayName')?.value.trim();
    const password = $('staffPassword')?.value;
    const email = $('staffEmail')?.value.trim();
    const phone = $('staffPhone')?.value.trim();
    const employeeId = $('staffEmpId')?.value.trim();

    if (!userId || !displayName || !password) {
      return toast('User ID, Display Name, and Password (8+ chars) are required', true);
    }

    try {
      const res = await api(`/api/stores/${activeStoreId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId, role, displayName, password, email, phone, employeeId })
      });
      toast(res.message || 'Staff member added successfully');
      $('staffUserId').value = '';
      $('staffDisplayName').value = '';
      $('staffPassword').value = '';
      if ($('staffEmail')) $('staffEmail').value = '';
      if ($('staffPhone')) $('staffPhone').value = '';
      if ($('staffEmpId')) $('staffEmpId').value = '';
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  document.querySelectorAll('.deactMemberBtn').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const name = b.dataset.name;
    const user = b.dataset.user;
    if (!confirm(`Deactivate store access for member '${name}' (${user})?\n\nTheir sessions for this store will be revoked.`)) return;
    try {
      const res = await api(`/api/stores/${activeStoreId}/members/${id}/deactivate`, { method: 'POST' });
      toast(res.message);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  document.querySelectorAll('.actMemberBtn').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const name = b.dataset.name;
    const user = b.dataset.user;
    if (!confirm(`Reactivate store access for member '${name}' (${user})?`)) return;
    try {
      const res = await api(`/api/stores/${activeStoreId}/members/${id}/activate`, { method: 'POST' });
      toast(res.message);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // Store Hardware Devices handlers
  $('copyDeviceBaseUrl')?.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.origin);
    toast('Cloud Base URL copied to clipboard');
  });

  $('registerDeviceBtn')?.addEventListener('click', async () => {
    const deviceName = $('newDeviceName')?.value.trim() || 'ESP32 Controller';
    try {
      const res = await api(`/api/stores/${activeStoreId}/devices`, {
        method: 'POST',
        body: JSON.stringify({ deviceName })
      });
      alert(`Hardware Device Registered Successfully!\n\nDevice: ${res.deviceName}\nStore ID: ${res.storeId}\nDevice API Key:\n${res.deviceKey}\n\nIMPORTANT: Copy this API key now and flash it to your ESP32 controller.`);
      if ($('newDeviceName')) $('newDeviceName').value = '';
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  document.querySelectorAll('.rotateDeviceBtn').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const name = b.dataset.name;
    if (!confirm(`Rotate API key for '${name}'?\n\nThe existing key will be immediately invalidated and cannot be restored. Any ESP32 controller using the old key must be updated.`)) return;
    try {
      const res = await api(`/api/stores/${activeStoreId}/devices/${id}/rotate`, { method: 'POST' });
      alert(`Device Key Rotated Successfully!\n\nDevice: ${res.deviceName}\nNew Device API Key:\n${res.deviceKey}\n\nUpdate your controller firmware with this new key.`);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // Date filters & Excel export
  $('txApplyFilter')?.addEventListener('click', () => {
    txFromFilter = $('txFromDate')?.value || '';
    txToFilter = $('txToDate')?.value || '';
    if (txFromFilter && txToFilter && txFromFilter > txToFilter) {
      return toast('From Date cannot be later than To Date', true);
    }
    load();
  });

  $('txClearFilter')?.addEventListener('click', () => {
    txFromFilter = '';
    txToFilter = '';
    load();
  });

  $('txExportExcel')?.addEventListener('click', async () => {
    try {
      const from = $('txFromDate')?.value || '';
      const to = $('txToDate')?.value || '';
      if (from && to && from > to) {
        return toast('From Date cannot be later than To Date', true);
      }
      let url = `${BACKEND}/transactions/export`;
      const params = [];
      if (from) params.push(`from=${encodeURIComponent(from)}`);
      if (to) params.push(`to=${encodeURIComponent(to)}`);
      if (params.length) url += '?' + params.join('&');

      toast('Generating Excel export...');
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          ...(activeStoreId ? { 'x-store-id': activeStoreId } : {})
        }
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Export failed' }));
        throw new Error(err.error || 'Export failed');
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition');
      let filename = 'ASRS_Transactions.xlsx';
      if (disposition && disposition.includes('filename=')) {
        const m = disposition.match(/filename="?([^";]+)"?/);
        if (m && m[1]) filename = m[1];
      }
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(blobUrl);
      toast(`Excel export downloaded: ${filename}`);
    } catch (e) {
      toast(e.message, true);
    }
  });

  // Admin details & deactivation/activation
  document.querySelectorAll('.viewAdminBtn').forEach(b => b.onclick = () => {
    const u = JSON.parse(b.dataset.user || '{}');
    alert(`Administrator Details:\n\nUser ID: ${u.userId}\nFull Name: ${u.displayName}\nWork Email: ${u.email || 'None'}\nPhone: ${u.phone || 'None'}\nDepartment: ${u.organization || 'None'}\nEmployee ID: ${u.employeeId || 'None'}\nReason: ${u.registrationReason || 'None'}\nStatus: ${u.active ? 'Active' : 'Deactivated'}\nRequested At: ${u.requestedAt || 'N/A'}\nApproved At: ${u.reviewedAt || 'N/A'}\nApproved By: ${u.reviewedBy || 'N/A'}`);
  });

  document.querySelectorAll('.deactAdminBtn').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const name = b.dataset.name;
    const user = b.dataset.user;
    if (!confirm(`Are you sure you want to deactivate Administrator "${name}" (${user})?\n\nAll of their active sessions will be revoked immediately and they will be prevented from logging in.`)) return;
    try {
      const res = await api(`/api/owner/admins/${id}/deactivate`, { method: 'POST' });
      toast(res.message);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  document.querySelectorAll('.actAdminBtn').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const name = b.dataset.name;
    const user = b.dataset.user;
    if (!confirm(`Reactivate Administrator "${name}" (${user})?`)) return;
    try {
      const res = await api(`/api/owner/admins/${id}/activate`, { method: 'POST' });
      toast(res.message);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // Operator details & deactivation/activation
  document.querySelectorAll('.viewOpBtn').forEach(b => b.onclick = () => {
    const u = JSON.parse(b.dataset.user || '{}');
    alert(`Operator Details:\n\nUser ID: ${u.userId}\nFull Name: ${u.displayName}\nEmployee ID: ${u.employeeId || 'None'}\nEmail: ${u.email || 'None'}\nPhone: ${u.phone || 'None'}\nReason: ${u.registrationReason || 'None'}\nStatus: ${u.active ? 'Active' : 'Deactivated'}\nRequested At: ${u.requestedAt || 'N/A'}\nApproved At: ${u.reviewedAt || 'N/A'}\nApproved By: ${u.reviewedBy || 'N/A'}`);
  });

  document.querySelectorAll('.deactOpBtn').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const name = b.dataset.name;
    const user = b.dataset.user;
    if (!confirm(`Are you sure you want to deactivate Operator "${name}" (${user})?\n\nAll of their active sessions will be revoked immediately and they will be blocked from warehouse operations.`)) return;
    try {
      const res = await api(`/api/admin/operators/${id}/deactivate`, { method: 'POST' });
      toast(res.message);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  document.querySelectorAll('.actOpBtn').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const name = b.dataset.name;
    const user = b.dataset.user;
    if (!confirm(`Reactivate Operator "${name}" (${user})?`)) return;
    try {
      const res = await api(`/api/admin/operators/${id}/activate`, { method: 'POST' });
      toast(res.message);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // Search filters
  $('invSearchInput')?.addEventListener('input', e => {
    inventoryFilter = e.target.value;
    render();
    const input = $('invSearchInput');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  });

  $('histSearchInput')?.addEventListener('input', e => {
    historyFilter = e.target.value;
    render();
    const input = $('histSearchInput');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  });

  // Slot clicks & actions
  document.querySelectorAll('.slot').forEach(x => x.onclick = () => {
    if (me.role === 'operator') {
      openMove(x.dataset.slot);
    } else {
      toast(`Slot ${x.dataset.slot} selected. Stock movements are reserved for Operators.`);
    }
  });
  document.querySelectorAll('.action').forEach(b => b.onclick = () => openMove(b.dataset.slot, b.dataset.action));

  // Operator direct movement page buttons
  $('execStoreBtn')?.addEventListener('click', async () => {
    const slot = $('storeSlotSelect')?.value;
    const qty = Number($('storeQtyInput')?.value || 1);
    if (!slot) return toast('Please select a valid slot', true);
    try {
      await api('/store', {
        method: 'POST',
        body: JSON.stringify({ slot, quantity: qty, source: 'dashboard' })
      });
      toast(`Successfully stored ${qty} unit(s) into slot ${slot}`);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('execRetBtn')?.addEventListener('click', async () => {
    const slot = $('retSlotSelect')?.value;
    const qty = Number($('retQtyInput')?.value || 1);
    if (!slot) return toast('Please select a valid slot', true);
    try {
      await api('/retrieve', {
        method: 'POST',
        body: JSON.stringify({ slot, quantity: qty, source: 'dashboard' })
      });
      toast(`Successfully retrieved ${qty} unit(s) from slot ${slot}`);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // Approval queue action buttons
  document.querySelectorAll('.approveAdminBtn').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const user = b.dataset.user;
    if (!confirm(`Approve Administrator request for '${user}'?`)) return;
    try {
      const res = await api(`/api/owner/admins/${id}/approve`, { method: 'POST' });
      toast(res.message);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  document.querySelectorAll('.rejectAdminBtn').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const user = b.dataset.user;
    const reason = prompt(`Enter rejection reason for '${user}':`, 'Request rejected by Owner');
    if (reason === null) return;
    try {
      const res = await api(`/api/owner/admins/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ rejectionReason: reason })
      });
      toast(res.message);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  document.querySelectorAll('.approveOpBtn').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const user = b.dataset.user;
    if (!confirm(`Approve Operator request for '${user}'?`)) return;
    try {
      const res = await api(`/api/admin/operators/${id}/approve`, { method: 'POST' });
      toast(res.message);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  document.querySelectorAll('.rejectOpBtn').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const user = b.dataset.user;
    const reason = prompt(`Enter rejection reason for '${user}':`, 'Request rejected by Administrator');
    if (reason === null) return;
    try {
      const res = await api(`/api/admin/operators/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ rejectionReason: reason })
      });
      toast(res.message);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // Save product details
  document.querySelectorAll('.saveProduct').forEach(b => b.onclick = async () => {
    let slot = b.dataset.slot;
    try {
      await api('/slots/' + slot + '/product', {
        method: 'PUT',
        body: JSON.stringify({
          item_name: document.querySelector(`.editname[data-slot="${slot}"]`).value,
          sku: document.querySelector(`.editsku[data-slot="${slot}"]`).value
        })
      });
      toast('Product details saved successfully');
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // Save capacity
  document.querySelectorAll('.saveCap').forEach(b => b.onclick = async () => {
    let slot = b.dataset.slot;
    try {
      await api('/slots/' + slot + '/capacity', {
        method: 'PUT',
        body: JSON.stringify({
          capacity: Number(document.querySelector(`.cap[data-slot="${slot}"]`).value)
        })
      });
      toast('Slot capacity updated');
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // Dynamic Rack Size
  $('saveRackDim')?.addEventListener('click', async () => {
    const rows = Number($('rackRowsInput').value);
    const cols = Number($('rackColsInput').value);
    try {
      const res = await api('/rack/dimensions', {
        method: 'PUT',
        body: JSON.stringify({ rows, cols })
      });
      rackConfig = { rows, cols };
      toast(`Rack dimensions updated to ${rows} × ${cols} (${res.totalSlots} slots)`);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // Copy Hardware Base URL
  $('copyHwBaseUrl')?.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.origin);
    toast('Cloud Base URL copied to clipboard');
  });

  // Copy Hardware API Key
  $('copyHwKey')?.addEventListener('click', () => {
    if (hardwareKey) {
      navigator.clipboard.writeText(hardwareKey);
      toast('Hardware API key copied to clipboard');
    }
  });

  // Regenerate Hardware Key
  $('regenHwKey')?.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to regenerate the hardware API key? Any ESP32 using the old key will need to be updated.')) return;
    try {
      const res = await api('/hardware/key/regenerate', { method: 'POST' });
      hardwareKey = res.hardwareApiKey;
      $('hwKeyDisplay').value = hardwareKey;
      toast('New hardware key generated');
    } catch (e) {
      toast(e.message, true);
    }
  });

  // Save Admin Profile & Contact Info
  $('saveProfileBtn')?.addEventListener('click', async () => {
    const email = $('profileEmailInput').value.trim();
    const phone = $('profilePhoneInput').value.trim();
    const displayName = $('profileNameInput').value.trim();
    try {
      const res = await api('/auth/profile', {
        method: 'PUT',
        body: JSON.stringify({ email, phone, displayName })
      });
      me = res.user;
      sessionStorage.setItem('asrsUser', JSON.stringify(me));
      $('userName').textContent = me.displayName;
      toast('Profile & recovery contacts saved successfully');
      render();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // Create user
  $('createOp')?.addEventListener('click', async () => {
    try {
      const isOwner = me.role === 'owner' || me.role === 'boss';
      const role = isOwner ? ($('newRoleSelect')?.value || 'operator') : 'operator';
      await api('/users', {
        method: 'POST',
        body: JSON.stringify({
          displayName: $('opName').value.trim(),
          userId: $('opId').value.trim(),
          password: $('opPass').value,
          email: $('opEmail')?.value?.trim(),
          phone: $('opPhone')?.value?.trim(),
          role
        })
      });
      toast(`${role === 'admin' ? 'Admin' : 'Operator'} account created`);
      $('opName').value = $('opId').value = $('opPass').value = '';
      if ($('opEmail')) $('opEmail').value = '';
      if ($('opPhone')) $('opPhone').value = '';
      users = await api('/users');
      render();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // Toggle user active status
  document.querySelectorAll('.toggleUser').forEach(b => b.onclick = async () => {
    try {
      await api('/users/' + b.dataset.id, {
        method: 'PATCH',
        body: JSON.stringify({ active: b.dataset.active === '1' })
      });
      users = await api('/users');
      render();
      toast('User account status updated');
    } catch (e) {
      toast(e.message, true);
    }
  });
}

function openMove(code, action = 'store') {
  if (me.role !== 'operator') {
    toast(`Movement operations are restricted to approved Operators. You are signed in as ${me.displayName} (${roleLabels[me.role] || me.role}).`, true);
    return;
  }
  let s = slots.find(x => x.slot === code);
  if (!s) return;
  let bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal">
      <div class="panel-head">
        <h3>Slot ${s.slot} · ${esc(s.item_name)}</h3>
        <button class="ghost close">✕</button>
      </div>
      <p class="muted">SKU: <b>${esc(s.sku)}</b> · Current Stock: <b>${s.quantity}</b> / ${s.capacity} units</p>
      <div class="form">
        <label>Quantity to ${action}</label>
        <input id="moveQty" type="number" min="1" max="${action === 'retrieve' ? s.quantity : s.capacity - s.quantity}" value="1">
        <label>Select Operation</label>
        <div class="actions">
          <button class="ghost choose ${action === 'store' ? 'active' : ''}" data-action="store">📥 Store</button>
          <button class="ghost choose ${action === 'retrieve' ? 'active' : ''}" data-action="retrieve">📤 Retrieve</button>
        </div>
      </div>
      <div class="modal-actions">
        <button class="ghost close">Cancel</button>
        <button class="primary doMove">Confirm ${action === 'retrieve' ? 'Retrieve' : 'Store'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(bg);
  bg.querySelectorAll('.close').forEach(x => x.onclick = () => bg.remove());
  bg.querySelectorAll('.choose').forEach(x => x.onclick = () => {
    bg.remove();
    openMove(code, x.dataset.action);
  });
  bg.querySelector('.doMove').onclick = async () => {
    try {
      await api('/' + action, {
        method: 'POST',
        body: JSON.stringify({
          slot: code,
          item: s.item,
          quantity: Number(bg.querySelector('#moveQty').value),
          source: 'dashboard_operator_simulated'
        })
      });
      bg.remove();
      toast(`Stock ${action === 'store' ? 'stored' : 'retrieved'} successfully`);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function attr(v) { return esc(v).replace(/`/g, '&#96;'); }

function toast(msg, err = false) {
  let x = document.createElement('div');
  x.className = 'toast' + (err ? ' err' : '');
  x.textContent = msg;
  $('toast').appendChild(x);
  setTimeout(() => x.remove(), 3500);
}

init();
