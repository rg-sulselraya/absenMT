/** Master Teacher Attendance - Google Apps Script backend.
 *  Sheets are the source of truth; hashes/sessions/devices stay in Script
 *  Properties/CacheService. Run setAdminPin_('...') once before first login.
 */
var REQUIRED_TABS = ['Master Teacher', 'Branches', 'Attendance'];
var ATTENDANCE_COLUMN_COUNT = 15;
var PBKDF2_ITERATIONS = 12000;
var SESSION_TTL = 21600;
var MASTER_DATA_CACHE_TTL = 120;
var MASTER_TEACHERS_CACHE_KEY = 'MTA_MASTER_TEACHERS_V1';
var BRANCHES_CACHE_KEY = 'MTA_BRANCHES_V1';

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (p.path) {
      var method = String(p.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
      var input = p.body ? JSON.parse(p.body) : {};
      return jsonOutput(route(method, p.path, p, input));
    }
    if (p.action) return bridge_(parseBridgeGet(p));
    return HtmlService.createHtmlOutputFromFile('Index').setTitle('Master Teacher Attendance');
  } catch (error) { return jsonOutput({ ok: false, success: false, code: 'SERVER_ERROR', message: safeError(error) }); }
}

function doPost(e) {
  try {
    var p = (e && e.parameter) || {};
    var input = parseRequest(e);
    if (p.path) return jsonOutput(route('POST', p.path, p, input));
    return bridge_(input);
  } catch (error) { return jsonOutput({ ok: false, success: false, code: 'SERVER_ERROR', message: safeError(error) }); }
}

function route(method, rawPath, parameter, input) {
  try {
    var parsed = splitPath(rawPath);
    var params = Object.assign({}, parameter || {}, parsed.query || {});
    var session = getSession(params.session || (input && input.session));
    var path = parsed.pathname;
    if (path === '/api/health' && method === 'GET') return success({ app: 'Master Teacher Attendance', serverTime: nowIso() });
    if (path === '/api/auth/login' && method === 'POST') { var requestStartedAt = new Date().getTime(); perfLog_('REQUEST_RECEIVED', requestStartedAt); return login(input || {}, requestStartedAt); }
    if (path === '/api/auth/logout' && method === 'POST') { deleteSession_(params.session); return success({}); }
    if (path === '/api/me' && method === 'GET') {
      if (!session) return apiError('Belum login.', 'UNAUTHORIZED', 401);
      return success({ user: safeUser(session), device: session.role === 'teacher' ? publicDevice(findDevice(session.userId, session.deviceId)) : null, teacher: null });
    }
    if (!session) return apiError('Belum login.', 'UNAUTHORIZED', 401);
    if (path === '/api/config' && method === 'GET') return configResponse(session);
    if (path === '/api/cache/refresh' && method === 'POST') return requireAdmin(session, refreshMasterDataCache_);
    if (path === '/api/google-sheets/test' && method === 'GET') return requireAdmin(session, testSheets);
    if (path === '/api/master-teachers' && method === 'GET') return requireAdmin(session, function() { return success({ source: 'google-sheets', teachers: getMasterTeachers().map(function(t) { return Object.assign({}, t, { pinConfigured: Boolean(getTeacherPinHash(t.id)) }); }) }); });
    if (path === '/api/teacher-pin-status' && method === 'GET') return requireAdmin(session, function() { return success({ source: 'google-sheets', statuses: getMasterTeachers().map(function(t) { return { id: t.id, hasPin: Boolean(getTeacherPinHash(t.id)) }; }) }); });
    if (path === '/api/branches' && method === 'GET') return success({ source: 'google-sheets', branches: getBranches().filter(function(b) { return session.role === 'admin' || b.active; }) });
    if (path === '/api/dashboard' && method === 'GET') return requireAdmin(session, function() { return dashboard(params.date || today()); });
    if (path === '/api/attendance' && method === 'GET') return requireAdmin(session, function() { return attendanceResponse(params); });
    if (path === '/api/my-attendance' && method === 'GET') return requireTeacher(session, function() { return myAttendance(session.userId, params.date || today(), Boolean(params.date)); });
    if (path === '/api/attendance/scan' && method === 'POST') return requireTeacher(session, function() { return submitAttendanceFast_(session, input || {}); });
    var pinMatch = path.match(/^\/api\/teachers\/([^/]+)\/pin$/);
    if (pinMatch && method === 'POST') return requireAdmin(session, function() { return saveTeacherPin_(decodeURIComponent(pinMatch[1]), input && input.pin); });
    if (path === '/api/devices' && method === 'GET') return requireAdmin(session, function() { return success({ devices: getDevices().map(publicDevice) }); });
    var deviceMatch = path.match(/^\/api\/devices\/([^/]+)$/);
    if (deviceMatch && method === 'POST') return requireAdmin(session, function() { return updateDevice_(decodeURIComponent(deviceMatch[1]), input && input.action); });
    return apiError('Endpoint tidak ditemukan.', 'NOT_FOUND', 404);
  } catch (error) { return apiError(safeError(error), error.code || 'SERVER_ERROR', 500); }
}

function requireAdmin(session, callback) { return session.role === 'admin' ? callback() : apiError('Khusus Admin.', 'FORBIDDEN', 403); }
function requireTeacher(session, callback) { return session.role === 'teacher' ? callback() : apiError('Khusus Master Teacher.', 'FORBIDDEN', 403); }
function apiRequest(method, endpoint, input, sessionToken) { var parameter = { session: String(sessionToken || '') }; return route(String(method || 'GET').toUpperCase(), endpoint, parameter, input || {}); }

function login(input, requestStartedAt) {
  var startedAt = requestStartedAt || new Date().getTime();
  perfLog_('LOGIN_START', startedAt);
  if (!allowAttempt_('login:' + String(input.id || '').trim().toLowerCase(), 15, 60)) return apiError('Terlalu banyak percobaan login. Coba lagi beberapa saat.', 'RATE_LIMITED', 429);
  var role = input.role === 'admin' ? 'admin' : 'teacher';
  var id = String(input.id || '').trim();
  var pin = String(input.pin || '');
  if (role === 'admin') {
    var adminId = getProperty('MTA_ADMIN_ID') || 'admin';
    var adminHash = getProperty('MTA_ADMIN_PIN_HASH');
    if (!adminHash) return apiError('Login Admin belum dikonfigurasi.', 'ADMIN_NOT_CONFIGURED', 503);
    if (!sameId(id, adminId) || !verifySecret(pin, adminHash)) return apiError('ID atau PIN tidak cocok.', 'INVALID_CREDENTIALS', 401);
    var admin = createSession_({ userId: adminId, name: 'Admin', role: 'admin', branchId: null, deviceId: null });
    return success({ user: safeUser(admin), device: null, sessionToken: admin.token, serverTime: nowIso() });
  }
  var readMtStartedAt = new Date().getTime();
  perfLog_('READ_MT_START', startedAt);
  var teachers = getMasterTeachers();
  perfLog_('READ_MT_END', startedAt, { stageMs: new Date().getTime() - readMtStartedAt, count: teachers.length });
  var validateIdStartedAt = new Date().getTime();
  perfLog_('VALIDATE_ID_START', startedAt);
  var teacher = findById(teachers, id);
  perfLog_('VALIDATE_ID_END', startedAt, { stageMs: new Date().getTime() - validateIdStartedAt, found: Boolean(teacher) });
  if (!teacher) return apiError('Tidak dapat login. ID Master Teacher tidak ditemukan.', 'TEACHER_NOT_FOUND', 401);
  if (teacher.status !== 'active') return apiError('Akun Master Teacher tidak aktif.', 'TEACHER_INACTIVE', 403);
  if (!/^\d{6}$/.test(pin)) return apiError('PIN Master Teacher harus terdiri dari 6 digit.', 'INVALID_PIN_FORMAT', 400);
  var pinHash = getTeacherPinHash(teacher.id);
  var pinStartedAt = new Date().getTime();
  var pinValid = Boolean(pinHash) && verifySecret(pin, pinHash);
  perfLog_('PIN_CHECK', startedAt, { stageMs: new Date().getTime() - pinStartedAt, configured: Boolean(pinHash), valid: pinValid });
  if (!pinValid) return apiError('ID Master Teacher atau PIN salah.', 'INVALID_CREDENTIALS', 401);
  var deviceId = String(input.deviceId || '').trim().slice(0, 120);
  if (!deviceId) return apiError('Perangkat tidak dapat diidentifikasi.', 'DEVICE_REQUIRED', 400);
  var device = findDevice(teacher.id, deviceId);
  var devices = getDevices();
  if (!device) { device = { id: deviceId, mtId: teacher.id, status: 'pending', createdAt: nowIso(), lastSeenAt: nowIso() }; devices.push(device); }
  else device.lastSeenAt = nowIso();
  saveDevices_(devices);
  var sessionStartedAt = new Date().getTime();
  perfLog_('SESSION_START', startedAt);
  var user = createSession_({ userId: teacher.id, name: teacher.name, role: 'teacher', branchId: teacher.branchId, deviceId: deviceId });
  perfLog_('SESSION_END', startedAt, { stageMs: new Date().getTime() - sessionStartedAt });
  var response = success({ user: safeUser(user), device: publicDevice(device), sessionToken: user.token, serverTime: nowIso() });
  perfLog_('AUTH_END', startedAt);
  perfLog_('RESPONSE_SENT', startedAt);
  return response;
}

function configResponse(session) { var allBranches = getBranches(), branches = session && session.role === 'admin' ? allBranches : allBranches.filter(function(b) { return b.active; }), activeId = getProperty('ACTIVE_BRANCH_ID') || (branches[0] && branches[0].id) || ''; return success({ settings: { activeBranchId: activeId, timezone: getTimezone(), appName: 'Master Teacher Attendance' }, branch: findById(branches, activeId) || branches[0] || null, branches: branches, sheetsEnabled: true, sheetsProvider: 'google-apps-script', spreadsheetIdConfigured: Boolean(getProperty('SPREADSHEET_ID')), serverTime: nowIso() }); }
function getMasterTeachers() { var cached = getCachedJson_(MASTER_TEACHERS_CACHE_KEY); if (cached) return cached; var teachers = readRows('Master Teacher').map(function(r) { var raw = valueString(r.value(['status'])); return { id: valueString(r.value(['id mt', 'id master teacher', 'id'])), name: valueString(r.value(['nama master teacher', 'nama', 'name'])), branchId: valueString(r.value(['cabang utama', 'id cabang', 'branch id', 'branchid'])), status: activeValue(raw) ? 'active' : 'inactive', statusLabel: raw || '—', createdAt: valueString(r.value(['created at', 'dibuat', 'created'])) }; }).filter(function(t) { return t.id; }); putCachedJson_(MASTER_TEACHERS_CACHE_KEY, teachers); return teachers; }
function getBranches() { var cached = getCachedJson_(BRANCHES_CACHE_KEY); if (cached) return cached; var branches = readRows('Branches').map(function(r) { var lat = numberValue(r.value(['latitude'])); var lon = numberValue(r.value(['longitude'])); var id = valueString(r.value(['id cabang', 'branch id', 'id'])); var status = valueString(r.value(['status'])); var radius = numberValue(r.value(['radius (meter)', 'radius', 'radius meter'])); return { id: id, name: valueString(r.value(['nama cabang', 'nama', 'name'])), address: valueString(r.value(['alamat', 'address'])), latitude: validCoordinate(lat, lon) ? lat : null, longitude: validCoordinate(lat, lon) ? lon : null, latitudeRaw: valueString(r.value(['latitude'])), longitudeRaw: valueString(r.value(['longitude'])), radius: radius === null ? 50 : radius, nearRadius: 200, outsideRadius: 500, active: activeValue(status), status: status, qrPayload: valueString(r.value(['qr payload', 'payload'])) || id }; }).filter(function(b) { return b.id; }); putCachedJson_(BRANCHES_CACHE_KEY, branches); return branches; }
function getAttendance() { return readRows('Attendance').map(function(r) { var status = valueString(r.value(['status lokasi', 'status'])); return { attendanceId: valueString(r.value(['id absensi', 'attendance id', 'id'])), date: normalizeDate(r.value(['tanggal', 'date'])), mtId: valueString(r.value(['id mt', 'id master teacher'])), mtName: valueString(r.value(['nama master teacher', 'nama'])), branchId: valueString(r.value(['id cabang', 'branch id'])), branchName: valueString(r.value(['nama cabang', 'cabang'])), type: valueString(r.value(['jenis absensi', 'jenis', 'type'])), timestamp: valueString(r.value(['timestamp'])), time: normalizeTime(r.value(['jam', 'time'])), latitude: numberValue(r.value(['latitude'])), longitude: numberValue(r.value(['longitude'])), distanceMeters: numberValue(r.value(['jarak (meter)', 'jarak', 'distance'])), locationKey: locationKey(status), locationStatus: status, deviceId: valueString(r.value(['device id', 'deviceid'])), createdAt: valueString(r.value(['created at'])) }; }).filter(function(r) { return r.attendanceId; }); }
function attendanceResponse(p) { var records = getAttendance(); if (p.date) records = records.filter(function(r) { return r.date === p.date; }); if (p.mtId) records = records.filter(function(r) { return sameId(r.mtId, p.mtId); }); if (p.branchId) records = records.filter(function(r) { return sameId(r.branchId, p.branchId); }); if (p.locationKey) records = records.filter(function(r) { return r.locationKey === p.locationKey; }); return success({ source: 'google-sheets', records: records.sort(sortNewest), logs: getScanLogs(p.date) }); }
function myAttendance(id, date, dayOnly) { if (dayOnly) { var todayRecords = getAttendanceForDay_(id, date); return success({ date: date, records: todayRecords, history: [], logs: getScanLogs(date).filter(function(r) { return sameId(r.mtId, id); }).concat(todayRecords.map(function(r) { return Object.assign({}, r, { result: 'recorded' }); })).sort(sortNewest).slice(0, 60) }); } var all = getAttendance().filter(function(r) { return sameId(r.mtId, id); }).sort(sortNewest); return success({ date: date, records: all.filter(function(r) { return r.date === date; }), history: all.slice(0, 60), logs: getScanLogs().filter(function(r) { return sameId(r.mtId, id); }).concat(all.map(function(r) { return Object.assign({}, r, { result: 'recorded' }); })).sort(sortNewest).slice(0, 60) }); }
function dashboard(date) { var teachers = getMasterTeachers().filter(function(t) { return t.status === 'active'; }); var records = getAttendance().filter(function(r) { return r.date === date; }); var branches = getBranches(); var rows = teachers.map(function(t) { var own = records.filter(function(r) { return sameId(r.mtId, t.id); }).sort(sortNewest); var masuk = own.filter(function(r) { return r.type === 'MASUK'; })[0] || null; var pulang = own.filter(function(r) { return r.type === 'PULANG'; })[0] || null; return { teacher: t, branch: findById(branches, (masuk || pulang || {}).branchId || t.branchId), masuk: masuk, pulang: pulang }; }); return success({ date: date, metrics: { total: teachers.length, masuk: rows.filter(function(r) { return r.masuk; }).length, belumMasuk: rows.filter(function(r) { return !r.masuk; }).length, pulang: rows.filter(function(r) { return r.pulang; }).length, outside: records.filter(function(r) { return r.locationKey === 'outside' || r.locationKey === 'far'; }).length, newDevices: getDevices().filter(function(d) { return d.status === 'pending'; }).length }, rows: rows, recentActivity: getScanLogs(date).slice(0, 8) }); }
function testSheets() { var started = new Date().getTime(), sheets = {}; REQUIRED_TABS.forEach(function(name) { sheets[name] = { connected: true, rows: readRows(name).length }; }); return success({ message: 'Google Sheets connection successful', spreadsheet: { id: getSpreadsheet().getId(), name: 'Master Teacher Attendance' }, sheets: sheets, elapsedMs: new Date().getTime() - started }); }

function submitAttendanceFast_(session, input) {
  if (!allowAttempt_('scan:' + session.userId + ':' + session.deviceId, 8, 60)) return apiError('Terlalu banyak percobaan scan. Tunggu sebentar lalu coba lagi.', 'RATE_LIMITED', 429);
  var device = findDevice(session.userId, session.deviceId);
  if (!device || device.status !== 'approved') return apiError('Perangkat ini belum diotorisasi Admin.', 'DEVICE_PENDING', 403, { deviceId: session.deviceId });
  var branch = findById(getBranches(), String(input.branchId || input.payload || '').trim());
  if (!branch) return apiError('QR tidak valid atau cabang tidak ditemukan.', 'INVALID_QR', 400);
  if (!branch.active) return apiError('Cabang ini sedang tidak aktif.', 'BRANCH_INACTIVE', 400);
  if (!validCoordinate(branch.latitude, branch.longitude)) return apiError('Koordinat cabang belum dikonfigurasi Admin.', 'BRANCH_COORDINATES_MISSING', 409);
  var lat = numberValue(input.latitude), lon = numberValue(input.longitude);
  if (!validCoordinate(lat, lon)) return apiError('GPS tidak tersedia atau koordinat tidak valid. Aktifkan lokasi lalu coba lagi.', 'GPS_INVALID', 400);
  var distance = Math.round(haversine(lat, lon, branch.latitude, branch.longitude) * 10) / 10;
  var status = locationStatus(distance, branch), stamp = dateParts(new Date());
  var day = getAttendanceForDay_(session.userId, stamp.date);
  if (day.length >= 2) {
    var log = { logId: Utilities.getUuid(), date: stamp.date, time: stamp.time, timestamp: nowIso(), mtId: session.userId, mtName: session.name, branchId: branch.id, branchName: branch.name, result: 'complete', message: 'Absensi hari ini sudah lengkap.', deviceId: session.deviceId, latitude: lat, longitude: lon, distanceMeters: distance, locationKey: status.key, locationStatus: status.label, createdAt: nowIso() };
    appendScanLog_(log);
    return success({ complete: true, message: log.message, log: log });
  }
  var record = { attendanceId: 'ATT-' + new Date().getTime() + '-' + Utilities.getUuid().slice(0, 6).toUpperCase(), date: stamp.date, mtId: session.userId, mtName: session.name, branchId: branch.id, branchName: branch.name, type: day.length ? 'PULANG' : 'MASUK', timestamp: nowIso(), time: stamp.time, latitude: lat, longitude: lon, distanceMeters: distance, locationKey: status.key, locationStatus: status.label, deviceId: session.deviceId, createdAt: nowIso() };
  appendAttendanceRecord_(record);
  return success({ complete: false, record: record, warning: status.key === 'far' ? 'Absensi tetap tercatat. Lokasi scan berada jauh dari titik cabang.' : null });
}
function saveTeacherPin_(id, pin) { var startedAt = new Date().getTime(); perfLog_('PIN_CREATE_START', startedAt); if (!/^\d{6}$/.test(String(pin || ''))) return apiError('PIN harus terdiri dari tepat 6 digit.', 'INVALID_PIN_FORMAT', 400); var teacher = findById(getMasterTeachers(), id); if (!teacher) return apiError('ID Master Teacher tidak ditemukan di Google Sheet.', 'TEACHER_NOT_FOUND', 404); if (teacher.status !== 'active') return apiError('Akun Master Teacher tidak aktif.', 'TEACHER_INACTIVE', 409); var hashStartedAt = new Date().getTime(); var hash = hashSecret(pin); perfLog_('PIN_HASH_END', startedAt, { stageMs: new Date().getTime() - hashStartedAt }); var saveStartedAt = new Date().getTime(); setProperty_('MTA_PIN_' + idKey(teacher.id), hash); perfLog_('PIN_SAVE_END', startedAt, { stageMs: new Date().getTime() - saveStartedAt }); perfLog_('PIN_CREATE_RESPONSE', startedAt); return success({ teacher: teacher, pinConfigured: true }); }
function updateDevice_(id, action) { var devices = getDevices(), device = devices.filter(function(d) { return d.id === id; })[0]; if (!device) return apiError('Perangkat tidak ditemukan.', 'NOT_FOUND', 404); if (action === 'authorize') device.status = 'approved'; else if (action === 'reset') device.status = 'pending'; else if (action === 'revoke') device.status = 'blocked'; else return apiError('Aksi perangkat tidak valid.', 'INVALID_ACTION', 400); device.updatedAt = nowIso(); saveDevices_(devices); return success({ device: device }); }

function readRows(tabName) { var sheet = getSpreadsheet().getSheetByName(tabName); if (!sheet) throw new Error('Sheet "' + tabName + '" tidak ditemukan.'); var values = sheet.getDataRange().getValues(); if (!values.length) return []; var headers = values[0].map(function(v) { return String(v == null ? '' : v).trim().toLowerCase(); }); return values.slice(1).filter(function(row) { return row.some(function(v) { return String(v == null ? '' : v).trim(); }); }).map(function(row) { return { value: function(names) { var i = headers.findIndex(function(h) { return names.indexOf(h) !== -1; }); return i < 0 ? '' : row[i]; } }; }); }
function getAttendanceForDay_(mtId, date) { var sheet = getSpreadsheet().getSheetByName('Attendance'); if (!sheet) throw new Error('Sheet "Attendance" tidak ditemukan.'); var lastRow = sheet.getLastRow(), lastColumn = Math.max(sheet.getLastColumn(), ATTENDANCE_COLUMN_COUNT); if (lastRow < 2) return []; var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function(v) { return String(v == null ? '' : v).trim().toLowerCase(); }); var dateColumn = findHeaderIndex_(headers, ['tanggal', 'date']), mtColumn = findHeaderIndex_(headers, ['id mt', 'id master teacher']); if (dateColumn < 0 || mtColumn < 0) return []; var rowCount = lastRow - 1, dates = sheet.getRange(2, dateColumn + 1, rowCount, 1).getValues(), mtIds = sheet.getRange(2, mtColumn + 1, rowCount, 1).getValues(), matches = []; for (var i = 0; i < rowCount; i++) if (normalizeDate(dates[i][0]) === date && sameId(mtIds[i][0], mtId)) matches.push(i + 2); if (!matches.length) return []; return matches.map(function(rowNumber) { return attendanceFromRow_(headers, sheet.getRange(rowNumber, 1, 1, lastColumn).getValues()[0]); }).filter(function(r) { return r.attendanceId; }).sort(function(a, b) { return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(); }); }
function attendanceFromRow_(headers, row) { var value = function(names) { var i = findHeaderIndex_(headers, names); return i < 0 ? '' : row[i]; }, status = value(['status lokasi', 'status']); return { attendanceId: valueString(value(['id absensi', 'attendance id', 'id'])), date: normalizeDate(value(['tanggal', 'date'])), mtId: valueString(value(['id mt', 'id master teacher'])), mtName: valueString(value(['nama master teacher', 'nama'])), branchId: valueString(value(['id cabang', 'branch id'])), branchName: valueString(value(['nama cabang', 'cabang'])), type: valueString(value(['jenis absensi', 'jenis', 'type'])), timestamp: valueString(value(['timestamp'])), time: normalizeTime(value(['jam', 'time'])), latitude: numberValue(value(['latitude'])), longitude: numberValue(value(['longitude'])), distanceMeters: numberValue(value(['jarak (meter)', 'jarak', 'distance'])), locationKey: locationKey(status), locationStatus: valueString(status), deviceId: valueString(value(['device id', 'deviceid'])), createdAt: valueString(value(['created at'])) }; }
function findHeaderIndex_(headers, names) { for (var i = 0; i < headers.length; i++) if (names.indexOf(headers[i]) !== -1) return i; return -1; }
function appendAttendanceRecord_(r) { var sheet = getSpreadsheet().getSheetByName('Attendance'); if (!sheet) throw new Error('Sheet "Attendance" tidak ditemukan.'); var lock = LockService.getScriptLock(); lock.waitLock(10000); try { sheet.getRange(sheet.getLastRow() + 1, 1, 1, ATTENDANCE_COLUMN_COUNT).setValues([[r.attendanceId, r.date, r.mtId, r.mtName, r.branchId, r.branchName, r.type, r.timestamp, r.time, r.latitude, r.longitude, r.distanceMeters, r.locationStatus, r.deviceId, r.createdAt]]); } finally { lock.releaseLock(); } }
function getSpreadsheet() { var id = getProperty('SPREADSHEET_ID'); if (!id) throw new Error('Script Property SPREADSHEET_ID belum diatur.'); try { return SpreadsheetApp.openById(id); } catch (e) { throw new Error('Spreadsheet tidak ditemukan atau akses Apps Script belum diberikan.'); } }
function findById(items, id) { return items.filter(function(item) { return sameId(item.id, id) || sameId(item.name, id); })[0] || null; }
function sameId(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
function valueString(v) { if (v instanceof Date) return Utilities.formatDate(v, getTimezone(), 'yyyy-MM-dd HH:mm:ss'); return String(v == null ? '' : v).trim(); }
function normalizeDate(v) { if (v instanceof Date) return Utilities.formatDate(v, getTimezone(), 'yyyy-MM-dd'); var s = valueString(v); return s.length >= 10 ? s.slice(0, 10) : s; }
function normalizeTime(v) { if (v instanceof Date) return Utilities.formatDate(v, getTimezone(), 'HH:mm:ss'); var s = String(v == null ? '' : v).trim(); var match = s.match(/(?:T|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?/); if (match) return ('0' + match[1]).slice(-2) + ':' + match[2] + ':' + (match[3] || '00'); if (/^\d+(?:\.\d+)?$/.test(s)) { var seconds = Math.round((Number(s) % 1) * 86400) % 86400, hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60), rest = seconds % 60; return ('0' + hours).slice(-2) + ':' + ('0' + minutes).slice(-2) + ':' + ('0' + rest).slice(-2); } return s; }
function numberValue(v) { if (v === '' || v === null || v === undefined) return null; var n = Number(String(v).replace(',', '.')); return isFinite(n) ? n : null; }
function validCoordinate(a, b) { return a !== null && b !== null && isFinite(a) && isFinite(b) && a >= -90 && a <= 90 && b >= -180 && b <= 180; }
function activeValue(v) { return ['aktif', 'active', 'true', '1'].indexOf(String(v || '').trim().toLowerCase()) !== -1; }
function locationKey(v) { v = String(v || '').toLowerCase(); if (v.indexOf('jauh') >= 0) return 'far'; if (v.indexOf('luar') >= 0) return 'outside'; if (v.indexOf('dekat') >= 0) return 'near'; if (v.indexOf('area') >= 0) return 'area'; return 'neutral'; }
function locationStatus(d, b) { var r = Number(b.radius || 50), n = Number(b.nearRadius || 200), o = Number(b.outsideRadius || 500); if (d <= r) return { key: 'area', label: 'Di Area Cabang' }; if (d <= n) return { key: 'near', label: 'Dekat Cabang' }; if (d <= o) return { key: 'outside', label: 'Di Luar Area Cabang' }; return { key: 'far', label: 'Jauh dari Cabang' }; }
function haversine(a, b, c, d) { var rad = function(x) { return x * Math.PI / 180; }, la = rad(c - a), lo = rad(d - b), q = Math.sin(la / 2) * Math.sin(la / 2) + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(lo / 2) * Math.sin(lo / 2); return 6371000 * 2 * Math.asin(Math.sqrt(q)); }
function dateParts(d) { return { date: Utilities.formatDate(d, getTimezone(), 'yyyy-MM-dd'), time: Utilities.formatDate(d, getTimezone(), 'HH:mm:ss') }; }
function today() { return dateParts(new Date()).date; }
function getTimezone() { return getProperty('APP_TIMEZONE') || Session.getScriptTimeZone() || 'Asia/Makassar'; }
function nowIso() { return new Date().toISOString(); }
function sortNewest(a, b) { return new Date(b.timestamp || b.createdAt).getTime() - new Date(a.timestamp || a.createdAt).getTime(); }

function getProperty(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function setProperty_(k, v) { PropertiesService.getScriptProperties().setProperty(k, String(v)); }
function perfLog_(label, startedAt, details) { if (getProperty('MTA_PERF_LOGGING') === 'false') return; var entry = Object.assign({ marker: 'MTA_PERF', label: label, elapsedMs: new Date().getTime() - Number(startedAt || new Date().getTime()), at: new Date().toISOString() }, details || {}); try { console.log(JSON.stringify(entry)); } catch (e) { Logger.log(JSON.stringify(entry)); } }
function getCachedJson_(key) { var raw = CacheService.getScriptCache().get(key); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { CacheService.getScriptCache().remove(key); return null; } }
function putCachedJson_(key, value) { var raw = JSON.stringify(value); if (raw.length < 95000) CacheService.getScriptCache().put(key, raw, MASTER_DATA_CACHE_TTL); }
function refreshMasterDataCache_() { var cache = CacheService.getScriptCache(); cache.removeAll([MASTER_TEACHERS_CACHE_KEY, BRANCHES_CACHE_KEY]); var teachers = getMasterTeachers(), branches = getBranches(); return success({ message: 'Cache Master Teacher dan Cabang diperbarui.', teachers: teachers.length, branches: branches.length }); }
function idKey(id) { return String(id || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_'); }
function getTeacherPinHash(id) { return getProperty('MTA_PIN_' + idKey(id)); }
function hashSecret(secret) { var salt = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + new Date().getTime() + Math.random(), Utilities.Charset.UTF_8).slice(0, 16); return 'PBKDF2-SHA256$' + PBKDF2_ITERATIONS + '$' + Utilities.base64EncodeWebSafe(salt) + '$' + Utilities.base64EncodeWebSafe(pbkdf2(String(secret), salt, PBKDF2_ITERATIONS, 32)); }
function verifySecret(secret, encoded) { try { var p = String(encoded || '').split('$'); return p.length === 4 && p[0] === 'PBKDF2-SHA256' && constantEqual(pbkdf2(String(secret), Utilities.base64DecodeWebSafe(p[2]), Number(p[1]), 32), Utilities.base64DecodeWebSafe(p[3])); } catch (e) { return false; } }
function pbkdf2(password, salt, iterations, length) { var key = Utilities.newBlob(password).getBytes(), out = []; for (var block = 1; block <= Math.ceil(length / 32); block++) { var u = Utilities.computeHmacSha256Signature((salt || []).concat([0, 0, 0, block]), key), t = u.slice(); for (var i = 1; i < iterations; i++) { u = Utilities.computeHmacSha256Signature(u, key); t = t.map(function(v, j) { return v ^ u[j]; }); } out = out.concat(t); } return out.slice(0, length); }
function constantEqual(a, b) { if (!a || !b || a.length !== b.length) return false; var n = 0; for (var i = 0; i < a.length; i++) n |= a[i] ^ b[i]; return n === 0; }
function setAdminPin_(pin, id) { if (!/^\d{6,}$/.test(String(pin || ''))) throw new Error('Admin PIN minimal 6 digit.'); setProperty_('MTA_ADMIN_ID', String(id || getProperty('MTA_ADMIN_ID') || 'admin').trim().toLowerCase()); setProperty_('MTA_ADMIN_PIN_HASH', hashSecret(pin)); return 'Admin PIN hash tersimpan.'; }
function setTeacherPin_(id, pin) { var r = saveTeacherPin_(id, pin); if (!r.ok) throw new Error(r.message); return 'Master Teacher PIN hash tersimpan.'; }
function createSession_(data) { var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''), session = Object.assign({}, data, { token: token, expiresAt: new Date().getTime() + SESSION_TTL * 1000 }); CacheService.getScriptCache().put('MTA_SESSION_' + token, JSON.stringify(session), SESSION_TTL); return session; }
function getSession(token) { if (!token) return null; var cache = CacheService.getScriptCache(), raw = cache.get('MTA_SESSION_' + token); if (!raw) return null; var s = JSON.parse(raw); if (s.expiresAt < new Date().getTime()) { cache.remove('MTA_SESSION_' + token); return null; } s.expiresAt = new Date().getTime() + SESSION_TTL * 1000; cache.put('MTA_SESSION_' + token, JSON.stringify(s), SESSION_TTL); return s; }
function deleteSession_(token) { if (token) CacheService.getScriptCache().remove('MTA_SESSION_' + token); }
function getDevices() { var raw = getProperty('MTA_DEVICES'); try { return raw ? JSON.parse(raw) : []; } catch (e) { return []; } }
function saveDevices_(v) { setProperty_('MTA_DEVICES', JSON.stringify(v)); }
function findDevice(mt, id) { return getDevices().filter(function(d) { return sameId(d.mtId, mt) && d.id === id; })[0] || null; }
function publicDevice(d) { return d ? { id: d.id, mtId: d.mtId, status: d.status, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, updatedAt: d.updatedAt } : null; }
function getScanLogs(date) { var raw = getProperty('MTA_SCAN_LOGS'), logs = []; try { logs = raw ? JSON.parse(raw) : []; } catch (e) {} return logs.filter(function(l) { return !date || l.date === date; }).sort(sortNewest); }
function appendScanLog_(log) { var logs = getScanLogs(); logs.push(log); setProperty_('MTA_SCAN_LOGS', JSON.stringify(logs.slice(-500))); }
function allowAttempt_(key, max, seconds) { var cache = CacheService.getScriptCache(), name = 'MTA_RATE_' + idKey(key), current = Number(cache.get(name) || 0) + 1; cache.put(name, String(current), seconds); return current <= max; }
function safeUser(s) { return { id: s.userId, name: s.name, role: s.role, branchId: s.branchId || null, status: 'active' }; }
function success(p) { return Object.assign({ ok: true }, p || {}); }
function apiError(message, code, status, details) { return { ok: false, status: status || 400, code: code || 'BAD_REQUEST', message: message, details: details }; }
function splitPath(raw) { var text = String(raw || ''), parts = text.split('?'), query = {}; (parts[1] || '').split('&').forEach(function(pair) { if (!pair) return; var p = pair.split('='); query[decodeURIComponent(p[0])] = decodeURIComponent(p.slice(1).join('=') || ''); }); return { pathname: parts[0], query: query }; }
function parseRequest(e) { if (!e || !e.postData || !e.postData.contents) return {}; var v = JSON.parse(e.postData.contents); if (!v || typeof v !== 'object') throw new Error('Request body tidak valid.'); return v; }
function jsonOutput(p) { return ContentService.createTextOutput(JSON.stringify(p)).setMimeType(ContentService.MimeType.JSON); }
function safeError(e) { return String(e && e.message || e || 'Kesalahan Apps Script.').replace(/(private[_ -]?key|client[_ -]?secret|token|credential)[^\n]*/ig, '$1 disembunyikan'); }

// Compatibility for the previous Node backend bridge.
function parseBridgeGet(p) { var r = { action: String(p.action) }; if (p.token) r.token = p.token; if (p.tabs) r.tabs = JSON.parse(p.tabs); if (p.values) r.values = JSON.parse(p.values); return r; }
function bridge_(r) { var expected = getProperty('MTA_API_TOKEN'); if (expected && (!r.token || !safeEqual(String(r.token), String(expected)))) return jsonOutput({ success: false, code: 'UNAUTHORIZED', message: 'Token bridge tidak valid.' }); var s = getSpreadsheet(); if (r.action === 'test') return jsonOutput(testSpreadsheet(s)); if (r.action === 'read') return jsonOutput({ success: true, spreadsheetId: s.getId(), values: readTabs(s, r.tabs || REQUIRED_TABS) }); if (r.action === 'appendAttendance') return jsonOutput(appendAttendanceBridge_(s, r.values)); return jsonOutput({ success: false, code: 'INVALID_ACTION', message: 'Aksi bridge tidak dikenali.' }); }
function readTabs(s, tabs) { var out = {}; tabs.forEach(function(name) { var sheet = s.getSheetByName(name); if (!sheet) throw new Error('Sheet "' + name + '" tidak ditemukan.'); out[name] = sheet.getDataRange().getValues(); }); return out; }
function testSpreadsheet(s) { var values = readTabs(s, REQUIRED_TABS), sheets = {}; REQUIRED_TABS.forEach(function(name) { sheets[name] = { connected: true, rows: Math.max(0, values[name].length - 1) }; }); return { success: true, message: 'Google Sheets connection successful', spreadsheetId: s.getId(), values: values, sheets: sheets }; }
function appendAttendanceBridge_(s, values) { if (!Array.isArray(values) || values.length !== 1 || !Array.isArray(values[0]) || values[0].length !== ATTENDANCE_COLUMN_COUNT) throw new Error('Format Attendance harus berupa satu baris dengan 15 kolom.'); var sheet = s.getSheetByName('Attendance'); if (!sheet) throw new Error('Sheet "Attendance" tidak ditemukan.'); var lock = LockService.getScriptLock(); lock.waitLock(10000); try { sheet.getRange(sheet.getLastRow() + 1, 1, 1, ATTENDANCE_COLUMN_COUNT).setValues(values); } finally { lock.releaseLock(); } return { success: true, message: 'Attendance appended successfully', spreadsheetId: s.getId(), sheet: 'Attendance', rowsAppended: 1 }; }
function safeEqual(a, b) { if (a.length !== b.length) return false; var n = 0; for (var i = 0; i < a.length; i++) n |= a.charCodeAt(i) ^ b.charCodeAt(i); return n === 0; }
