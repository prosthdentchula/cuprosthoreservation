/**
 * DentaBook — Google Apps Script Backend  (Code.gs)
 * 
 * HOW TO DEPLOY / UPDATE:
 *   1. Open your Apps Script project at script.google.com
 *   2. Replace the entire contents of Code.gs with this file
 *   3. Click Deploy → Manage deployments → select your deployment → Edit (pencil)
 *   4. Change "Version" to "New version"  ← THIS IS CRITICAL
 *   5. Click Deploy
 */

const SPREADSHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();

function makeResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return makeResponse({ success: true, message: "DentaBook API ready" });
}

/* ── Main entry point with LockService ── */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    // Wait for up to 30 seconds for other processes to finish
    lock.waitLock(30000); 

    const payload = JSON.parse(e.postData.contents);
    const action  = payload.action;

    let result;
    if (action === "syncAll")  result = handleSyncAll();
    else if (action === "get")      result = handleGet(payload.range);
    else if (action === "put")      result = handlePut(payload.range, payload.values);
    else if (action === "append")   result = handleAppend(payload.range, payload.values);
    else {
      result = { success: false, error: `Unknown action: ${action}` };
    }

    return makeResponse(result);
  } catch (err) {
    return makeResponse({ success: false, error: err.message });
  } finally {
    // Always release the lock
    lock.releaseLock();
  }
}

function handleSyncAll() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  function sheetValues(name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return [];
    return sheet.getDataRange().getDisplayValues();
  }
  return {
    success: true,
    data: {
      advisors:        sheetValues("Advisors"),
      students:        sheetValues("Students"),
      units:           sheetValues("Units"),
      sessionAdvisors: sheetValues("Session_Advisors"),
      reservations:    sheetValues("Reservations"),
      admins:          sheetValues("Admins"),
    }
  };
}

function handleGet(range) {
  const ss     = SpreadsheetApp.openById(SPREADSHEET_ID);
  const values = ss.getRange(range).getDisplayValues(); 
  return { success: true, values: values };
}

function handlePut(range, values) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  ss.getRange(range).setValues(values);
  SpreadsheetApp.flush();
  return { success: true };
}

/* ════════════════════════════════════════════════════════════════════════════
   handleAppend — Now with "One-Winner" Validation for Reservations
   ════════════════════════════════════════════════════════════════════════════ */
function handleAppend(range, values) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheetName = range.includes("!") ? range.split("!")[0] : range;
  const sheet     = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);

  // ─── Conflict Check for Reservations ───
  if (sheetName === "Reservations") {
    const newRow = values[0];
    const unitId = newRow[3];
    const date   = newRow[4];
    const session = newRow[5];
    const isOverbookIntent = String(newRow[10]).toUpperCase() === "TRUE";

    // If the student didn't explicitly intend to overbook, check if it's already taken
    if (!isOverbookIntent) {
      const existingData = sheet.getDataRange().getValues();
      // Skip header row
      for (let i = 1; i < existingData.length; i++) {
        const row = existingData[i];
        // Column mapping: D=3 (unitId), E=4 (date), F=5 (session), J=9 (status)
        if (String(row[3]) === String(unitId) && 
            String(row[4]) === String(date) && 
            String(row[5]) === String(session) && 
            String(row[9]).toLowerCase() !== "cancelled") {
          
          return { 
            success: false, 
            error: "ขออภัย! ยูนิตนี้ถูกจองไปแล้วในเสี้ยววินาทีที่ผ่านมา โปรดเลือกยูนิตอื่น" 
          };
        }
      }
    }
  }

  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, values[0].length)
       .setValues(values);
  SpreadsheetApp.flush();
  return { success: true };
}
