/**
 * LaunchPoint — Google Apps Script for form → Google Sheets
 *
 * SETUP (one-time, ~3 minutes):
 * 1. Go to https://sheets.google.com and create a new spreadsheet named "LaunchPoint Inquiries"
 * 2. Go to https://script.google.com → New Project → paste ALL of this code
 * 3. Click Deploy → New Deployment → Type: Web App
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. Click Deploy → copy the Web App URL
 * 5. Paste that URL into js/main.js replacing PASTE_YOUR_APPS_SCRIPT_URL_HERE
 * 6. Commit & push — Netlify will auto-redeploy
 */

const SHEET_NAME = 'Inquiries';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      // Header row
      sheet.appendRow([
        'Timestamp',
        'First Name',
        'Last Name',
        'Email',
        'Business',
        'Industry',
        'Challenge / Message',
      ]);
      sheet.getRange(1, 1, 1, 7).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    sheet.appendRow([
      data.timestamp || new Date().toISOString(),
      data.firstName || '',
      data.lastName  || '',
      data.email     || '',
      data.business  || '',
      data.industry  || '',
      data.challenge || '',
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'success' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Test via GET (visit the URL in browser to confirm it's live)
function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'LaunchPoint form endpoint is live ✓' }))
    .setMimeType(ContentService.MimeType.JSON);
}
