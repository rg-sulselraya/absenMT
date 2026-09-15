/**
 * Master Teacher Attendance - Google Apps Script bridge.
 *
 * Store SPREADSHEET_ID in Script Properties. MTA_API_TOKEN is optional:
 * leave it blank for an intentionally public pilot bridge.
 * Deploy as a Web app and keep the Web App URL only in the backend .env.
 */
const REQUIRED_TABS = ['Master Teacher', 'Branches', 'Attendance'];
const ATTENDANCE_COLUMN_COUNT = 15;

function doGet(event) {
  try {
    const parameter = (event && event.parameter) || {};
    if (!parameter.action) return output({ success: true, message: 'Master Teacher Attendance Google Apps Script bridge is running.' });
    const request = { action: String(parameter.action) };
    if (parameter.token) request.token = parameter.token;
    if (parameter.tabs) request.tabs = JSON.parse(parameter.tabs);
    if (parameter.values) request.values = JSON.parse(parameter.values);
    return handleRequest(request);
  } catch (error) {
    return output({ success: false, code: 'BRIDGE_ERROR', message: safeErrorMessage(error) });
  }
}

function doPost(event) {
  try {
    return handleRequest(parseRequest(event));
  } catch (error) {
    return output({ success: false, code: 'BRIDGE_ERROR', message: safeErrorMessage(error) });
  }
}

function handleRequest(request) {
  const expectedToken = PropertiesService.getScriptProperties().getProperty('MTA_API_TOKEN');
  if (expectedToken && (!request.token || !safeEqual(String(request.token), String(expectedToken)))) {
    return output({ success: false, code: 'UNAUTHORIZED', message: 'Token bridge tidak valid.' });
  }

  const spreadsheet = getSpreadsheet();
  switch (request.action) {
    case 'test':
      return output(testSpreadsheet(spreadsheet));
    case 'read':
      return output({ success: true, spreadsheetId: spreadsheet.getId(), values: readTabs(spreadsheet, request.tabs || REQUIRED_TABS) });
    case 'appendAttendance':
      return output(appendAttendance(spreadsheet, request.values));
    default:
      return output({ success: false, code: 'INVALID_ACTION', message: 'Aksi bridge tidak dikenali.' });
  }
}

function parseRequest(event) {
  if (!event || !event.postData || !event.postData.contents) throw new Error('Request body kosong.');
  const request = JSON.parse(event.postData.contents);
  if (!request || typeof request !== 'object') throw new Error('Request body tidak valid.');
  return request;
}

function getSpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Script Property SPREADSHEET_ID belum diatur.');
  try {
    return SpreadsheetApp.openById(id);
  } catch (error) {
    throw new Error('Spreadsheet tidak ditemukan atau akses Apps Script belum diberikan.');
  }
}

function readTabs(spreadsheet, tabs) {
  const values = {};
  tabs.forEach(function(tabName) {
    const sheet = spreadsheet.getSheetByName(tabName);
    if (!sheet) throw new Error('Sheet "' + tabName + '" tidak ditemukan.');
    // Read raw values so decimal coordinates are not confused with the
    // spreadsheet's locale-specific display separators.
    values[tabName] = sheet.getDataRange().getValues();
  });
  return values;
}

function testSpreadsheet(spreadsheet) {
  const values = readTabs(spreadsheet, REQUIRED_TABS);
  const sheets = {};
  REQUIRED_TABS.forEach(function(tabName) {
    sheets[tabName] = { connected: true, rows: Math.max(0, values[tabName].length - 1) };
  });
  return { success: true, message: 'Google Sheets connection successful', spreadsheetId: spreadsheet.getId(), values: values, sheets: sheets };
}

function appendAttendance(spreadsheet, values) {
  if (!Array.isArray(values) || values.length !== 1 || !Array.isArray(values[0]) || values[0].length !== ATTENDANCE_COLUMN_COUNT) {
    throw new Error('Format Attendance harus berupa satu baris dengan 15 kolom.');
  }
  const sheet = spreadsheet.getSheetByName('Attendance');
  if (!sheet) throw new Error('Sheet "Attendance" tidak ditemukan.');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, ATTENDANCE_COLUMN_COUNT).setValues(values);
  } finally {
    lock.releaseLock();
  }
  return { success: true, message: 'Attendance appended successfully', spreadsheetId: spreadsheet.getId(), sheet: 'Attendance', rowsAppended: 1 };
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

function safeErrorMessage(error) {
  const message = String(error && error.message || error || 'Kesalahan Apps Script.');
  return message.replace(/(private[_ -]?key|client[_ -]?secret|token|credential)[^\n]*/ig, '$1 disembunyikan');
}

function output(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
