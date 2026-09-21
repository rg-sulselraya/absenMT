const state = {
  user: null,
  device: null,
  config: null,
  page: 'home',
  teacherData: null,
  dashboard: null,
  records: [],
  logs: [],
  teachers: [],
  branches: [],
  devices: [],
  sheetsTest: null,
  lastResult: null,
  isLoggingIn: false,
  isSavingPin: false,
  loginProgressTimers: [],
  scanner: { stream: null, raf: null, detector: null, detecting: false, processing: false, canvas: null, context: null, lastDecodeAt: 0 },
  serverTime: null,
  serverTimeReceivedAt: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
}

function todayLocal() {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).reduce((out, item) => { out[item.type] = item.value; return out; }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function displayAttendanceDate(value, fallback = '') {
  const text = String(value ?? '').trim();
  const match = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (match && !['1899-12-30', '1900-01-01'].includes(match[1])) return match[1];
  if (/^\d+(?:\.\d+)?$/.test(text) && Number(text) > 1) {
    return new Date(Date.UTC(1899, 11, 30) + Number(text) * 86400000).toISOString().slice(0, 10);
  }
  const fallbackMatch = String(fallback ?? '').match(/(\d{4}-\d{2}-\d{2})/);
  return fallbackMatch ? fallbackMatch[1] : '';
}

function displayAttendanceTime(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/(?:T|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (match) return `${String(match[1]).padStart(2, '0')}:${match[2]}:${match[3] || '00'}`;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const totalSeconds = Math.round((Number(text) % 1) * 86400) % 86400;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map(valuePart => String(valuePart).padStart(2, '0')).join(':');
  }
  return text || '—';
}

function humanDate(date) {
  const normalized = displayAttendanceDate(date);
  if (!normalized) return '—';
  return new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: state.config?.settings?.timezone || 'Asia/Makassar' }).format(new Date(`${normalized}T12:00:00`));
}

function humanShortDate(date) {
  const normalized = displayAttendanceDate(date);
  if (!normalized) return '—';
  return new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: state.config?.settings?.timezone || 'Asia/Makassar' }).format(new Date(`${normalized}T12:00:00`));
}

function formatDistance(meters) {
  if (meters === undefined || meters === null || Number.isNaN(Number(meters))) return '—';
  const value = Number(meters);
  if (value < 1000) return `${Math.round(value)} m`;
  return `${(value / 1000).toFixed(1).replace('.', ',')} km`;
}

function initials(name) {
  return String(name || '?').split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase();
}

function statusPill(recordOrKey, label) {
  const key = typeof recordOrKey === 'string' ? recordOrKey : recordOrKey?.locationKey;
  const labels = { area: 'Di Area', near: 'Dekat', outside: 'Di Luar Area', far: 'Jauh', neutral: 'Belum scan' };
  const tone = ['area', 'near', 'outside', 'far'].includes(key) ? ({ area: 'green', near: 'yellow', outside: 'orange', far: 'red' }[key]) : 'neutral';
  return `<span class="status-pill ${tone}">${escapeHtml(label || labels[key] || '—')}</span>`;
}

function branchName(branchId) {
  return state.branches.find(branch => branch.id === branchId)?.name || branchId || '—';
}

function showToast(message, tone = '') {
  const region = $('#toast-region');
  if (!region) return;
  const item = document.createElement('div');
  item.className = `toast ${tone}`;
  item.textContent = message;
  region.appendChild(item);
  setTimeout(() => item.remove(), 4000);
}

function perfLog(label, startedAt, details = {}) {
  if (!window.console?.info) return;
  console.info('[MTA PERF]', { label, elapsedMs: Math.round(performance.now() - startedAt), ...details });
}

const SESSION_KEY = 'mta_apps_session';

function readSessionToken() {
  return sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY) || '';
}

function rememberSessionToken(token) {
  if (!token) return;
  sessionStorage.setItem(SESSION_KEY, token);
  localStorage.setItem(SESSION_KEY, token);
}

function clearRememberedSession() {
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_KEY);
}

function setLoginStatus(message, tone = 'loading') {
  const status = $('#login-status');
  if (!status) return;
  status.textContent = message;
  status.className = `form-status ${tone}`;
  status.hidden = !message;
}

function clearLoginProgressTimers() {
  state.loginProgressTimers.forEach(timer => clearTimeout(timer));
  state.loginProgressTimers = [];
}

function startLoginProgress(button, role) {
  clearLoginProgressTimers();
  const label = button.querySelector('span:first-child');
  const isAdmin = role === 'admin';
  button.dataset.defaultLabel = label?.textContent || 'Masuk ke dashboard';
  if (label) label.textContent = '⏳ Memproses...';
  button.disabled = true;
  button.classList.add('loading');
  setLoginStatus(isAdmin ? 'Sedang memverifikasi login Admin... Mohon tunggu dan jangan tekan tombol kembali.' : 'Sedang memverifikasi data Master Teacher... Mohon tunggu dan jangan tekan tombol kembali.');
  state.loginProgressTimers = [
    setTimeout(() => setLoginStatus('Menghubungkan ke sistem...'), 0),
    setTimeout(() => setLoginStatus(isAdmin ? 'Memverifikasi credential Admin...' : 'Sedang memverifikasi data Master Teacher...'), 3000),
    setTimeout(() => setLoginStatus(isAdmin ? 'Login Admin masih diproses, mohon tunggu...' : 'Proses masih berjalan, mohon tunggu...'), 10000),
  ];
}

function stopLoginProgress(button) {
  clearLoginProgressTimers();
  const label = button.querySelector('span:first-child');
  if (label) label.textContent = button.dataset.defaultLabel || 'Masuk ke dashboard';
  button.disabled = false;
  button.classList.remove('loading');
}

async function api(endpoint, options = {}) {
  if (window.MTA_APPS_SCRIPT && window.google?.script?.run) {
    const sessionToken = readSessionToken();
    const requestBody = typeof options.body === 'string' ? (() => { try { return JSON.parse(options.body); } catch { return {}; } })() : (options.body || {});
    const payload = await new Promise((resolve, reject) => {
      const runner = window.google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(error => reject(new Error(error?.message || 'Permintaan Apps Script gagal.')));
      runner.apiRequest(options.method || 'GET', endpoint, requestBody, sessionToken);
    });
    if (!payload?.ok) {
      const err = new Error(payload?.message || 'Permintaan gagal.');
      err.code = payload?.code;
      err.details = payload?.details;
      err.status = payload?.status || 400;
      throw err;
    }
    if (payload.sessionToken) rememberSessionToken(payload.sessionToken);
    if (endpoint === '/api/auth/logout') clearRememberedSession();
    return payload;
  }
  if (window.MTA_API_BASE) {
    const sessionToken = readSessionToken();
    const method = String(options.method || 'GET').toUpperCase();
    const requestBody = typeof options.body === 'string' ? options.body : JSON.stringify(options.body || {});
    const separator = window.MTA_API_BASE.includes('?') ? '&' : '?';
    // Apps Script Web Apps redirect POST requests. Use a GET bridge for
    // cross-origin GitHub Pages calls so the browser keeps the request body.
    const mutation = method === 'GET' ? '' : `&method=${encodeURIComponent(method)}&body=${encodeURIComponent(requestBody)}`;
    const url = `${window.MTA_API_BASE}${separator}path=${encodeURIComponent(endpoint)}&session=${encodeURIComponent(sessionToken)}${mutation}`;
    const response = await fetch(url, { headers: { Accept: 'application/json', ...(options.headers || {}) } });
    let payload = {};
    try { payload = await response.json(); } catch { payload = { message: 'Respons Apps Script tidak valid.' }; }
    if (!response.ok || !payload?.ok) {
      const err = new Error(payload.message || 'Permintaan gagal.');
      err.code = payload.code;
      err.details = payload.details;
      err.status = payload.status || response.status;
      throw err;
    }
    if (payload.sessionToken) rememberSessionToken(payload.sessionToken);
    if (endpoint === '/api/auth/logout') clearRememberedSession();
    return payload;
  }
  const response = await fetch(endpoint, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  let payload = {};
  try { payload = await response.json(); } catch { payload = { message: 'Respons server tidak valid.' }; }
  if (!response.ok) {
    const err = new Error(payload.message || 'Permintaan gagal.');
    err.code = payload.code;
    err.details = payload.details;
    err.status = response.status;
    throw err;
  }
  return payload;
}

function deviceId() {
  let id = localStorage.getItem('mta_device_id');
  if (!id) {
    id = `DEVICE-${crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10)}`.toUpperCase();
    localStorage.setItem('mta_device_id', id);
  }
  return id;
}

function updateServerClock(iso) {
  if (iso) {
    state.serverTime = new Date(iso);
    state.serverTimeReceivedAt = Date.now();
  }
  const render = () => {
    const value = state.serverTime ? new Date(state.serverTime.getTime() + (Date.now() - state.serverTimeReceivedAt)) : new Date();
    const clock = $('#server-clock-value');
    if (clock) clock.textContent = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: state.config?.settings?.timezone || 'Asia/Makassar' }).format(value);
  };
  render();
  if (!state.clockInterval) state.clockInterval = setInterval(render, 1000);
}

function setLoginRole(role) {
  $$('.role-option').forEach(button => button.classList.toggle('active', button.dataset.loginRole === role));
  const label = $('.field-label[for="login-id"]');
  const input = $('#login-id');
  const pinLabel = $('.field-label[for="login-pin"]');
  const pinInput = $('#login-pin');
  if (role === 'admin') {
    label.textContent = 'ID Admin';
    input.placeholder = 'Contoh: admin';
    input.value = input.value === 'MT001' ? '' : input.value;
    pinLabel.textContent = 'PIN / Password';
    pinInput.placeholder = 'Masukkan PIN atau password admin';
    pinInput.removeAttribute('maxlength');
    pinInput.removeAttribute('inputmode');
  } else {
    label.textContent = 'ID Master Teacher';
    input.placeholder = 'Contoh: MT001';
    input.value = input.value === 'admin' ? '' : input.value;
    pinLabel.textContent = 'PIN 6 digit';
    pinInput.placeholder = 'Masukkan 6 digit PIN';
    pinInput.maxLength = 6;
    pinInput.inputMode = 'numeric';
  }
}

async function login(event) {
  if (state.isLoggingIn) return;
  const loginStartedAt = performance.now();
  perfLog('LOGIN_START', loginStartedAt);
  event.preventDefault();
  const form = event.currentTarget;
  const activeRole = $('.role-option.active')?.dataset.loginRole || 'teacher';
  const errorBox = $('#login-error');
  const button = form.querySelector('button[type="submit"]');
  state.isLoggingIn = true;
  errorBox.hidden = true;
  startLoginProgress(button, activeRole);
  try {
    perfLog('REQUEST_SENT', loginStartedAt);
    const payload = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ role: activeRole, id: $('#login-id').value, pin: $('#login-pin').value, deviceId: deviceId() }) });
    perfLog('FRONTEND_RESPONSE', loginStartedAt);
    state.user = payload.user;
    state.device = payload.device;
    updateServerClock(payload.serverTime);
    setLoginStatus('Login berhasil. Membuka dashboard...', 'success');
    showToast('✅ Login berhasil.', 'success');
    await enterApp(loginStartedAt);
    if (payload.device?.status === 'pending') showToast('Perangkat baru terdeteksi. Menunggu otorisasi Admin.', '');
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
    setLoginStatus('', 'error');
  } finally {
    state.isLoggingIn = false;
    stopLoginProgress(button);
  }
}

async function enterApp(loginStartedAt = performance.now()) {
  perfLog('DASHBOARD_START', loginStartedAt);
  $('#login-screen').hidden = true;
  $('#app-shell').hidden = false;
  $('#topbar-user-name').textContent = state.user.name;
  $('#topbar-user-role').textContent = state.user.role === 'admin' ? 'Admin' : 'Master Teacher';
  $('#topbar-avatar').textContent = initials(state.user.name);
  renderNav();
  perfLog('BASE_DATA_START', loginStartedAt);
  const baseDataPromise = loadBaseData(loginStartedAt).then(() => perfLog('BASE_DATA_END', loginStartedAt));
  perfLog('DASHBOARD_RENDER_START', loginStartedAt);
  // Show the destination immediately; configuration and page data load in parallel.
  // The page starts with its skeleton, so login does not remain blocked by slow Sheets/API calls.
  const navigationPromise = navigate(state.user.role === 'admin' ? 'dashboard' : 'home', true)
    .then(() => perfLog('DASHBOARD_RENDER_END', loginStartedAt))
    .catch(err => showToast(err.message, 'error'));
  void Promise.all([baseDataPromise, navigationPromise]);
}

async function loadBaseData(loginStartedAt = performance.now()) {
  try {
    perfLog('CONFIG_REQUEST_START', loginStartedAt);
    const config = await api('/api/config');
    perfLog('CONFIG_RESPONSE', loginStartedAt, { branches: (config.branches || []).length });
    state.config = config;
    state.branches = config.branches || [];
    if (!state.branches.length) {
      perfLog('BRANCHES_REQUEST_START', loginStartedAt);
      const branchPayload = await api('/api/branches');
      state.branches = branchPayload.branches || [];
      perfLog('BRANCHES_RESPONSE', loginStartedAt, { branches: state.branches.length });
    }
    $('#sidebar-branch-chip').textContent = `${state.branches.filter(branch => branch.active).length} cabang`;
    updateServerClock(config.serverTime);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderNav() {
  const isAdmin = state.user.role === 'admin';
  $('#app-shell').classList.toggle('admin-shell', isAdmin);
  $('#app-shell').classList.toggle('teacher-shell', !isAdmin);
  const groups = isAdmin ? [
    { title: 'OVERVIEW', items: [['dashboard', '⌂', 'Dashboard'], ['attendance', '◷', 'Absensi']] },
    { title: 'DATA MASTER', items: [['teachers', '♙', 'Master Teacher'], ['branches', '⌖', 'Cabang']] },
    { title: 'SISTEM', items: [['settings', '⚙', 'Pengaturan']] },
  ] : [
    { title: 'MENU UTAMA', items: [['home', '⌂', 'Beranda'], ['scan', '▣', 'Absensi'], ['history', '◷', 'Riwayat']] },
  ];
  $('#sidebar-nav').innerHTML = groups.map(group => `<p class="nav-group-title">${group.title}</p>${group.items.map(item => `<button class="nav-item" data-nav="${item[0]}"><span class="nav-icon">${item[1]}</span><span>${item[2]}</span></button>`).join('')}`).join('');
  $$('.nav-item').forEach(button => button.addEventListener('click', () => navigate(button.dataset.nav)));
}

const pageNames = { home: ['Beranda', 'Ringkasan'], scan: ['Absensi', 'Scan QR Absensi'], history: ['Riwayat', 'Riwayat Absensi'], dashboard: ['Dashboard', 'Ringkasan'], attendance: ['Absensi', 'Semua Absensi'], teachers: ['Master Teacher', 'Data Master'], branches: ['Cabang', 'Konfigurasi Cabang'], settings: ['Pengaturan', 'Keamanan & Integrasi'], result: ['Absensi', 'Hasil Scan'] };

async function navigate(page, replace = false) {
  stopCamera();
  state.page = page;
  if (!replace) history.replaceState({}, '', `#${page}`);
  const names = pageNames[page] || pageNames.home;
  $('#breadcrumb-section').textContent = names[0];
  $('#breadcrumb-page').textContent = names[1];
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.nav === page));
  $('#page-content').innerHTML = '<div class="card" style="height:240px;display:grid;place-items:center"><div class="skeleton" style="width:140px"></div></div>';
  if (state.user.role === 'admin') {
    if (page === 'dashboard') await renderAdminDashboard();
    else if (page === 'attendance') await renderAdminAttendance();
    else if (page === 'teachers') await renderTeachers();
    else if (page === 'branches') await renderBranches();
    else if (page === 'settings') await renderSettings();
  } else {
    if (page === 'home') await renderTeacherHome();
    else if (page === 'scan') renderScanner();
    else if (page === 'history') await renderTeacherHistory();
    else if (page === 'result') renderResult();
  }
  if (window.innerWidth <= 760) $('#sidebar').classList.remove('open');
}

function pageHeading(title, subtitle, right = '') {
  return `<div class="page-heading"><div><p class="eyebrow">${state.user.role === 'admin' ? 'ADMIN CONSOLE' : 'MASTER TEACHER'}</p><h1>${title}</h1><p>${subtitle}</p></div>${right}</div>`;
}

function deviceBanner() {
  if (state.user.role !== 'teacher' || !state.device) return '';
  if (state.device.status === 'pending') return `<div class="device-banner pending"><span class="banner-icon">⚠</span><div><strong>Perangkat belum terdaftar</strong><span>ID ${escapeHtml(state.device.id)} · Minta Admin mengotorisasi perangkat ini sebelum scan.</span></div></div>`;
  if (state.device.status === 'approved') return `<div class="device-banner approved"><span class="banner-icon">✓</span><div><strong>Perangkat terdaftar</strong><span>ID ${escapeHtml(state.device.id)} · Anda dapat melakukan absensi dari perangkat ini.</span></div></div>`;
  return `<div class="device-banner pending"><span class="banner-icon">⚠</span><div><strong>Perangkat tidak aktif</strong><span>Hubungi Admin untuk memulihkan akses perangkat.</span></div></div>`;
}

async function renderTeacherHome() {
  const attendanceStartedAt = performance.now();
  perfLog('HOME_ATTENDANCE_REQUEST_START', attendanceStartedAt);
  const data = await api(`/api/my-attendance?date=${todayLocal()}`).catch(err => { showToast(err.message, 'error'); return { date: todayLocal(), records: [], history: [], logs: [] }; });
  perfLog('HOME_ATTENDANCE_RESPONSE', attendanceStartedAt, { records: data.records?.length || 0 });
  state.teacherData = data;
  const masuk = data.records.find(record => record.type === 'MASUK');
  const pulang = data.records.find(record => record.type === 'PULANG');
  $('#page-content').innerHTML = `${pageHeading(`Halo, ${escapeHtml(state.user.name)}!`, 'Pantau status kehadiran dan lakukan absensi Anda hari ini.', `<button class="primary-button" data-action="go-scan"><span class="scan-glyph">⌗</span> Scan QR Absensi</button>`)}
    ${deviceBanner()}
    <div class="teacher-home">
      <section class="welcome-card"><p class="eyebrow light">KEHADIRAN HARI INI</p><h2>Selamat bekerja,<br>${escapeHtml(state.user.name)}.</h2><p>Pastikan Anda melakukan scan di area cabang untuk pencatatan lokasi yang akurat.</p><div class="welcome-bottom"><div class="welcome-date"><strong>${humanDate(data.date)}</strong>Waktu mengikuti server</div><button class="scan-button" data-action="go-scan"><span class="scan-glyph">⌗</span> SCAN QR ABSENSI <span>↗</span></button></div></section>
      <section class="card status-card"><h3>Status absensi</h3><div class="status-row"><span>Jam masuk</span><strong class="${masuk ? 'done-in' : ''}">${masuk ? `✓ ${displayAttendanceTime(masuk.time)}` : 'Belum scan'}</strong></div><div class="status-row"><span>Lokasi masuk</span><span>${masuk ? statusPill(masuk) : '—'}</span></div><div class="status-row"><span>Jam pulang</span><strong class="${pulang ? 'done-out' : ''}">${pulang ? `✓ ${displayAttendanceTime(pulang.time)}` : 'Belum scan'}</strong></div><div class="status-row"><span>Lokasi pulang</span><span>${pulang ? statusPill(pulang) : '—'}</span></div></section>
    </div>
    <section class="card scan-history-card"><div class="card-header"><div><h3>Aktivitas hari ini</h3><p>Catatan kehadiran dari perangkat Anda</p></div><button class="card-link" data-nav="history">Lihat semua →</button></div>${renderActivity(data.logs?.slice(0, 4))}</section>`;
  bindContentEvents();
}

function renderActivity(logs = []) {
  if (!logs.length) return `<div class="empty-state"><strong>Belum ada aktivitas hari ini</strong><span>Scan QR untuk mencatat jam masuk Anda.</span></div>`;
  return `<div class="activity-list">${logs.map(log => `<div class="activity-item"><div class="activity-mark ${log.result === 'complete' || log.locationKey === 'far' ? 'warning' : ''}">${log.result === 'complete' ? '!' : log.type === 'PULANG' ? '↗' : '✓'}</div><div class="activity-content"><strong>${log.result === 'complete' ? 'Absensi hari ini sudah lengkap' : `${log.type === 'MASUK' ? 'Jam masuk' : 'Jam pulang'} · ${escapeHtml(log.branchName)}`}</strong><small>${log.result === 'complete' ? 'Scan tambahan tercatat di log' : `${formatDistance(log.distanceMeters)} · ${escapeHtml(log.locationStatus || '')}`}</small></div><span class="activity-time">${escapeHtml(displayAttendanceTime(log.time))}</span></div>`).join('')}</div>`;
}

function renderScanner() {
  const branchHint = state.branches.filter(branch => branch.active).map(branch => branch.id).join(', ') || 'CAB-HRT';
  $('#page-content').innerHTML = `${pageHeading('Scan QR Absensi', 'Ikuti tiga langkah untuk mencatat kehadiran dengan lokasi yang terverifikasi.')}${deviceBanner()}<div class="scanner-layout"><section class="card scanner-card"><div id="scanner-stage" class="scanner-stage"><video id="scanner-video" playsinline muted></video><div class="scanner-placeholder"><div><div class="camera-icon"></div><strong>Siap memindai QR Code</strong><span>Izinkan akses kamera, lalu arahkan ke QR cabang.</span></div></div><div class="scanner-frame"><div class="scanner-line"></div></div></div><div class="scanner-actions"><button class="primary-button" id="start-camera-button"><span>⌾</span> Aktifkan kamera</button><button class="secondary-button" id="photo-qr-button" type="button">Ambil foto QR</button><button class="secondary-button" id="stop-camera-button" type="button">Hentikan kamera</button><input id="qr-image-input" type="file" accept="image/*" capture="environment" hidden></div><p class="scanner-note" id="scanner-note">Jika izin kamera ditolak, gunakan “Ambil foto QR” untuk memotret QR dengan kamera HP.</p><div class="manual-scan"><input id="manual-qr" placeholder="Payload QR, contoh CAB-HRT" autocomplete="off"/><button id="manual-qr-button" title="Lanjutkan">→</button></div></section><aside class="card scan-steps"><h3>Alur absensi</h3><div class="step"><span class="step-number">1</span><div><strong>Scan QR cabang</strong><span>QR memuat identifier unik cabang, bukan koordinat.</span></div></div><div class="step"><span class="step-number">2</span><div><strong>Ambil lokasi GPS</strong><span>Lokasi hanya diminta ketika scan dilakukan.</span></div></div><div class="step"><span class="step-number">3</span><div><strong>Catat waktu server</strong><span>Jarak dihitung ulang secara aman di backend.</span></div></div><div class="attention-card" style="margin-top:2px"><div class="attention-icon">i</div><div><h4>Cabang aktif</h4><p>${escapeHtml(branchHint)} · Setelah QR terbaca, GPS akan diminta otomatis.</p></div></div></aside></div>`;
  $('#start-camera-button').addEventListener('click', startCamera);
  $('#photo-qr-button').addEventListener('click', () => $('#qr-image-input').click());
  $('#qr-image-input').addEventListener('change', scanQrImage);
  $('#stop-camera-button').addEventListener('click', stopCamera);
  $('#manual-qr-button').addEventListener('click', () => processQr($('#manual-qr').value));
  $('#manual-qr').addEventListener('keydown', event => { if (event.key === 'Enter') processQr(event.currentTarget.value); });
}

async function startCamera() {
  const stage = $('#scanner-stage');
  const note = $('#scanner-note');
  if (!navigator.mediaDevices?.getUserMedia) {
    note.textContent = 'Kamera tidak tersedia di browser ini. Gunakan input payload QR manual.';
    showToast('Kamera tidak tersedia. Anda masih dapat memasukkan payload QR.', 'error');
    return;
  }
  try {
    state.scanner.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    const video = $('#scanner-video');
    video.srcObject = state.scanner.stream;
    await video.play();
    stage.classList.add('scanning');
    if ('BarcodeDetector' in window) {
      try { state.scanner.detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { state.scanner.detector = null; }
    }
    if (!state.scanner.detector && typeof window.jsQR !== 'function') {
      note.textContent = 'Preview kamera aktif, tetapi library pembaca QR belum tersedia. Gunakan “Ambil foto QR” atau input payload manual.';
      return;
    }
    note.textContent = state.scanner.detector
      ? 'Arahkan kamera ke QR Code cabang. Pemindaian akan berjalan otomatis.'
      : 'Arahkan kamera ke QR Code cabang. Pemindaian QR kompatibel sedang berjalan.';
    scanVideoFrame();
  } catch (err) {
    note.textContent = err.name === 'NotAllowedError' ? 'Izin kamera ditolak. Izinkan kamera di pengaturan browser atau gunakan “Ambil foto QR”.' : `Kamera tidak dapat diaktifkan: ${err.message}`;
    showToast(note.textContent, 'error');
  }
}

function scanQrImage(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  const note = $('#scanner-note');
  if (typeof window.jsQR !== 'function') {
    const message = 'Pemindai foto belum tersedia. Gunakan input payload QR manual.';
    if (note) note.textContent = message;
    return showToast(message, 'error');
  }
  const image = new Image();
  const objectUrl = URL.createObjectURL(file);
  image.onload = () => {
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const code = window.jsQR(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
    URL.revokeObjectURL(objectUrl);
    if (!code?.data) {
      const message = 'QR tidak terbaca dari foto. Pastikan seluruh QR terlihat jelas, lalu coba lagi.';
      if (note) note.textContent = message;
      return showToast(message, 'error');
    }
    processQr(code.data);
  };
  image.onerror = () => { URL.revokeObjectURL(objectUrl); showToast('Foto QR tidak dapat dibaca.', 'error'); };
  image.src = objectUrl;
}

function scanVideoFrame() {
  if (!state.scanner.stream || state.page !== 'scan') return;
  state.scanner.raf = requestAnimationFrame(async () => {
    const video = $('#scanner-video');
    if (video && video.readyState >= 2 && !state.scanner.detecting) {
      state.scanner.detecting = true;
      let decoded = '';
      try {
        if (state.scanner.detector) {
          const codes = await state.scanner.detector.detect(video);
          decoded = codes?.[0]?.rawValue || '';
        } else if (typeof window.jsQR === 'function' && performance.now() - state.scanner.lastDecodeAt >= 180) {
          state.scanner.lastDecodeAt = performance.now();
          const sourceWidth = video.videoWidth;
          const sourceHeight = video.videoHeight;
          if (sourceWidth && sourceHeight) {
            const scale = Math.min(1, 1280 / sourceWidth);
            const width = Math.max(1, Math.round(sourceWidth * scale));
            const height = Math.max(1, Math.round(sourceHeight * scale));
            if (!state.scanner.canvas) state.scanner.canvas = document.createElement('canvas');
            if (state.scanner.canvas.width !== width || state.scanner.canvas.height !== height) {
              state.scanner.canvas.width = width;
              state.scanner.canvas.height = height;
              state.scanner.context = state.scanner.canvas.getContext('2d', { willReadFrequently: true });
            }
            state.scanner.context.drawImage(video, 0, 0, width, height);
            decoded = window.jsQR(state.scanner.context.getImageData(0, 0, width, height).data, width, height, { inversionAttempts: 'attemptBoth' })?.data || '';
          }
        }
      } catch { /* Kamera masih mencari frame QR berikutnya. */ }
      state.scanner.detecting = false;
      if (decoded) return processQr(decoded);
    }
    scanVideoFrame();
  });
}

function stopCamera() {
  if (state.scanner.raf) cancelAnimationFrame(state.scanner.raf);
  state.scanner.raf = null;
  state.scanner.detecting = false;
  state.scanner.processing = false;
  state.scanner.lastDecodeAt = 0;
  if (state.scanner.stream) state.scanner.stream.getTracks().forEach(track => track.stop());
  state.scanner.stream = null;
  const video = $('#scanner-video');
  if (video) video.srcObject = null;
  $('#scanner-stage')?.classList.remove('scanning');
}

function setScannerProcessing(busy) {
  ['#start-camera-button', '#photo-qr-button', '#stop-camera-button', '#manual-qr-button', '#manual-qr'].forEach(selector => {
    const element = $(selector);
    if (element) element.disabled = busy;
  });
}

async function processQr(value) {
  if (state.scanner.processing) return;
  const payload = String(value || '').trim().toUpperCase();
  if (!payload) return showToast('QR belum terbaca. Arahkan kamera atau isi payload manual.', 'error');
  const branch = state.branches.find(item => item.active && (String(item.id || '').trim().toUpperCase() === payload || String(item.qrPayload || '').trim().toUpperCase() === payload));
  if (!branch) return showToast('QR tidak valid atau cabang tidak aktif. Minta scan ulang.', 'error');
  stopCamera();
  state.scanner.processing = true;
  setScannerProcessing(true);
  const note = $('#scanner-note');
  if (note) note.textContent = `⏳ Memproses absensi… Menentukan lokasi...`;
  if (!navigator.geolocation) {
    state.scanner.processing = false;
    setScannerProcessing(false);
    return showToast('GPS tidak tersedia di perangkat ini. Absensi tidak disimpan.', 'error');
  }
  try {
    const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }));
    if (note) note.textContent = '⏳ Lokasi ditemukan. Menyimpan absensi...';
    const result = await api('/api/attendance/scan', { method: 'POST', body: JSON.stringify({ branchId: payload, latitude: position.coords.latitude, longitude: position.coords.longitude }) });
    state.lastResult = result;
    if (result.complete) showToast(result.message, 'success');
    await navigate('result');
  } catch (err) {
    const messages = { GPS_INVALID: 'GPS tidak tersedia atau koordinat tidak valid. Aktifkan lokasi lalu coba lagi.', DEVICE_PENDING: 'Perangkat belum diotorisasi Admin.', BRANCH_COORDINATES_MISSING: 'Koordinat cabang belum dikonfigurasi Admin.', RATE_LIMITED: err.message };
    showToast(messages[err.code] || err.message, 'error');
    if (note) note.textContent = messages[err.code] || err.message;
  } finally {
    state.scanner.processing = false;
    setScannerProcessing(false);
  }
}

function renderResult() {
  const result = state.lastResult;
  if (!result) { $('#page-content').innerHTML = `${pageHeading('Hasil Scan', 'Belum ada hasil scan pada sesi ini.')}<div class="empty-state card"><strong>Belum ada hasil absensi</strong><span>Mulai dari menu Absensi untuk scan QR cabang.</span></div>`; return; }
  if (result.complete) {
    const log = result.log;
    $('#page-content').innerHTML = `${pageHeading('Absensi hari ini lengkap', 'Tidak ada record baru yang dibuat untuk scan tambahan.')}<div class="success-layout"><section class="card result-card"><div class="result-icon">✓</div><h2>Absensi hari ini sudah lengkap</h2><p>Scan tambahan tetap masuk ke log sebagai informasi audit Admin.</p><div class="result-highlight"><div><span>Master Teacher</span><strong>${escapeHtml(state.user.name)}</strong></div><div><span>Cabang QR</span><strong>${escapeHtml(log.branchName)}</strong></div><div><span>Waktu scan</span><strong>${escapeHtml(displayAttendanceTime(log.time))}</strong></div></div><div class="result-actions"><button class="secondary-button" data-action="go-home">Kembali ke beranda</button><button class="primary-button" data-action="go-scan">Scan lagi</button></div></section></div>`;
    bindContentEvents();
    return;
  }
  const record = result.record;
  const warning = result.warning ? `<div class="result-warning">⚠ ${escapeHtml(result.warning)}<br><span>GPS hanya menunjukkan lokasi scan, bukan membuktikan bagaimana QR diperoleh.</span></div>` : '';
  $('#page-content').innerHTML = `${pageHeading('Absensi berhasil', 'Data kehadiran telah tercatat dengan waktu server.')}<div class="success-layout"><section class="card result-card"><div class="result-icon">✓</div><h2>Absensi Berhasil</h2><p>${escapeHtml(record.type === 'MASUK' ? 'Jam masuk Anda sudah tersimpan.' : 'Jam pulang Anda sudah tersimpan.')}</p><div class="result-highlight"><div><span>Master Teacher</span><strong>${escapeHtml(record.mtName)}</strong></div><div><span>Cabang</span><strong>${escapeHtml(record.branchName)}</strong></div><div><span>Jenis</span><strong>${escapeHtml(record.type === 'MASUK' ? 'Jam Masuk' : 'Jam Pulang')}</strong></div><div><span>Waktu server</span><strong>${escapeHtml(displayAttendanceTime(record.time))}</strong></div><div><span>Jarak dari cabang</span><strong>${formatDistance(record.distanceMeters)}</strong></div><div><span>Koordinat scan</span><strong>${Number(record.latitude).toFixed(5)}, ${Number(record.longitude).toFixed(5)}</strong></div></div><div class="result-status">${statusPill(record, record.locationStatus)}</div>${warning}<div class="result-actions"><a class="maps-link" target="_blank" rel="noreferrer" href="https://www.google.com/maps?q=${encodeURIComponent(record.latitude)},${encodeURIComponent(record.longitude)}">Lihat lokasi di Google Maps ↗</a><button class="primary-button" data-action="go-home">Selesai</button></div></section></div>`;
  bindContentEvents();
}

async function renderTeacherHistory() {
  const data = await api('/api/my-attendance').catch(err => { showToast(err.message, 'error'); return { history: [], logs: [] }; });
  const records = data.history || [];
  $('#page-content').innerHTML = `${pageHeading('Riwayat Absensi', 'Semua catatan kehadiran Master Teacher Anda.', `<span class="page-intro-badge">${records.length} record</span>`)}<section class="card table-card"><div class="card-header"><div><h3>Riwayat scan</h3><p>Lokasi dan waktu dari server</p></div></div><div class="table-scroll">${records.length ? `<table class="attendance-table"><thead><tr><th>Tanggal</th><th>Jenis</th><th>Cabang</th><th>Jam server</th><th>Jarak</th><th>Status lokasi</th></tr></thead><tbody>${records.map(record => `<tr><td>${humanShortDate(record.date)}</td><td><strong>${record.type}</strong></td><td>${escapeHtml(record.branchName)}</td><td class="time-cell">${escapeHtml(displayAttendanceTime(record.time))}</td><td class="distance">${formatDistance(record.distanceMeters)}</td><td>${statusPill(record, record.locationStatus)}</td></tr>`).join('')}</tbody></table>` : `<div class="empty-state"><strong>Belum ada riwayat absensi</strong><span>Catatan Anda akan muncul setelah scan QR berhasil.</span></div>`}</div></section>`;
}

async function renderAdminDashboard() {
  const date = state.dashboard?.date || todayLocal();
  const data = await api(`/api/dashboard?date=${date}`).catch(err => { showToast(err.message, 'error'); return { date, metrics: { total: 0, masuk: 0, belumMasuk: 0, pulang: 0, outside: 0, newDevices: 0 }, rows: [], recentActivity: [] }; });
  state.dashboard = data;
  const metrics = data.metrics;
  $('#notification-count').textContent = metrics.newDevices;
  $('#notification-count').hidden = !metrics.newDevices;
  $('#page-content').innerHTML = `${pageHeading('Dashboard', 'Pantau kehadiran Master Teacher secara real-time.', `<input class="date-control" id="dashboard-date" type="date" value="${escapeHtml(data.date)}" />`)}<div class="stats-grid"><div class="stat-card"><div class="stat-top"><span class="stat-label">Total Master Teacher</span><span class="stat-icon teal">♙</span></div><div class="stat-number">${metrics.total}</div><div class="stat-foot">Akun aktif</div></div><div class="stat-card"><div class="stat-top"><span class="stat-label">Sudah Masuk</span><span class="stat-icon green">✓</span></div><div class="stat-number">${metrics.masuk}</div><div class="stat-foot"><strong>${metrics.total ? Math.round(metrics.masuk / metrics.total * 100) : 0}%</strong> dari total aktif</div></div><div class="stat-card"><div class="stat-top"><span class="stat-label">Belum Masuk</span><span class="stat-icon yellow">◷</span></div><div class="stat-number">${metrics.belumMasuk}</div><div class="stat-foot">Perlu dipantau</div></div><div class="stat-card"><div class="stat-top"><span class="stat-label">Sudah Pulang</span><span class="stat-icon blue">↗</span></div><div class="stat-number">${metrics.pulang}</div><div class="stat-foot">Data hari ini</div></div><div class="stat-card"><div class="stat-top"><span class="stat-label">Scan di Luar Area</span><span class="stat-icon orange">⚠</span></div><div class="stat-number">${metrics.outside}</div><div class="stat-foot">Perlu perhatian</div></div></div><div class="content-grid"><section class="card table-card"><div class="card-header"><div><h3>Ringkasan kehadiran</h3><p>${humanDate(data.date)}</p></div><button class="card-link" data-nav="attendance">Lihat detail →</button></div>${renderDashboardTable(data.rows)}</section><div><section class="card"><div class="card-header"><div><h3>Aktivitas terbaru</h3><p>Log scan hari ini</p></div></div>${renderActivity(data.recentActivity)}</section>${metrics.outside ? `<div class="attention-card"><div class="attention-icon">⚠</div><div><h4>${metrics.outside} scan di luar area</h4><p>Gunakan status lokasi sebagai indikator review, bukan bukti kecurangan.</p><button data-nav="attendance">Tinjau absensi →</button></div></div>` : ''}</div></div>`;
  $('#dashboard-date').addEventListener('change', event => { state.dashboard = { date: event.target.value }; renderAdminDashboard(); });
  bindContentEvents();
}

function renderDashboardTable(rows) {
  if (!rows.length) return `<div class="empty-state"><strong>Belum ada Master Teacher aktif</strong><span>Tambahkan data dari menu Master Teacher.</span></div>`;
  return `<div class="table-scroll"><table class="attendance-table"><thead><tr><th>Master Teacher</th><th>Cabang</th><th>Jam Masuk</th><th>Jarak</th><th>Jam Pulang</th><th>Jarak</th></tr></thead><tbody>${rows.map(row => `<tr class="clickable" data-record-id="${escapeHtml(row.masuk?.attendanceId || row.pulang?.attendanceId || '')}"><td><div class="teacher-cell"><span class="mini-avatar">${initials(row.teacher?.name)}</span><div><strong>${escapeHtml(row.teacher?.name)}</strong><small>${escapeHtml(row.teacher?.id)}</small></div></div></td><td><div class="branch-cell"><strong>${escapeHtml(row.branch?.name || '—')}</strong><small>${escapeHtml(row.branch?.id || '—')}</small></div></td><td class="time-cell">${row.masuk ? escapeHtml(displayAttendanceTime(row.masuk.time)) : '<span class="empty-cell">Belum scan</span>'}</td><td>${row.masuk ? `<span class="distance">${formatDistance(row.masuk.distanceMeters)} ${statusPill(row.masuk)}</span>` : '—'}</td><td class="time-cell">${row.pulang ? escapeHtml(displayAttendanceTime(row.pulang.time)) : '<span class="empty-cell">Belum scan</span>'}</td><td>${row.pulang ? `<span class="distance">${formatDistance(row.pulang.distanceMeters)} ${statusPill(row.pulang)}</span>` : '—'}</td></tr>`).join('')}</tbody></table></div><div class="table-footer"><span>Menampilkan ${rows.length} Master Teacher aktif</span><span>• Data dari server</span></div>`;
}

async function renderAdminAttendance() {
  const payload = await api('/api/attendance').catch(err => { showToast(err.message, 'error'); return { records: [], logs: [] }; });
  state.records = payload.records || [];
  state.logs = payload.logs || [];
  if (!state.teachers.length) state.teachers = (await api('/api/teachers').catch(() => ({ teachers: [] }))).teachers || [];
  if (!state.branches.length) state.branches = (await api('/api/branches').catch(() => ({ branches: [] }))).branches || [];
  $('#page-content').innerHTML = `${pageHeading('Semua Absensi', 'Filter dan tinjau detail lokasi setiap scan.', `<button class="secondary-button" data-action="refresh-page">↻ Muat ulang</button>`)}<div class="toolbar"><span class="toolbar-label">Filter</span><input class="date-control" id="attendance-date-filter" type="date" placeholder="Semua tanggal"/><select class="select-control" id="attendance-teacher-filter"><option value="">Semua Master Teacher</option>${state.teachers.map(teacher => `<option value="${escapeHtml(teacher.id)}">${escapeHtml(teacher.name)}</option>`).join('')}</select><select class="select-control small" id="attendance-branch-filter"><option value="">Semua cabang</option>${state.branches.map(branch => `<option value="${escapeHtml(branch.id)}">${escapeHtml(branch.name)}</option>`).join('')}</select><select class="select-control small" id="attendance-status-filter"><option value="">Semua status</option><option value="area">Di Area</option><option value="near">Dekat</option><option value="outside">Di Luar Area</option><option value="far">Jauh</option></select></div><section class="card table-card"><div class="card-header"><div><h3>Data absensi</h3><p id="attendance-count-label">${state.records.length} record tersimpan</p></div></div><div id="attendance-table-area">${renderAttendanceTable(state.records)}</div></section>`;
  ['attendance-date-filter', 'attendance-teacher-filter', 'attendance-branch-filter', 'attendance-status-filter'].forEach(id => $(`#${id}`).addEventListener('change', filterAttendance));
  bindContentEvents();
}

function renderAttendanceTable(records) {
  if (!records.length) return `<div class="empty-state"><strong>Belum ada record yang cocok</strong><span>Coba ubah filter atau lakukan scan absensi.</span></div>`;
  return `<div class="table-scroll"><table class="attendance-table"><thead><tr><th>Master Teacher</th><th>Tanggal / Jam</th><th>Cabang QR</th><th>Jenis</th><th>Lokasi scan</th><th>Jarak</th><th>Status</th><th></th></tr></thead><tbody>${records.map(record => `<tr class="clickable" data-record-id="${escapeHtml(record.attendanceId)}"><td><div class="teacher-cell"><span class="mini-avatar">${initials(record.mtName)}</span><div><strong>${escapeHtml(record.mtName)}</strong><small>${escapeHtml(record.mtId)}</small></div></div></td><td><strong>${humanShortDate(record.date)}</strong><small style="display:block;color:#a0aab6;margin-top:3px">${escapeHtml(displayAttendanceTime(record.time))}</small></td><td><div class="branch-cell"><strong>${escapeHtml(record.branchName)}</strong><small>${escapeHtml(record.branchId)}</small></div></td><td><span class="page-intro-badge">${record.type}</span></td><td class="distance">${Number(record.latitude).toFixed(5)}<br>${Number(record.longitude).toFixed(5)}</td><td class="distance">${formatDistance(record.distanceMeters)}</td><td>${statusPill(record, record.locationStatus)}</td><td><button class="record-link" data-record-id="${escapeHtml(record.attendanceId)}">Detail →</button></td></tr>`).join('')}</tbody></table></div><div class="table-footer"><span>${records.length} record ditemukan</span><span>Jarak dihitung di backend · timestamp server</span></div>`;
}

function filterAttendance() {
  const date = $('#attendance-date-filter').value;
  const mtId = $('#attendance-teacher-filter').value;
  const branchId = $('#attendance-branch-filter').value;
  const locationKey = $('#attendance-status-filter').value;
  const params = new URLSearchParams();
  if (date) params.set('date', date);
  if (mtId) params.set('mtId', mtId);
  if (branchId) params.set('branchId', branchId);
  if (locationKey) params.set('locationKey', locationKey);
  api(`/api/attendance?${params}`).then(payload => { state.records = payload.records || []; state.logs = payload.logs || []; const count = $('#attendance-count-label'); if (count) count.textContent = `${state.records.length} record tersimpan`; const area = $('#attendance-table-area'); if (area) area.innerHTML = renderAttendanceTable(state.records); bindContentEvents(); }).catch(err => showToast(err.message, 'error'));
}

async function renderTeachers() {
  let payload;
  try {
    payload = await api('/api/master-teachers');
  } catch (err) {
    showToast(`Google Sheets: ${err.message}`, 'error');
    $('#page-content').innerHTML = `${pageHeading('Master Teacher', 'Data utama dibaca dari Google Sheet.') }<section class="card"><div class="empty-state"><strong>Data Google Sheet tidak dapat dibaca</strong><span>${escapeHtml(err.message)}</span><button class="secondary-button" data-action="refresh-page">↻ Coba lagi</button></div></section>`;
    bindContentEvents();
    return;
  }
  state.teachers = payload.teachers || [];
  $('#page-content').innerHTML = `${pageHeading('Master Teacher', 'Data utama dibaca dari tab Google Sheet “Master Teacher”.')}<section class="card table-card"><div class="card-header"><div><h3>Daftar Master Teacher</h3><p>${state.teachers.length} akun terbaca dari Google Sheet</p></div><span class="page-intro-badge">SOURCE: GOOGLE SHEETS</span></div>${state.teachers.length ? `<div class="table-scroll"><table class="attendance-table"><thead><tr><th>ID MT</th><th>Nama Master Teacher</th><th>Cabang Utama</th><th>Status</th><th>Status PIN</th><th>Aksi</th></tr></thead><tbody>${state.teachers.map(teacher => `<tr><td><strong>${escapeHtml(teacher.id)}</strong></td><td><div class="teacher-cell"><span class="mini-avatar">${initials(teacher.name)}</span><div><strong>${escapeHtml(teacher.name)}</strong></div></div></td><td><div class="branch-cell"><strong>${escapeHtml(branchName(teacher.branchId))}</strong><small>${escapeHtml(teacher.branchId || '—')}</small></div></td><td>${teacher.status === 'active' ? '<span class="status-pill green">Aktif</span>' : `<span class="status-pill neutral">${escapeHtml(teacher.statusLabel || 'Nonaktif')}</span>`}</td><td>${teacher.pinConfigured ? '<span class="status-pill green">Sudah dibuat</span>' : '<span class="status-pill neutral">Belum dibuat</span>'}</td><td><button class="tiny-button approve" data-action="set-pin" data-teacher-id="${escapeHtml(teacher.id)}">${teacher.pinConfigured ? 'Reset PIN' : 'Buat PIN'}</button></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state"><strong>Belum ada data Master Teacher di Google Sheet</strong><span>Tambahkan baris pada tab “Master Teacher”, lalu muat ulang.</span></div>`}<div class="table-footer"><span>Identitas dan status berasal dari Google Sheet.</span><span>PIN hanya disimpan sebagai hash di backend lokal.</span></div></section>`;
  bindContentEvents();
}

async function renderBranches() {
  let payload;
  try {
    payload = await api('/api/branches?source=google');
  } catch (err) {
    showToast(`Google Sheets: ${err.message}`, 'error');
    $('#page-content').innerHTML = `${pageHeading('Cabang', 'Data utama dibaca dari Google Sheet.')}<section class="card"><div class="empty-state"><strong>Data Google Sheet tidak dapat dibaca</strong><span>${escapeHtml(err.message)}</span><button class="secondary-button" data-action="refresh-page">↻ Coba lagi</button></div></section>`;
    bindContentEvents();
    return;
  }
  state.branches = payload.branches || [];
  const branch = state.branches.find(item => item.id === state.config?.settings?.activeBranchId) || state.branches[0];
  if (!branch) { $('#page-content').innerHTML = `${pageHeading('Cabang', 'Data utama dibaca dari tab Google Sheet “Branches”.')}<section class="card"><div class="empty-state"><strong>Belum ada data cabang di Google Sheet</strong><span>Tambahkan baris pada tab “Branches”, lalu muat ulang.</span></div></section>`; bindContentEvents(); return; }
  $('#page-content').innerHTML = `${pageHeading('Cabang', 'Data utama dibaca dari tab Google Sheet “Branches”.')}<section class="card table-card"><div class="card-header"><div><h3>Daftar Cabang</h3><p>${state.branches.length} cabang terbaca dari Google Sheet</p></div><span class="page-intro-badge">SOURCE: GOOGLE SHEETS</span></div><div class="table-scroll"><table class="attendance-table"><thead><tr><th>ID Cabang</th><th>Nama Cabang</th><th>Alamat</th><th>Latitude</th><th>Longitude</th><th>Radius (Meter)</th><th>Status</th></tr></thead><tbody>${state.branches.map(item => `<tr><td><strong>${escapeHtml(item.id)}</strong></td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.address || '—')}</td><td class="distance">${item.latitude ?? (item.latitudeRaw ? '<span title="Isi dengan angka desimal GPS, misalnya -5.123456">Format tidak valid</span>' : '—')}</td><td class="distance">${item.longitude ?? (item.longitudeRaw ? '<span title="Isi dengan angka desimal GPS, misalnya 119.123456">Format tidak valid</span>' : '—')}</td><td class="distance">${item.radius ?? '—'}</td><td>${item.active ? '<span class="status-pill green">Aktif</span>' : `<span class="status-pill neutral">${escapeHtml(item.status || 'Nonaktif')}</span>`}</td></tr>`).join('')}</tbody></table></div><div class="table-footer"><span>Pengelolaan data dilakukan di Google Sheet.</span><span>QR payload: ${escapeHtml(branch.qrPayload || branch.id)}</span></div></section><section class="card qr-card"><h3>QR Code cabang aktif</h3><p>QR statis ini berisi identifier cabang dari Google Sheet.</p><div class="qr-canvas-wrap"><canvas id="branch-qr" width="160" height="160"></canvas><div id="qr-fallback" class="qr-fallback" hidden><span>${escapeHtml(branch.qrPayload || branch.id)}</span></div></div><div class="qr-payload">${escapeHtml(branch.qrPayload || branch.id)}</div><p class="qr-caption">Edit profil cabang langsung di tab “Branches”, lalu muat ulang aplikasi.</p><button class="secondary-button" data-action="print-qr">Cetak QR</button></section>`;
  drawQr(branch.qrPayload || branch.id);
  bindContentEvents();
}

function drawQr(payload) {
  const canvas = $('#branch-qr');
  if (window.QRCode && canvas) window.QRCode.toCanvas(canvas, payload, { width: 160, margin: 1, color: { dark: '#1d3557', light: '#ffffff' } }, error => { if (error) showQrFallback(); });
  else showQrFallback();
}

function showQrFallback() { $('#branch-qr')?.setAttribute('hidden', 'hidden'); $('#qr-fallback')?.removeAttribute('hidden'); }

async function saveBranch(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  data.active = form.elements.active.checked;
  for (const key of ['latitude', 'longitude', 'radius', 'nearRadius', 'outsideRadius']) if (data[key] !== '') data[key] = Number(data[key]);
  try { const result = await api(`/api/branches/${encodeURIComponent((state.branches.find(branch => branch.id === state.config.settings.activeBranchId) || state.branches[0]).id)}`, { method: 'PUT', body: JSON.stringify(data) }); state.branches = state.branches.map(branch => branch.id === result.branch.id ? result.branch : branch); showToast('Konfigurasi cabang berhasil disimpan.', 'success'); await loadBaseData(); renderBranches(); } catch (err) { showToast(err.message, 'error'); }
}

async function renderSettings() {
  const payload = await api('/api/devices').catch(err => { showToast(err.message, 'error'); return { devices: [] }; });
  state.devices = payload.devices || [];
  const canRefreshAppsScriptCache = Boolean(window.MTA_APPS_SCRIPT || window.MTA_API_BASE);
  const refreshCacheButton = canRefreshAppsScriptCache ? '<button class="tiny-button" data-action="refresh-master-cache">Refresh data</button>' : '';
  const pending = state.devices.filter(device => device.status === 'pending').length;
  const sheets = state.config?.sheetsEnabled;
  const sheetsTest = state.sheetsTest;
  const testStatus = sheetsTest?.success ? 'Connected' : sheetsTest ? 'Failed' : sheets ? 'Ready to test' : 'Belum diatur';
  const testTone = sheetsTest?.success ? '' : 'pending';
  const sheetRows = sheetsTest?.sheets ? Object.entries(sheetsTest.sheets).map(([name, info]) => `<div class="setting-row"><div><strong>${escapeHtml(name)}</strong><small>${info.rows} baris terbaca dari Google Sheets.</small></div><span class="setting-value">Connected</span></div>`).join('') : '';
  $('#page-content').innerHTML = [
    pageHeading('Pengaturan', 'Keamanan device binding dan status integrasi backend.'),
    pending ? `<div class="device-banner pending"><span class="banner-icon">⚠</span><div><strong>${pending} perangkat menunggu otorisasi</strong><span>Periksa identitas Master Teacher sebelum memberikan akses.</span></div></div>` : '',
    `<div class="settings-grid">
      <section class="card settings-card">
        <h3>Device binding</h3>
        <p>Otorisasi membantu menandai perangkat baru tanpa membuat akun terlalu kaku. Admin dapat reset kapan saja.</p>
        ${state.devices.length ? state.devices.map(device => `<div class="setting-row"><div><strong>${escapeHtml(device.teacherName)} · ${escapeHtml(device.mtId)}</strong><small>${escapeHtml(device.id)}<br>Terakhir terlihat: ${escapeHtml(device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString('id-ID') : '—')}</small></div><div class="device-actions">${device.status === 'pending' ? `<button class="tiny-button approve" data-device-action="authorize" data-device-id="${escapeHtml(device.id)}">Otorisasi</button>` : `<span class="setting-value">${device.status === 'approved' ? 'Disetujui' : 'Diblokir'}</span>`}${device.status !== 'pending' ? `<button class="tiny-button" data-device-action="reset" data-device-id="${escapeHtml(device.id)}">Reset</button>` : ''}${device.status !== 'blocked' ? `<button class="tiny-button danger" data-device-action="revoke" data-device-id="${escapeHtml(device.id)}">Cabut</button>` : ''}</div></div>`).join('') : `<div class="empty-state"><strong>Belum ada perangkat</strong><span>Device baru akan muncul setelah Master Teacher login.</span></div>`}
      </section>
      <section class="card settings-card">
        <div class="card-header" style="padding:0 0 15px;margin-bottom:17px"><div><h3>Google Sheets</h3><p>Read/write dijalankan di backend melalui Google Apps Script.</p></div><div class="device-actions">${refreshCacheButton}<button class="tiny-button approve" data-action="test-sheets">Uji koneksi</button></div></div>
        <div class="setting-row"><div><strong>Spreadsheet: Master Teacher Attendance</strong><small>${sheetsTest?.success ? `Terakhir diuji ${sheetsTest.elapsedMs} ms.` : 'Credential tidak pernah dikirim ke browser.'}</small></div><span class="setting-value ${testTone}">${testStatus}</span></div>
        ${sheetRows || `<div class="setting-row"><div><strong>Master Teacher</strong><small>GET /api/master-teachers · sumber Google Sheets setelah konfigurasi.</small></div><span class="setting-value ${testTone}">${sheetsTest?.success ? 'Connected' : '—'}</span></div><div class="setting-row"><div><strong>Branches</strong><small>GET /api/branches?source=google</small></div><span class="setting-value ${testTone}">${sheetsTest?.success ? 'Connected' : '—'}</span></div><div class="setting-row"><div><strong>Attendance</strong><small>GET /api/attendance?source=google · append backend</small></div><span class="setting-value ${testTone}">${sheetsTest?.success ? 'Connected' : '—'}</span></div>`}
        ${sheetsTest && !sheetsTest.success ? `<div class="device-banner pending" style="margin-top:15px;margin-bottom:0"><span class="banner-icon">⚠</span><div><strong>Google Sheets belum terhubung</strong><span>${escapeHtml(sheetsTest.message)}</span></div></div>` : ''}
        <div class="setting-row"><div><strong>Timezone server</strong><small>Waktu attendance selalu berasal dari server.</small></div><span class="setting-value">${escapeHtml(state.config?.settings?.timezone || '—')}</span></div>
        <div class="setting-row"><div><strong>Cabang aktif</strong><small>Konfigurasi pilot dari ACTIVE_BRANCH_ID.</small></div><span class="setting-value">${escapeHtml(state.config?.settings?.activeBranchId || '—')}</span></div>
      </section>
    </div>`,
  ].join('');
  bindContentEvents();
}

function bindContentEvents() {
  $$('#page-content [data-nav]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.nav)));
  $$('#page-content [data-action="go-scan"]').forEach(button => button.addEventListener('click', () => navigate('scan')));
  $$('#page-content [data-action="go-home"]').forEach(button => button.addEventListener('click', () => navigate('home')));
  $$('#page-content [data-action="refresh-page"]').forEach(button => button.addEventListener('click', () => navigate(state.page)));
  $$('#page-content [data-record-id]').forEach(element => element.addEventListener('click', event => { if (event.target.closest('button')?.dataset.action === 'refresh-page') return; const id = element.dataset.recordId; const record = [...(state.records || []), ...(state.dashboard?.rows || []).flatMap(row => [row.masuk, row.pulang].filter(Boolean))].find(item => item?.attendanceId === id); if (record) openRecordModal(record); }));
  $$('#page-content [data-action="add-teacher"]').forEach(button => button.addEventListener('click', () => openTeacherModal()));
  $$('#page-content [data-action="edit-teacher"]').forEach(button => button.addEventListener('click', () => openTeacherModal(state.teachers.find(teacher => teacher.id === button.dataset.teacherId))));
  $$('#page-content [data-action="set-pin"]').forEach(button => button.addEventListener('click', () => openPinModal(state.teachers.find(teacher => teacher.id === button.dataset.teacherId))));
  $$('#page-content [data-action="add-branch"]').forEach(button => button.addEventListener('click', () => openBranchModal()));
  $$('#page-content [data-action="print-qr"]').forEach(button => button.addEventListener('click', () => window.print()));
  $$('#page-content [data-device-action]').forEach(button => button.addEventListener('click', () => updateDevice(button.dataset.deviceId, button.dataset.deviceAction)));
  $$('#page-content [data-action="test-sheets"]').forEach(button => button.addEventListener('click', testSheetsConnection));
  $$('#page-content [data-action="refresh-master-cache"]').forEach(button => button.addEventListener('click', refreshMasterDataCache));
}

function openModal(content) {
  $('#modal-root').innerHTML = `<div class="modal-backdrop" data-close-modal><div class="modal" role="dialog" aria-modal="true">${content}</div></div>`;
  $('.modal-backdrop').addEventListener('click', event => { if (event.target.dataset.closeModal !== undefined) closeModal(); });
  $('.modal-close')?.addEventListener('click', closeModal);
}

function closeModal() { $('#modal-root').innerHTML = ''; }

function openPinModal(teacher) {
  if (!teacher) return;
  const action = teacher.pinConfigured ? 'Reset PIN' : 'Buat PIN';
  openModal(`<div class="modal-header"><div><h3>${action} Master Teacher</h3><p>${escapeHtml(teacher.name)} · ${escapeHtml(teacher.id)}</p></div><button class="modal-close">×</button></div><div class="modal-body"><form id="teacher-pin-form"><div class="form-grid"><div class="form-field"><label>PIN baru (6 digit)</label><input name="pin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="6" pattern="[0-9]{6}" required placeholder="Contoh: 482731" /></div><div class="form-field"><label>Konfirmasi PIN</label><input name="confirmation" type="password" inputmode="numeric" autocomplete="new-password" maxlength="6" pattern="[0-9]{6}" required placeholder="Ulangi PIN baru" /></div></div><p id="teacher-pin-status" class="form-status" hidden aria-live="polite"></p><p class="form-note">PIN tidak disimpan di Google Sheet dan tidak ditampilkan kembali setelah disimpan.</p><div class="form-actions"><button type="button" class="secondary-button modal-cancel">Batal</button><button type="submit" class="primary-button">${action}</button></div></form></div>`);
  $('.modal-cancel').addEventListener('click', closeModal);
  $('#teacher-pin-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (state.isSavingPin) return;
    const pinStartedAt = performance.now();
    perfLog('PIN_CREATE_START', pinStartedAt);
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (!/^\d{6}$/.test(data.pin)) return showToast('PIN harus terdiri dari tepat 6 digit.', 'error');
    if (data.pin !== data.confirmation) return showToast('Konfirmasi PIN tidak sama.', 'error');
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    const cancel = event.currentTarget.querySelector('.modal-cancel');
    const inputs = [...event.currentTarget.querySelectorAll('input')];
    const status = $('#teacher-pin-status');
    state.isSavingPin = true;
    submit.disabled = true;
    if (cancel) cancel.disabled = true;
    inputs.forEach(input => { input.disabled = true; });
    submit.textContent = `⏳ ${action}...`;
    if (status) { status.textContent = `Sedang ${action === 'Buat PIN' ? 'membuat' : 'mereset'} PIN Master Teacher... Mohon tunggu dan jangan tekan tombol kembali.`; status.className = 'form-status loading'; status.hidden = false; }
    try {
      await api(`/api/teachers/${encodeURIComponent(teacher.id)}/pin`, { method: 'POST', body: JSON.stringify({ pin: data.pin }) });
      perfLog('PIN_CREATE_RESPONSE', pinStartedAt);
      closeModal();
      showToast(action === 'Buat PIN' ? '✅ PIN berhasil dibuat.' : '✅ PIN berhasil direset.', 'success');
      perfLog('PIN_TEACHER_LIST_START', pinStartedAt);
      await renderTeachers();
      perfLog('PIN_TEACHER_LIST_END', pinStartedAt);
    } catch (err) {
      showToast(err.message, 'error');
      if (status) { status.textContent = '❌ PIN gagal disimpan. Silakan coba lagi.'; status.className = 'form-status error'; status.hidden = false; }
      submit.disabled = false;
      if (cancel) cancel.disabled = false;
      inputs.forEach(input => { input.disabled = false; });
      submit.textContent = action;
    } finally {
      state.isSavingPin = false;
    }
  });
}

function openRecordModal(record) {
  openModal(`<div class="modal-header"><div><h3>Detail absensi</h3><p>${escapeHtml(record.attendanceId)}</p></div><button class="modal-close">×</button></div><div class="modal-body"><div class="detail-grid"><div class="detail-item"><span>Master Teacher</span><strong>${escapeHtml(record.mtName)} · ${escapeHtml(record.mtId)}</strong></div><div class="detail-item"><span>Tanggal</span><strong>${humanDate(record.date)}</strong></div><div class="detail-item"><span>Cabang QR</span><strong>${escapeHtml(record.branchName)} · ${escapeHtml(record.branchId)}</strong></div><div class="detail-item"><span>Jenis / jam scan</span><strong>${escapeHtml(record.type)} · ${escapeHtml(displayAttendanceTime(record.time))}</strong></div><div class="detail-item"><span>Latitude</span><strong>${record.latitude}</strong></div><div class="detail-item"><span>Longitude</span><strong>${record.longitude}</strong></div><div class="detail-item"><span>Jarak dari cabang</span><strong>${formatDistance(record.distanceMeters)}</strong></div><div class="detail-item"><span>Status lokasi</span><strong>${statusPill(record, record.locationStatus)}</strong></div><div class="detail-item detail-full"><span>Device / session identifier</span><strong>${escapeHtml(record.deviceId || '—')}</strong></div></div></div><div class="modal-footer"><a class="maps-link" target="_blank" rel="noreferrer" href="https://www.google.com/maps?q=${encodeURIComponent(record.latitude)},${encodeURIComponent(record.longitude)}">Lihat Lokasi di Google Maps ↗</a></div>`);
}

function openTeacherModal(teacher = null) {
  const editing = Boolean(teacher);
  openModal(`<div class="modal-header"><div><h3>${editing ? 'Edit Master Teacher' : 'Tambah Master Teacher'}</h3><p>${editing ? 'Perbarui data akun tanpa mengubah riwayat absensi.' : 'PIN akan langsung di-hash di server.'}</p></div><button class="modal-close">×</button></div><div class="modal-body"><form id="teacher-modal-form"><div class="form-grid"><div class="form-field"><label>ID Master Teacher</label><input name="id" value="${escapeHtml(teacher?.id || '')}" ${editing ? 'disabled' : 'required'} placeholder="MT002" /></div><div class="form-field"><label>Nama</label><input name="name" value="${escapeHtml(teacher?.name || '')}" required /></div><div class="form-field"><label>Cabang utama</label><select name="branchId" required>${state.branches.map(branch => `<option value="${escapeHtml(branch.id)}" ${branch.id === teacher?.branchId ? 'selected' : ''}>${escapeHtml(branch.name)}</option>`).join('')}</select></div><div class="form-field"><label>PIN ${editing ? '(opsional)' : ''}</label><input name="pin" type="password" minlength="4" ${editing ? '' : 'required'} placeholder="Minimal 4 karakter" /></div>${editing ? `<div class="form-field"><label>Status</label><select name="status"><option value="active" ${teacher.status === 'active' ? 'selected' : ''}>Aktif</option><option value="inactive" ${teacher.status !== 'active' ? 'selected' : ''}>Nonaktif</option></select></div>` : ''}</div><div class="form-actions"><button type="button" class="secondary-button modal-cancel">Batal</button><button type="submit" class="primary-button">${editing ? 'Simpan perubahan' : 'Buat akun'}</button></div></form></div>`);
  $('.modal-cancel').addEventListener('click', closeModal);
  $('#teacher-modal-form').addEventListener('submit', async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (!data.pin) delete data.pin;
    try { await api(editing ? `/api/teachers/${encodeURIComponent(teacher.id)}` : '/api/teachers', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(data) }); closeModal(); showToast(editing ? 'Data Master Teacher diperbarui.' : 'Master Teacher berhasil ditambahkan.', 'success'); renderTeachers(); } catch (err) { showToast(err.message, 'error'); }
  });
}

function openBranchModal() {
  openModal(`<div class="modal-header"><div><h3>Tambah cabang</h3><p>Koordinat dapat dilengkapi setelah cabang dibuat.</p></div><button class="modal-close">×</button></div><div class="modal-body"><form id="branch-modal-form"><div class="form-grid"><div class="form-field"><label>ID Cabang</label><input name="id" required placeholder="CAB-JKT" /></div><div class="form-field"><label>Nama cabang</label><input name="name" required placeholder="Nama cabang" /></div><div class="form-field full"><label>Alamat</label><textarea name="address" placeholder="Alamat resmi cabang"></textarea></div><div class="form-field"><label>Radius (meter)</label><input name="radius" type="number" value="50" min="1" required /></div><div class="form-field"><label>QR payload</label><input name="qrPayload" placeholder="Otomatis mengikuti ID" /></div></div><div class="form-actions"><button type="button" class="secondary-button modal-cancel">Batal</button><button type="submit" class="primary-button">Tambah cabang</button></div></form></div>`);
  $('.modal-cancel').addEventListener('click', closeModal);
  $('#branch-modal-form').addEventListener('submit', async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget).entries()); try { await api('/api/branches', { method: 'POST', body: JSON.stringify(data) }); closeModal(); showToast('Cabang berhasil ditambahkan.', 'success'); renderBranches(); } catch (err) { showToast(err.message, 'error'); } });
}

async function updateDevice(id, action) {
  try { await api(`/api/devices/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ action }) }); showToast(action === 'authorize' ? 'Perangkat berhasil diotorisasi.' : action === 'reset' ? 'Perangkat di-reset dan menunggu otorisasi ulang.' : 'Perangkat dicabut.', action === 'revoke' ? '' : 'success'); renderSettings(); } catch (err) { showToast(err.message, 'error'); }
}

async function testSheetsConnection() {
  try {
    state.sheetsTest = await api('/api/google-sheets/test');
    showToast(state.sheetsTest.success ? 'Koneksi Google Sheets berhasil.' : state.sheetsTest.message, state.sheetsTest.success ? 'success' : 'error');
  } catch (err) {
    state.sheetsTest = { success: false, message: err.message };
    showToast(err.message, 'error');
  }
  await renderSettings();
}

async function refreshMasterDataCache() {
  const buttons = $$('#page-content [data-action="refresh-master-cache"]');
  buttons.forEach(button => { button.disabled = true; button.textContent = 'Memuat…'; });
  try {
    const result = await api('/api/cache/refresh', { method: 'POST' });
    showToast(`${result.message} ${result.teachers} MT · ${result.branches} cabang.`, 'success');
    await loadBaseData();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    await renderSettings();
  }
}

async function logout() {
  stopCamera();
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  clearRememberedSession();
  state.user = null;
  state.device = null;
  state.config = null;
  $('#app-shell').hidden = true;
  $('#login-screen').hidden = false;
  $('#login-form').reset();
  setLoginRole('teacher');
}

function init() {
  $$('.role-option').forEach(button => button.addEventListener('click', () => setLoginRole(button.dataset.loginRole)));
  $('#login-form').addEventListener('submit', login);
  $('.password-toggle').addEventListener('click', event => { const input = $('#login-pin'); input.type = input.type === 'password' ? 'text' : 'password'; event.currentTarget.textContent = input.type === 'password' ? 'Lihat' : 'Sembunyikan'; });
  $('#logout-button').addEventListener('click', logout);
  $('#mobile-menu-button').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  window.addEventListener('hashchange', () => { const page = location.hash.slice(1); if (state.user && page && pageNames[page]) navigate(page, true); });
  api('/api/me').then(async payload => { const resumeStartedAt = performance.now(); perfLog('SESSION_RESUME_START', resumeStartedAt); state.user = payload.user; state.device = payload.device; await enterApp(resumeStartedAt); }).catch(() => { clearRememberedSession(); });
}

// app.js is loaded dynamically by index.html. When the network is fast,
// DOMContentLoaded may already have fired before this file arrives.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
