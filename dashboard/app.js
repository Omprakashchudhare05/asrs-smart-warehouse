const BACKEND = window.location.origin;
let token = '', me = null, slots = [], transactions = [], users = [], page = 'dashboard';
let rackConfig = { rows: 4, cols: 4 };
let hardwareKey = '';
let inventoryFilter = '', historyFilter = '';
let refreshInterval = null;

const $ = id => document.getElementById(id);

const menus = {
  boss: [
    ['dashboard', '▣', 'Dashboard'],
    ['inventory', '▤', 'Inventory Management'],
    ['rack', '▦', 'Rack / Slots'],
    ['history', '◷', 'History'],
    ['operators', '♟', 'Operators'],
    ['reports', '▥', 'Reports'],
    ['settings', '⚙', 'Settings']
  ],
  operator: [
    ['dashboard', '▣', 'Dashboard'],
    ['inventory', '▤', 'Inventory Management'],
    ['rack', '▦', 'Rack / Slots'],
    ['history', '◷', 'History']
  ]
};

async function raw(path, opt = {}) {
  const r = await fetch(BACKEND + path, {
    ...opt,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opt.headers || {})
    }
  });
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

      // Check for saved session in sessionStorage for seamless re-opening
      const savedToken = sessionStorage.getItem('asrsToken');
      const savedUser = sessionStorage.getItem('asrsUser');
      if (savedToken && savedUser) {
        token = savedToken;
        me = JSON.parse(savedUser);
        try {
          await load();
          showApp();
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

async function login() {
  try {
    const d = await raw('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        userId: $('loginUser').value.trim(),
        password: $('loginPass').value
      })
    });
    const chosenRole = window.getChosenRole ? window.getChosenRole() : 'boss';
    if (d.user.role !== chosenRole) {
      throw Error(`This account role is '${d.user.role}', but you selected '${chosenRole}'. Please select '${d.user.role}'.`);
    }
    token = d.token;
    me = d.user;
    sessionStorage.setItem('asrsToken', token);
    sessionStorage.setItem('asrsUser', JSON.stringify(me));
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
  $('userName').textContent = me.displayName;
  $('userRole').textContent = me.role === 'boss' ? 'Boss / Administrator' : 'Warehouse Operator';
  $('avatar').textContent = (me.displayName || 'U')[0].toUpperCase();
  buildNav();
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
  const currentMenu = menus[me.role] || menus.operator;
  $('nav').innerHTML = currentMenu.map(([id, ico, label]) =>
    `<button data-page="${id}"><span class="ico">${ico}</span><span>${label}</span></button>`
  ).join('');
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => navigate(b.dataset.page));
}

function navigate(p) {
  const currentMenu = menus[me.role] || menus.operator;
  if (!currentMenu.some(x => x[0] === p)) p = 'dashboard';
  page = p;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.page === p));
  $('pageTitle').textContent = currentMenu.find(x => x[0] === p)?.[2] || p;
  render();
}

async function load() {
  try {
    const [slotsData, txData] = await Promise.all([
      api('/slots'),
      api('/transactions')
    ]);
    slots = slotsData;
    transactions = txData;
    if (me.role === 'boss') {
      if (page === 'operators') users = await api('/users');
      if (page === 'settings') {
        try {
          const hw = await api('/hardware/key');
          hardwareKey = hw.hardwareApiKey;
        } catch {}
      }
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
                  <button class="primary saveProduct" data-slot="${s.slot}">Save</button>
                  <button class="ghost action" data-action="store" data-slot="${s.slot}">📥 Store</button>
                  <button class="ghost action" data-action="retrieve" data-slot="${s.slot}">📤 Retrieve</button>
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
      (t.source || '').toLowerCase().includes(f)
    );
  }
  return `
    <div class="panel">
      <div class="panel-head">
        <div>
          <h3>Warehouse Transaction History</h3>
          <span class="muted">Total Transactions Logged: ${transactions.length}</span>
        </div>
        <div style="display:flex;gap:10px;">
          <input class="search" id="histSearchInput" placeholder="🔍 Search transaction history..." value="${esc(historyFilter)}">
          <button class="primary" id="refresh">↻ Refresh</button>
        </div>
      </div>
      <div class="table-wrap">
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
                <td>${esc(t.user_name || 'System')}</td>
                <td><small class="muted">${esc(t.source || 'dashboard')}</small></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
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

function operators() {
  return `
    <div class="grid two">
      <div class="panel">
        <h3>Create Operator Account</h3>
        <p class="muted">Create individual credentials for warehouse staff.</p>
        <div class="form">
          <label>Display Name</label>
          <input id="opName" placeholder="Operator full name">
          <label>User ID</label>
          <input id="opId" placeholder="Unique user ID">
          <label>Temporary Password (8+ characters)</label>
          <input id="opPass" type="password" placeholder="Set a password">
        </div>
        <div class="actions">
          <button class="primary" id="createOp">Create Operator</button>
        </div>
      </div>
      <div class="panel">
        <h3>Operator Accounts</h3>
        <div class="muted">Active operators with warehouse floor permissions.</div>
        <div style="margin-top:14px">
          ${users.map(u => `
            <div class="list-row">
              <div>
                <b>${esc(u.display_name)}</b>
                <div class="muted">${esc(u.user_id)} · ${u.active ? 'Active' : 'Disabled'}</div>
              </div>
              <button class="ghost toggleUser" data-id="${u.id}" data-active="${u.active ? 0 : 1}">
                ${u.active ? 'Disable' : 'Enable'}
              </button>
            </div>
          `).join('') || '<div class="empty">No operator accounts created yet.</div>'}
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
    page === 'operators' ? operators() :
    page === 'reports' ? reports() :
    settings();
  wire();
}

function wire() {
  $('refresh')?.addEventListener('click', load);

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
  document.querySelectorAll('.slot').forEach(x => x.onclick = () => openMove(x.dataset.slot));
  document.querySelectorAll('.action').forEach(b => b.onclick = () => openMove(b.dataset.slot, b.dataset.action));

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
      toast('Administrator profile & recovery contacts saved successfully');
      render();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // Create operator
  $('createOp')?.addEventListener('click', async () => {
    try {
      await api('/users', {
        method: 'POST',
        body: JSON.stringify({
          displayName: $('opName').value.trim(),
          userId: $('opId').value.trim(),
          password: $('opPass').value
        })
      });
      toast('Operator account created');
      $('opName').value = $('opId').value = $('opPass').value = '';
      users = await api('/users');
      render();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // Toggle operator active status
  document.querySelectorAll('.toggleUser').forEach(b => b.onclick = async () => {
    try {
      await api('/users/' + b.dataset.id, {
        method: 'PATCH',
        body: JSON.stringify({ active: b.dataset.active === '1' })
      });
      users = await api('/users');
      render();
      toast('Operator account updated');
    } catch (e) {
      toast(e.message, true);
    }
  });
}

function openMove(code, action = 'store') {
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
          source: 'dashboard'
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
