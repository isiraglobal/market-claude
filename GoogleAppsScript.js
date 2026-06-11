// GoogleAppsScript.js
// Paste this code into Extensions -> Apps Script in your Google Sheets spreadsheet.
// Make sure you have Sheet1 (for live formulas) and Sheet2 (for rolling history).
//
// 1. Run setupTriggers() once manually to authorize the script and schedule it.
// 2. The script logs NSE stock prices every 5 minutes during trading hours, maintaining
//    Column A as the SYMBOL and logging rolling 200 snapshots (prevents file size bloat).

function setupTriggers() {
  // Clear existing triggers to avoid duplicates
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    ScriptApp.deleteTrigger(t);
  }
  
  // Set up trigger to run every 5 minutes
  ScriptApp.newTrigger('logPrices')
    .timeBased()
    .everyMinutes(5)
    .create();
    
  Logger.log('Trigger successfully scheduled to run every 5 minutes.');
}

function logPrices() {
  const timestamp = new Date();
  
  // Only run on weekdays (Monday=1 to Friday=5)
  const day = timestamp.getDay();
  if (day === 0 || day === 6) {
    Logger.log('Skipping sync: Weekend.');
    return;
  }
  
  // Only run during NSE market hours (09:10 to 15:40 IST)
  // IST is UTC+5:30. Let's calculate the hours and minutes in IST.
  const utcHours = timestamp.getUTCHours();
  const utcMinutes = timestamp.getUTCMinutes();
  
  const istMinutesTotal = (utcHours * 60 + utcMinutes + 330) % 1440;
  const istHour = Math.floor(istMinutesTotal / 60);
  const istMinute = istMinutesTotal % 60;
  
  // 9:10 IST = 550 minutes, 15:40 IST = 940 minutes
  const marketOpenMinutes = 9 * 60 + 10;
  const marketCloseMinutes = 15 * 60 + 40;
  
  if (istMinutesTotal < marketOpenMinutes || istMinutesTotal > marketCloseMinutes) {
    Logger.log('Skipping sync: Outside NSE market hours (' + istHour + ':' + (istMinute < 10 ? '0' : '') + istMinute + ' IST).');
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet1 = ss.getSheetByName("Sheet1");
  let sheet2 = ss.getSheetByName("Sheet2");
  
  if (!sheet2) {
    sheet2 = ss.insertSheet("Sheet2");
  }
  
  // 1. Read Sheet1 (Live Prices)
  // Row 1: Headers ("SYMBOL", etc.)
  // Col A: SYMBOL, Col E: LIVE_PRICE (Index 4)
  const s1Values = sheet1.getDataRange().getValues();
  const s1Prices = {};
  
  for (let i = 1; i < s1Values.length; i++) {
    const sym = String(s1Values[i][0]).trim().toUpperCase();
    const price = parseFloat(s1Values[i][4]);
    if (sym && !isNaN(price) && price > 0) {
      s1Prices[sym] = price;
    }
  }
  
  // 2. Read Sheet2 (Historical price pool)
  const s2Range = sheet2.getDataRange();
  let s2Values = s2Range.getValues();
  
  // Initialize Sheet2 header if empty
  if (s2Values.length === 0 || s2Values[0].length === 0) {
    sheet2.getRange(1, 1).setValue("SYMBOL");
    s2Values = [["SYMBOL"]];
  }
  
  // Build map of symbol -> row index in Sheet2 (0-indexed)
  const s2SymMap = {};
  for (let i = 1; i < s2Values.length; i++) {
    const sym = String(s2Values[i][0]).trim().toUpperCase();
    if (sym) s2SymMap[sym] = i;
  }
  
  // 3. Get the union list of all symbols, sorted alphabetically
  const allSymbols = Array.from(new Set([
    ...Object.keys(s1Prices),
    ...Object.keys(s2SymMap)
  ])).sort();
  
  // Rebuild the Column A symbols list to keep it perfectly aligned and sorted
  const newColumnA = [["SYMBOL"]];
  allSymbols.forEach(sym => {
    newColumnA.push([sym]);
  });
  
  // Write the sorted symbols list back to Column A
  sheet2.getRange(1, 1, newColumnA.length, 1).setValues(newColumnA);
  
  // 4. Insert a new column at Column B (Column Index 2) for the new snapshot
  sheet2.insertColumnAfter(1);
  
  // Set header of the new column to the current timestamp (epoch milliseconds)
  const timeMillis = timestamp.getTime();
  sheet2.getRange(1, 2).setValue(timeMillis);
  
  // 5. Populate Column B with prices
  const newPrices = new Array(allSymbols.length).fill(0).map(() => [""]);
  allSymbols.forEach((sym, idx) => {
    if (s1Prices[sym] !== undefined) {
      newPrices[idx] = [s1Prices[sym]];
    } else {
      // If price is missing in Sheet1 (e.g. data source issue), carry forward the last price
      // The previous Column B has now shifted to Column C (index 2 of the old s2Values array)
      const oldRowIdx = s2SymMap[sym];
      if (oldRowIdx !== undefined && oldRowIdx < s2Values.length) {
        const prevPrice = s2Values[oldRowIdx][1]; // Column B was index 1 in old array
        if (prevPrice !== "" && !isNaN(prevPrice)) {
          newPrices[idx] = [prevPrice];
        }
      }
    }
  });
  
  // Write new prices column to Column B
  sheet2.getRange(2, 2, newPrices.length, 1).setValues(newPrices);
  
  // 6. Enforce rolling window of 200 snapshots
  const MAX_SNAPSHOTS = 200;
  const totalCols = sheet2.getLastColumn();
  if (totalCols > MAX_SNAPSHOTS + 1) { // +1 for the Symbol column
    const deleteCount = totalCols - (MAX_SNAPSHOTS + 1);
    // Delete oldest columns on the right (starting at column index MAX_SNAPSHOTS + 2)
    sheet2.deleteColumns(MAX_SNAPSHOTS + 2, deleteCount);
  }
  
  Logger.log('Successfully logged prices for ' + allSymbols.length + ' symbols at ' + timestamp.toISOString());
}

// Helper function to test logging manually
function forceLog() {
  logPrices();
}
