const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
loadDotEnv();
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const PORT = Number(process.env.PORT || 3000);
const TIME_ZONE = process.env.APP_TIMEZONE || 'Asia/Makassar';
const ACTIVE_BRANCH_ID = process.env.ACTIVE_BRANCH_ID || 'CAB-HRT';
const SESSION_TTL = 8 * 60 * 60 * 1000;

const sessions = new Map();
const rateBuckets = new Map();
let store = loadStore();

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(pin), salt, 64);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

function verifyPin(pin, encoded) {
  try {
    const [algorithm, saltHex, hashHex] = String(encoded).split(':');
    if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;
    const derived = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 64);
    const expected = Buffer.from(hashHex, 'hex');
    return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function dateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, item) => {
    acc[item.type] = item.value;
    return acc;
  }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function today() {
  return dateParts().date;
}

function loadStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return {
        settings: parsed.settings || defaultSettings(),
        branches: Array.isArray(parsed.branches) ? parsed.branches : [],
        teachers: Array.isArray(parsed.teachers) ? parsed.teachers : [],
        admins: Array.isArray(parsed.admins) ? parsed.admins : [],
        attendance: Array.isArray(parsed.attendance) ? parsed.attendance : [],
        scanLogs: Array.isArray(parsed.scanLogs) ? parsed.scanLogs : [],
        devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      };
    } catch (error) {
      console.error('store.json tidak dapat dibaca:', error.message);
    }
  }
  const initial = {
    settings: defaultSettings(),
    branches: [{
      id: 'CAB-HRT',
      name: 'Hertasning',
      address: 'Konfigurasi alamat cabang belum diisi',
      latitude: null,
      longitude: null,
      radius: 50,
      nearRadius: 200,
      outsideRadius: 500,
      active: true,
      qrPayload: 'CAB-HRT',
      createdAt: nowIso(),
    }],
    teachers: [{
      id: 'MT001',
      name: 'Andi',
      branchId: 'CAB-HRT',
      pinHash: hashPin(process.env.SEED_MT_PIN || '1234'),
      status: 'active',
      createdAt: nowIso(),
    }],
    admins: [{
      id: 'admin',
      name: 'Admin Pilot',
      pinHash: hashPin(process.env.SEED_ADMIN_PIN || 'admin123'),
      status: 'active',
    }],
    attendance: [],
    scanLogs: [],
    devices: [],
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
  return initial;
}

function defaultSettings() {
  return {
    activeBranchId: ACTIVE_BRANCH_ID,
    timezone: TIME_ZONE,
    appName: 'Master Teacher Attendance',
  };
}

function persist() {
  const temporary = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2));
  fs.renameSync(temporary, DATA_FILE);
}

function safeUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, role: user.role, branchId: user.branchId, status: user.status };
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function error(res, status, message, code = 'BAD_REQUEST', details = undefined) {
  json(res, status, { ok: false, code, message, ...(details ? { details } : {}) });
}

function parseCookies(req) {
  return (req.headers.cookie || '').split(';').reduce((out, part) => {
    const index = part.indexOf('=');
    if (index === -1) return out;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return out;
  }, {});
}

function sessionFrom(req) {
  const token = parseCookies(req).session;
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL;
  return { token, ...session };
}

function setSession(res, session) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { ...session, expiresAt: Date.now() + SESSION_TTL });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}${secure}`);
}

function requireAuth(req, res, role = null) {
  const session = sessionFrom(req);
  if (!session) {
    error(res, 401, 'Sesi berakhir. Silakan login kembali.', 'UNAUTHORIZED');
    return null;
  }
  if (role && session.role !== role) {
    error(res, 403, 'Anda tidak memiliki akses ke halaman ini.', 'FORBIDDEN');
    return null;
  }
  return session;
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(new Error('Payload terlalu besar'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Format JSON tidak valid.')); }
    });
    req.on('error', reject);
  });
}

function findBranch(id) {
  return store.branches.find(branch => branch.id === id);
}

function findTeacher(id) {
  return store.teachers.find(teacher => teacher.id === id);
}

function haversineMeters(latitude1, longitude1, latitude2, longitude2) {
  const radians = value => value * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = radians(latitude2 - latitude1);
  const dLon = radians(longitude2 - longitude1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(latitude1)) * Math.cos(radians(latitude2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}

function locationStatus(distance, branch) {
  const radius = Number(branch.radius || 50);
  const nearRadius = Number(branch.nearRadius || 200);
  const outsideRadius = Number(branch.outsideRadius || 500);
  if (distance <= radius) return { key: 'area', label: 'Di Area Cabang', emoji: '●', tone: 'green' };
  if (distance <= nearRadius) return { key: 'near', label: 'Dekat Cabang', emoji: '●', tone: 'yellow' };
  if (distance <= outsideRadius) return { key: 'outside', label: 'Di Luar Area Cabang', emoji: '●', tone: 'orange' };
  return { key: 'far', label: 'Jauh dari Cabang', emoji: '●', tone: 'red' };
}

function validCoordinate(latitude, longitude) {
  return Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude)) && Number(latitude) >= -90 && Number(latitude) <= 90 && Number(longitude) >= -180 && Number(longitude) <= 180;
}

function checkRateLimit(key, max = 12, windowMs = 60_000) {
  const current = rateBuckets.get(key) || { startedAt: Date.now(), count: 0 };
  if (Date.now() - current.startedAt > windowMs) {
    current.startedAt = Date.now();
    current.count = 0;
  }
  current.count += 1;
  rateBuckets.set(key, current);
  return current.count <= max;
}

function deviceFor(mtId, deviceId) {
  return store.devices.find(device => device.mtId === mtId && device.id === deviceId);
}

function publicBranch(branch) {
  if (!branch) return null;
  return { ...branch, coordinatesConfigured: validCoordinate(branch.latitude, branch.longitude) };
}

function sortNewest(a, b) {
  return new Date(b.timestamp || b.createdAt).getTime() - new Date(a.timestamp || a.createdAt).getTime();
}

function dashboardData(date = today()) {
  const activeTeachers = store.teachers.filter(teacher => teacher.status === 'active');
  const records = store.attendance.filter(record => record.date === date);
  const rows = activeTeachers.map(teacher => {
    const teacherRecords = records.filter(record => record.mtId === teacher.id).sort(sortNewest);
    const masuk = teacherRecords.find(record => record.type === 'MASUK');
    const pulang = teacherRecords.find(record => record.type === 'PULANG');
    const branch = findBranch((masuk || pulang || {}).branchId || teacher.branchId);
    return { teacher: safeTeacher(teacher), branch: publicBranch(branch), masuk: masuk || null, pulang: pulang || null };
  });
  return {
    date,
    metrics: {
      total: activeTeachers.length,
      masuk: rows.filter(row => row.masuk).length,
      belumMasuk: rows.filter(row => !row.masuk).length,
      pulang: rows.filter(row => row.pulang).length,
      outside: records.filter(record => ['outside', 'far'].includes(record.locationKey)).length,
      newDevices: store.devices.filter(device => device.status === 'pending').length,
    },
    rows,
    recentActivity: store.scanLogs.filter(log => log.date === date).sort(sortNewest).slice(0, 8),
  };
}

function safeTeacher(teacher) {
  if (!teacher) return null;
  return { id: teacher.id, name: teacher.name, branchId: teacher.branchId, status: teacher.status, createdAt: teacher.createdAt };
}

function googleServiceAccount() {
  const source = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (source) {
    try {
      const raw = source.trim().startsWith('{') ? source : fs.readFileSync(path.resolve(ROOT, source), 'utf8');
      const parsed = JSON.parse(raw);
      return { client_email: parsed.client_email, private_key: parsed.private_key };
    } catch (error) {
      console.error('Google service account tidak dapat dibaca:', error.message);
    }
  }
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  return email && privateKey ? { client_email: email, private_key: privateKey } : null;
}

function googleSpreadsheetId() {
  return process.env.GOOGLE_SPREADSHEET_ID || process.env.GOOGLE_SHEETS_ID || '';
}

function googleAppsScriptConfigured() {
  return Boolean(process.env.GOOGLE_APPS_SCRIPT_URL);
}

function base64url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function httpsJson(options, payload) {
  return new Promise((resolve, reject) => {
    const request = https.request(options, response => {
      let chunks = '';
      response.on('data', chunk => { chunks += chunk; });
      response.on('end', () => {
        let parsed;
        try { parsed = chunks ? JSON.parse(chunks) : {}; } catch { parsed = { raw: chunks }; }
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(parsed);
        else reject(new Error(`HTTP ${response.statusCode}: ${parsed.error_description || parsed.error?.message || chunks}`));
      });
    });
    request.on('error', reject);
    if (payload) request.write(JSON.stringify(payload));
    request.end();
  });
}

function httpsForm(options, formData) {
  return new Promise((resolve, reject) => {
    const encoded = new URLSearchParams(formData).toString();
    const request = https.request({ ...options, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(encoded), ...(options.headers || {}) } }, response => {
      let chunks = '';
      response.on('data', chunk => { chunks += chunk; });
      response.on('end', () => {
        let parsed;
        try { parsed = chunks ? JSON.parse(chunks) : {}; } catch { parsed = { raw: chunks }; }
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(parsed);
        else reject(new Error(`HTTP ${response.statusCode}: ${parsed.error_description || chunks}`));
      });
    });
    request.on('error', reject);
    request.write(encoded);
    request.end();
  });
}

async function googleAccessToken(account) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = signer.sign(account.private_key, 'base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const token = await httpsForm({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
  }, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${signature}` });
  return token.access_token;
}

async function syncAttendanceToSheets(record) {
  if (googleAppsScriptConfigured()) {
    await appsScriptRequest({ action: 'appendAttendance', values: [[record.attendanceId, record.date, record.mtId, record.mtName, record.branchId, record.branchName, record.type, record.timestamp, record.time, record.latitude, record.longitude, record.distanceMeters, record.locationStatus, record.deviceId, record.createdAt]] });
    return { enabled: true, provider: 'google-apps-script' };
  }
  const spreadsheetId = googleSpreadsheetId();
  const account = googleServiceAccount();
  if (!spreadsheetId || !account) return { enabled: false };
  const tab = process.env.GOOGLE_SHEETS_TAB || 'Attendance';
  const token = await googleAccessToken(account);
  const values = [[record.attendanceId, record.date, record.mtId, record.mtName, record.branchId, record.branchName, record.type, record.timestamp, record.time, record.latitude, record.longitude, record.distanceMeters, record.locationStatus, record.deviceId, record.createdAt]];
  await httpsJson({
    hostname: 'sheets.googleapis.com',
    path: `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(tab)}!A:O:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }, { values });
  return { enabled: true };
}

async function appsScriptRequest(payload) {
  const endpoint = process.env.GOOGLE_APPS_SCRIPT_URL;
  const token = process.env.GOOGLE_APPS_SCRIPT_TOKEN;
  if (!endpoint) throw Object.assign(new Error('Google Apps Script belum terhubung. Periksa GOOGLE_APPS_SCRIPT_URL.'), { code: 'GOOGLE_CONFIG_MISSING' });
  const requestBody = token ? { ...payload, token } : payload;
  if (!token) {
    const url = new URL(endpoint);
    url.searchParams.set('action', String(payload.action || ''));
    if (payload.tabs) url.searchParams.set('tabs', JSON.stringify(payload.tabs));
    if (payload.values) url.searchParams.set('values', JSON.stringify(payload.values));
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      if (error.name === 'TimeoutError') throw Object.assign(new Error('Google Apps Script tidak merespons dalam 10 detik. Periksa deployment dan koneksi internet.'), { code: 'GOOGLE_TIMEOUT' });
      throw error;
    }
    let result;
    try { result = await response.json(); } catch { throw Object.assign(new Error('Respons Google Apps Script tidak valid.'), { code: 'GOOGLE_BRIDGE_INVALID_RESPONSE' }); }
    return validateAppsScriptResult(result, payload, response.status, response.ok);
  }
  const body = JSON.stringify(requestBody);
  const request = url => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  let response = await request(endpoint);
  // Apps Script redirects POST requests to script.googleusercontent.com. Follow
  // that redirect manually so the request remains POST instead of becoming GET.
  for (let attempt = 0; response.status >= 300 && response.status < 400 && attempt < 3; attempt += 1) {
    const location = response.headers.get('location');
    if (!location) break;
    response = await request(new URL(location, endpoint).toString());
  }
  let result;
  try { result = await response.json(); } catch { throw Object.assign(new Error('Respons Google Apps Script tidak valid.'), { code: 'GOOGLE_BRIDGE_INVALID_RESPONSE' }); }
  return validateAppsScriptResult(result, payload, response.status, response.ok);
}

function validateAppsScriptResult(result, payload, status, responseOk) {
  if (!responseOk || result.success === false) {
    const message = result.message || `Google Apps Script mengembalikan HTTP ${status}.`;
    throw Object.assign(new Error(message), { code: result.code || 'GOOGLE_BRIDGE_FAILED' });
  }
  if (payload.action === 'read' && (!result.values || typeof result.values !== 'object')) {
    throw Object.assign(new Error('Google Apps Script belum menjalankan bridge versi terbaru. Deploy ulang Code.gs.'), { code: 'GOOGLE_BRIDGE_OUTDATED' });
  }
  if (payload.action === 'test' && (!result.sheets || typeof result.sheets !== 'object')) {
    throw Object.assign(new Error('Google Apps Script belum menjalankan bridge versi terbaru. Deploy ulang Code.gs.'), { code: 'GOOGLE_BRIDGE_OUTDATED' });
  }
  if (payload.action === 'appendAttendance' && result.rowsAppended !== 1) {
    throw Object.assign(new Error('Google Apps Script tidak mengonfirmasi penambahan data Attendance.'), { code: 'GOOGLE_BRIDGE_INVALID_RESPONSE' });
  }
  return result;
}

function sheetColumn(row, headers, names) {
  const index = headers.findIndex(header => names.includes(String(header).trim().toLowerCase()));
  return index === -1 ? '' : row[index] ?? '';
}

function sheetRowsToObjects(values = []) {
  if (!values.length) return [];
  const headers = values[0].map(value => String(value).trim());
  return values.slice(1).filter(row => row.some(value => String(value ?? '').trim())).map(row => ({ headers, row }));
}

function parseMasterTeachers(values) {
  return sheetRowsToObjects(values).map(({ headers, row }) => {
    const rawStatus = String(sheetColumn(row, headers, ['status'])).trim();
    return {
      id: String(sheetColumn(row, headers, ['id mt', 'id master teacher', 'id'])).trim(),
      name: String(sheetColumn(row, headers, ['nama master teacher', 'nama', 'name'])).trim(),
      branchId: String(sheetColumn(row, headers, ['cabang utama', 'id cabang', 'branch id', 'branchid'])).trim(),
      status: ['aktif', 'active', 'true', '1'].includes(rawStatus.toLowerCase()) ? 'active' : 'inactive',
      statusLabel: rawStatus || '—',
      createdAt: String(sheetColumn(row, headers, ['created at', 'dibuat', 'created'])).trim(),
    };
  }).filter(item => item.id);
}

function parseBranches(values) {
  return sheetRowsToObjects(values).map(({ headers, row }) => {
    const latitudeRaw = String(sheetColumn(row, headers, ['latitude'])).trim();
    const longitudeRaw = String(sheetColumn(row, headers, ['longitude'])).trim();
    const latitude = parseCoordinate(latitudeRaw);
    const longitude = parseCoordinate(longitudeRaw);
    const radius = sheetColumn(row, headers, ['radius (meter)', 'radius', 'radius meter']);
    const status = String(sheetColumn(row, headers, ['status'])).trim();
    return {
      id: String(sheetColumn(row, headers, ['id cabang', 'branch id', 'id'])).trim(),
      name: String(sheetColumn(row, headers, ['nama cabang', 'nama', 'name'])).trim(),
      address: String(sheetColumn(row, headers, ['alamat', 'address'])).trim(),
      latitude,
      longitude,
      latitudeRaw,
      longitudeRaw,
      radius: radius === '' ? 50 : Number(radius),
      nearRadius: 200,
      outsideRadius: 500,
      active: ['aktif', 'active', 'true', '1'].includes(status.toLowerCase()),
      status,
      qrPayload: String(sheetColumn(row, headers, ['qr payload', 'payload'])).trim() || String(sheetColumn(row, headers, ['id cabang', 'branch id', 'id'])).trim(),
    };
  }).filter(item => item.id);
}

function parseCoordinate(value) {
  if (!value) return null;
  const normalized = value.replace(',', '.');
  if (!/^-?(?:\d+)(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) && Math.abs(number) <= 180 ? number : null;
}

function parseAttendance(values) {
  return sheetRowsToObjects(values).map(({ headers, row }) => {
    const status = String(sheetColumn(row, headers, ['status lokasi', 'status'])).trim();
    const distance = sheetColumn(row, headers, ['jarak (meter)', 'jarak', 'distance']);
    const type = String(sheetColumn(row, headers, ['jenis absensi', 'jenis', 'type'])).trim();
    return {
      attendanceId: String(sheetColumn(row, headers, ['id absensi', 'attendance id', 'id'])).trim(),
      date: String(sheetColumn(row, headers, ['tanggal', 'date'])).trim(),
      mtId: String(sheetColumn(row, headers, ['id mt', 'id master teacher'])).trim(),
      mtName: String(sheetColumn(row, headers, ['nama master teacher', 'nama'])).trim(),
      branchId: String(sheetColumn(row, headers, ['id cabang', 'branch id'])).trim(),
      branchName: String(sheetColumn(row, headers, ['nama cabang', 'cabang'])).trim(),
      type,
      timestamp: String(sheetColumn(row, headers, ['timestamp'])).trim(),
      time: String(sheetColumn(row, headers, ['jam', 'time'])).trim(),
      latitude: sheetColumn(row, headers, ['latitude']) === '' ? null : Number(sheetColumn(row, headers, ['latitude'])),
      longitude: sheetColumn(row, headers, ['longitude']) === '' ? null : Number(sheetColumn(row, headers, ['longitude'])),
      distanceMeters: distance === '' ? null : Number(distance),
      locationStatus: status,
      deviceId: String(sheetColumn(row, headers, ['device id', 'deviceid'])).trim(),
      createdAt: String(sheetColumn(row, headers, ['created at'])).trim(),
    };
  }).filter(item => item.attendanceId);
}

async function googleGet(pathname, token) {
  return httpsJson({ hostname: 'sheets.googleapis.com', path: pathname, method: 'GET', headers: { Authorization: `Bearer ${token}` } });
}

async function readGoogleSheets(tabs = ['Master Teacher', 'Branches', 'Attendance']) {
  if (googleAppsScriptConfigured()) {
    const response = await appsScriptRequest({ action: 'read', tabs });
    return { spreadsheetId: response.spreadsheetId || 'configured-in-apps-script', values: response.values || {} };
  }
  const spreadsheetId = googleSpreadsheetId();
  const account = googleServiceAccount();
  if (!spreadsheetId || !account) throw Object.assign(new Error('Google Sheets belum terhubung. Atur Google Apps Script atau konfigurasi Google Sheets API.'), { code: 'GOOGLE_CONFIG_MISSING' });
  const token = await googleAccessToken(account);
  const result = {};
  for (const tab of tabs) {
    try {
      const encodedTab = encodeURIComponent(tab);
      const response = await googleGet(`/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodedTab}?majorDimension=ROWS`, token);
      result[tab] = response.values || [];
    } catch (error) {
      if (/404/.test(error.message)) throw Object.assign(new Error(`Sheet "${tab}" tidak ditemukan.`), { code: 'GOOGLE_SHEET_NOT_FOUND', tab });
      throw error;
    }
  }
  return { spreadsheetId, values: result };
}

async function testGoogleSheets() {
  const startedAt = Date.now();
  try {
    const sheets = await readGoogleSheets();
    const masterTeachers = parseMasterTeachers(sheets.values['Master Teacher']);
    const branches = parseBranches(sheets.values.Branches);
    const attendance = parseAttendance(sheets.values.Attendance);
    return { success: true, message: 'Google Sheets connection successful', spreadsheet: { id: sheets.spreadsheetId, name: 'Master Teacher Attendance' }, sheets: { 'Master Teacher': { connected: true, rows: masterTeachers.length }, Branches: { connected: true, rows: branches.length }, Attendance: { connected: true, rows: attendance.length } }, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { success: false, message: error.message || 'Google Sheets tidak dapat diakses.', code: error.code || 'GOOGLE_CONNECTION_FAILED', sheet: error.tab, elapsedMs: Date.now() - startedAt };
  }
}

async function handleApi(req, res, pathname, query) {
  if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, app: 'Master Teacher Attendance', serverTime: nowIso() });

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (!checkRateLimit(`login:${req.socket.remoteAddress}`, 15)) return error(res, 429, 'Terlalu banyak percobaan login. Coba lagi beberapa saat.', 'RATE_LIMITED');
    let input;
    try { input = await body(req); } catch (err) { return error(res, 400, err.message, 'INVALID_JSON'); }
    const role = input.role === 'admin' ? 'admin' : 'teacher';
    const identifier = String(input.id || '').trim().toUpperCase();
    const pin = String(input.pin || '');
    const deviceId = String(input.deviceId || '').trim().slice(0, 120);
    const account = role === 'admin' ? store.admins.find(item => item.id.toUpperCase() === identifier) : findTeacher(identifier);
    if (!account || account.status !== 'active' || !verifyPin(pin, account.pinHash)) return error(res, 401, 'ID atau PIN tidak cocok.', 'INVALID_CREDENTIALS');
    let device = null;
    if (role === 'teacher') {
      if (!deviceId) return error(res, 400, 'Perangkat tidak dapat diidentifikasi.', 'DEVICE_REQUIRED');
      device = deviceFor(account.id, deviceId);
      if (!device) {
        device = { id: deviceId, mtId: account.id, status: 'pending', createdAt: nowIso(), lastSeenAt: nowIso(), userAgent: req.headers['user-agent'] || '' };
        store.devices.push(device);
      } else {
        device.lastSeenAt = nowIso();
      }
      persist();
    }
    setSession(res, { userId: account.id, role, name: account.name, branchId: account.branchId, deviceId: deviceId || null });
    return json(res, 200, { ok: true, user: { id: account.id, name: account.name, role, branchId: account.branchId || null }, device: device ? { id: device.id, status: device.status, isNew: device.status === 'pending' } : null, serverTime: nowIso() });
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = parseCookies(req).session;
    if (token) sessions.delete(token);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  const session = sessionFrom(req);
  if (pathname === '/api/me' && req.method === 'GET') {
    if (!session) return error(res, 401, 'Belum login.', 'UNAUTHORIZED');
    const teacher = session.role === 'teacher' ? findTeacher(session.userId) : null;
    const device = session.role === 'teacher' ? deviceFor(session.userId, session.deviceId) : null;
    return json(res, 200, { ok: true, user: safeUser({ id: session.userId, name: session.name, role: session.role, branchId: session.branchId, status: 'active' }), device: device ? { id: device.id, status: device.status } : null, teacher: teacher ? safeTeacher(teacher) : null });
  }
  if (!session) return error(res, 401, 'Belum login.', 'UNAUTHORIZED');

  if (pathname === '/api/config' && req.method === 'GET') {
    const branch = findBranch(store.settings.activeBranchId);
    const provider = googleAppsScriptConfigured() ? 'google-apps-script' : (googleSpreadsheetId() && googleServiceAccount() ? 'google-sheets-api' : 'not-configured');
    return json(res, 200, { ok: true, settings: store.settings, branch: publicBranch(branch), sheetsEnabled: provider !== 'not-configured', sheetsProvider: provider, spreadsheetIdConfigured: Boolean(googleSpreadsheetId()), serverTime: nowIso() });
  }

  if (pathname === '/api/google-sheets/test' && req.method === 'GET') {
    if (session.role !== 'admin') return error(res, 403, 'Khusus Admin.', 'FORBIDDEN');
    return json(res, 200, await testGoogleSheets());
  }

  if (pathname === '/api/master-teachers' && req.method === 'GET') {
    if (session.role !== 'admin') return error(res, 403, 'Khusus Admin.', 'FORBIDDEN');
    try {
      const sheets = await readGoogleSheets(['Master Teacher']);
      return json(res, 200, { ok: true, source: 'google-sheets', teachers: parseMasterTeachers(sheets.values['Master Teacher']) });
    } catch (err) {
      return error(res, 503, err.message, err.code || 'GOOGLE_CONNECTION_FAILED');
    }
  }

  if (pathname === '/api/branches' && req.method === 'GET') {
    if (query.get('source') === 'google') {
      if (session?.role !== 'admin') return error(res, 403, 'Khusus Admin.', 'FORBIDDEN');
      try {
        const sheets = await readGoogleSheets(['Branches']);
        return json(res, 200, { ok: true, source: 'google-sheets', branches: parseBranches(sheets.values.Branches) });
      } catch (err) {
        return error(res, 503, err.message, err.code || 'GOOGLE_CONNECTION_FAILED');
      }
    }
    const branches = session.role === 'admin' ? store.branches : store.branches.filter(branch => branch.active);
    return json(res, 200, { ok: true, branches: branches.map(publicBranch) });
  }

  if (pathname === '/api/dashboard' && req.method === 'GET') {
    if (session.role !== 'admin') return error(res, 403, 'Khusus Admin.', 'FORBIDDEN');
    return json(res, 200, { ok: true, ...dashboardData(query.get('date') || today()) });
  }

  if (pathname === '/api/attendance' && req.method === 'GET') {
    if (session.role !== 'admin') return error(res, 403, 'Khusus Admin.', 'FORBIDDEN');
    if (query.get('source') === 'google') {
      try {
        const sheets = await readGoogleSheets(['Attendance']);
        return json(res, 200, { ok: true, source: 'google-sheets', records: parseAttendance(sheets.values.Attendance) });
      } catch (err) {
        return error(res, 503, err.message, err.code || 'GOOGLE_CONNECTION_FAILED');
      }
    }
    let records = [...store.attendance];
    if (query.get('date')) records = records.filter(record => record.date === query.get('date'));
    if (query.get('mtId')) records = records.filter(record => record.mtId === query.get('mtId'));
    if (query.get('branchId')) records = records.filter(record => record.branchId === query.get('branchId'));
    if (query.get('locationKey')) records = records.filter(record => record.locationKey === query.get('locationKey'));
    return json(res, 200, { ok: true, records: records.sort(sortNewest), logs: store.scanLogs.filter(log => !query.get('date') || log.date === query.get('date')).sort(sortNewest).slice(0, 100) });
  }

  if (pathname === '/api/attendance' && req.method === 'POST') {
    if (session.role !== 'admin') return error(res, 403, 'Khusus Admin.', 'FORBIDDEN');
    let input;
    try { input = await body(req); } catch (err) { return error(res, 400, err.message, 'INVALID_JSON'); }
    const teacher = findTeacher(String(input.mtId || '').trim().toUpperCase());
    const branch = findBranch(String(input.branchId || '').trim().toUpperCase());
    if (!teacher || !branch) return error(res, 400, 'ID Master Teacher dan ID Cabang harus terdaftar.', 'INVALID_ATTENDANCE');
    const stamp = dateParts();
    const record = {
      attendanceId: String(input.attendanceId || `ATT-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`),
      date: stamp.date,
      mtId: teacher.id,
      mtName: teacher.name,
      branchId: branch.id,
      branchName: branch.name,
      type: String(input.type || 'TEST').toUpperCase().slice(0, 20),
      timestamp: nowIso(),
      time: stamp.time,
      latitude: validCoordinate(input.latitude, input.longitude) ? Number(input.latitude) : null,
      longitude: validCoordinate(input.latitude, input.longitude) ? Number(input.longitude) : null,
      distanceMeters: Number.isFinite(Number(input.distanceMeters)) ? Number(input.distanceMeters) : null,
      locationKey: String(input.locationKey || 'neutral'),
      locationStatus: String(input.locationStatus || 'TEST'),
      deviceId: String(input.deviceId || 'ADMIN-TEST').slice(0, 120),
      createdAt: nowIso(),
    };
    try {
      await syncAttendanceToSheets(record);
      return json(res, 201, { ok: true, source: 'google-sheets', record });
    } catch (err) {
      return error(res, 503, `Google Sheets gagal menulis data: ${err.message}`, 'GOOGLE_WRITE_FAILED');
    }
  }

  if (pathname === '/api/my-attendance' && req.method === 'GET') {
    if (session.role !== 'teacher') return error(res, 403, 'Khusus Master Teacher.', 'FORBIDDEN');
    const date = query.get('date') || today();
    return json(res, 200, { ok: true, date, records: store.attendance.filter(record => record.mtId === session.userId && record.date === date).sort(sortNewest), history: store.attendance.filter(record => record.mtId === session.userId).sort(sortNewest).slice(0, 60), logs: store.scanLogs.filter(log => log.mtId === session.userId).sort(sortNewest).slice(0, 60) });
  }

  if (pathname === '/api/attendance/scan' && req.method === 'POST') {
    if (session.role !== 'teacher') return error(res, 403, 'Hanya Master Teacher yang dapat melakukan scan.', 'FORBIDDEN');
    if (!checkRateLimit(`scan:${session.userId}:${session.deviceId}`, 8)) return error(res, 429, 'Terlalu banyak percobaan scan. Tunggu sebentar lalu coba lagi.', 'RATE_LIMITED');
    let input;
    try { input = await body(req); } catch (err) { return error(res, 400, err.message, 'INVALID_JSON'); }
    const teacher = findTeacher(session.userId);
    if (!teacher || teacher.status !== 'active') return error(res, 403, 'Akun Master Teacher tidak aktif.', 'TEACHER_INACTIVE');
    const device = deviceFor(teacher.id, session.deviceId);
    if (!device || device.status !== 'approved') return error(res, 403, 'Perangkat ini belum diotorisasi Admin.', 'DEVICE_PENDING', { deviceId: session.deviceId });
    const branchId = String(input.branchId || input.payload || '').trim().toUpperCase();
    const branch = findBranch(branchId);
    if (!branch) return error(res, 400, 'QR tidak valid atau cabang tidak ditemukan.', 'INVALID_QR');
    if (!branch.active) return error(res, 400, 'Cabang ini sedang tidak aktif.', 'BRANCH_INACTIVE');
    if (!validCoordinate(branch.latitude, branch.longitude)) return error(res, 409, 'Koordinat cabang belum dikonfigurasi Admin.', 'BRANCH_COORDINATES_MISSING');
    if (!validCoordinate(input.latitude, input.longitude)) return error(res, 400, 'GPS tidak tersedia atau koordinat tidak valid. Aktifkan lokasi lalu coba lagi.', 'GPS_INVALID');
    const latitude = Number(input.latitude);
    const longitude = Number(input.longitude);
    const distanceMeters = Math.round(haversineMeters(latitude, longitude, Number(branch.latitude), Number(branch.longitude)) * 10) / 10;
    const status = locationStatus(distanceMeters, branch);
    const stamp = dateParts();
    const dayRecords = store.attendance.filter(record => record.mtId === teacher.id && record.date === stamp.date).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    if (dayRecords.length >= 2) {
      const completeLog = { logId: crypto.randomUUID(), date: stamp.date, time: stamp.time, timestamp: nowIso(), mtId: teacher.id, mtName: teacher.name, branchId: branch.id, branchName: branch.name, result: 'complete', message: 'Absensi hari ini sudah lengkap.', deviceId: session.deviceId, latitude, longitude, distanceMeters, locationKey: status.key, locationStatus: status.label, createdAt: nowIso() };
      store.scanLogs.push(completeLog);
      persist();
      return json(res, 200, { ok: true, complete: true, message: 'Absensi hari ini sudah lengkap.', log: completeLog });
    }
    const type = dayRecords.length === 0 ? 'MASUK' : 'PULANG';
    const record = {
      attendanceId: `ATT-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      date: stamp.date,
      mtId: teacher.id,
      mtName: teacher.name,
      branchId: branch.id,
      branchName: branch.name,
      type,
      timestamp: nowIso(),
      time: stamp.time,
      latitude,
      longitude,
      distanceMeters,
      locationKey: status.key,
      locationStatus: status.label,
      deviceId: session.deviceId,
      createdAt: nowIso(),
    };
    store.attendance.push(record);
    store.scanLogs.push({ ...record, logId: crypto.randomUUID(), result: 'recorded' });
    persist();
    syncAttendanceToSheets(record).catch(sheetError => console.error('Google Sheets sync gagal:', sheetError.message));
    return json(res, 201, { ok: true, complete: false, record, warning: status.key === 'far' ? 'Absensi tetap tercatat. Lokasi scan berada jauh dari titik cabang.' : null });
  }

  if (pathname === '/api/teachers' && req.method === 'GET') {
    if (session.role !== 'admin') return error(res, 403, 'Khusus Admin.', 'FORBIDDEN');
    return json(res, 200, { ok: true, teachers: store.teachers.map(safeTeacher) });
  }

  if (pathname === '/api/teachers' && req.method === 'POST') {
    if (session.role !== 'admin') return error(res, 403, 'Khusus Admin.', 'FORBIDDEN');
    let input;
    try { input = await body(req); } catch (err) { return error(res, 400, err.message, 'INVALID_JSON'); }
    const id = String(input.id || '').trim().toUpperCase();
    const name = String(input.name || '').trim();
    const pin = String(input.pin || '');
    if (!/^[A-Z0-9_-]{3,30}$/.test(id) || !name || pin.length < 4 || !findBranch(input.branchId)) return error(res, 400, 'ID, nama, PIN minimal 4 digit, dan cabang wajib valid.', 'INVALID_TEACHER');
    if (findTeacher(id)) return error(res, 409, 'ID Master Teacher sudah digunakan.', 'DUPLICATE_ID');
    store.teachers.push({ id, name, branchId: String(input.branchId), pinHash: hashPin(pin), status: 'active', createdAt: nowIso() });
    persist();
    return json(res, 201, { ok: true, teacher: safeTeacher(findTeacher(id)) });
  }

  const teacherMatch = pathname.match(/^\/api\/teachers\/([^/]+)$/);
  if (teacherMatch && req.method === 'PUT') {
    if (session.role !== 'admin') return error(res, 403, 'Khusus Admin.', 'FORBIDDEN');
    const teacher = findTeacher(decodeURIComponent(teacherMatch[1]));
    if (!teacher) return error(res, 404, 'Master Teacher tidak ditemukan.', 'NOT_FOUND');
    let input;
    try { input = await body(req); } catch (err) { return error(res, 400, err.message, 'INVALID_JSON'); }
    if (input.name !== undefined) teacher.name = String(input.name).trim();
    if (input.branchId !== undefined && !findBranch(input.branchId)) return error(res, 400, 'Cabang tidak valid.', 'INVALID_BRANCH');
    if (input.branchId !== undefined) teacher.branchId = String(input.branchId);
    if (input.status !== undefined) teacher.status = input.status === 'active' ? 'active' : 'inactive';
    if (input.pin) teacher.pinHash = hashPin(String(input.pin));
    persist();
    return json(res, 200, { ok: true, teacher: safeTeacher(teacher) });
  }

  if (pathname === '/api/devices' && req.method === 'GET') {
    if (session.role !== 'admin') return error(res, 403, 'Khusus Admin.', 'FORBIDDEN');
    return json(res, 200, { ok: true, devices: store.devices.map(device => ({ ...device, teacherName: findTeacher(device.mtId)?.name || device.mtId })) });
  }

  const deviceMatch = pathname.match(/^\/api\/devices\/([^/]+)$/);
  if (deviceMatch && req.method === 'POST') {
    if (session.role !== 'admin') return error(res, 403, 'Khusus Admin.', 'FORBIDDEN');
    const device = store.devices.find(item => item.id === decodeURIComponent(deviceMatch[1]));
    if (!device) return error(res, 404, 'Perangkat tidak ditemukan.', 'NOT_FOUND');
    let input;
    try { input = await body(req); } catch (err) { return error(res, 400, err.message, 'INVALID_JSON'); }
    if (input.action === 'authorize') device.status = 'approved';
    else if (input.action === 'reset') device.status = 'pending';
    else if (input.action === 'revoke') device.status = 'blocked';
    else return error(res, 400, 'Aksi perangkat tidak valid.', 'INVALID_ACTION');
    device.updatedAt = nowIso();
    persist();
    return json(res, 200, { ok: true, device });
  }

  if (pathname === '/api/branches' && req.method === 'POST') {
    if (session.role !== 'admin') return error(res, 403, 'Khusus Admin.', 'FORBIDDEN');
    let input;
    try { input = await body(req); } catch (err) { return error(res, 400, err.message, 'INVALID_JSON'); }
    const id = String(input.id || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,40}$/.test(id) || findBranch(id)) return error(res, 400, 'ID cabang tidak valid atau sudah digunakan.', 'INVALID_BRANCH');
    const branch = normalizeBranch({ ...input, id, qrPayload: id, createdAt: nowIso(), active: input.active !== false });
    store.branches.push(branch);
    persist();
    return json(res, 201, { ok: true, branch: publicBranch(branch) });
  }

  const branchMatch = pathname.match(/^\/api\/branches\/([^/]+)$/);
  if (branchMatch && req.method === 'PUT') {
    if (session.role !== 'admin') return error(res, 403, 'Khusus Admin.', 'FORBIDDEN');
    const branch = findBranch(decodeURIComponent(branchMatch[1]));
    if (!branch) return error(res, 404, 'Cabang tidak ditemukan.', 'NOT_FOUND');
    let input;
    try { input = await body(req); } catch (err) { return error(res, 400, err.message, 'INVALID_JSON'); }
    if (input.latitude !== undefined && input.latitude !== '' && !validCoordinate(input.latitude, input.longitude === undefined ? branch.longitude : input.longitude)) return error(res, 400, 'Latitude/longitude cabang tidak valid.', 'INVALID_COORDINATES');
    if (input.longitude !== undefined && input.longitude !== '' && !validCoordinate(input.latitude === undefined ? branch.latitude : input.latitude, input.longitude)) return error(res, 400, 'Latitude/longitude cabang tidak valid.', 'INVALID_COORDINATES');
    if (input.name !== undefined) branch.name = String(input.name).trim();
    if (input.address !== undefined) branch.address = String(input.address).trim();
    if (input.latitude !== undefined) branch.latitude = input.latitude === '' ? null : Number(input.latitude);
    if (input.longitude !== undefined) branch.longitude = input.longitude === '' ? null : Number(input.longitude);
    for (const key of ['radius', 'nearRadius', 'outsideRadius']) if (input[key] !== undefined) branch[key] = Math.max(1, Number(input[key]));
    if (input.active !== undefined) branch.active = Boolean(input.active);
    if (input.qrPayload !== undefined) branch.qrPayload = String(input.qrPayload).trim().toUpperCase() || branch.id;
    persist();
    return json(res, 200, { ok: true, branch: publicBranch(branch) });
  }

  return error(res, 404, 'Endpoint tidak ditemukan.', 'NOT_FOUND');
}

function normalizeBranch(input) {
  return {
    id: input.id,
    name: String(input.name || input.id),
    address: String(input.address || ''),
    latitude: validCoordinate(input.latitude, input.longitude) ? Number(input.latitude) : null,
    longitude: validCoordinate(input.latitude, input.longitude) ? Number(input.longitude) : null,
    radius: Math.max(1, Number(input.radius || 50)),
    nearRadius: Math.max(1, Number(input.nearRadius || 200)),
    outsideRadius: Math.max(1, Number(input.outsideRadius || 500)),
    active: input.active !== false,
    qrPayload: String(input.qrPayload || input.id).trim().toUpperCase(),
    createdAt: input.createdAt || nowIso(),
  };
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname.replace(/^\//, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return error(res, 403, 'Forbidden.', 'FORBIDDEN');
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(PUBLIC_DIR, 'index.html');
  const extension = path.extname(filePath);
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  res.writeHead(200, { 'Content-Type': types[extension] || 'application/octet-stream', 'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=3600' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (parsed.pathname.startsWith('/api/')) await handleApi(req, res, parsed.pathname, parsed.searchParams);
    else serveStatic(req, res, parsed.pathname);
  } catch (err) {
    console.error('Unhandled error:', err);
    if (!res.headersSent) error(res, 500, 'Terjadi kesalahan pada server.', 'SERVER_ERROR');
  }
});

server.listen(PORT, () => {
  console.log(`Master Teacher Attendance berjalan di http://localhost:${PORT}`);
  console.log(`Timezone server: ${TIME_ZONE} · Active branch: ${store.settings.activeBranchId}`);
});
