// ===============================================================================
//  MarketAI — Google Apps Script (END-OF-DAY ONLY)
//  Writes exactly ONE price column per market per calendar day,
//  captured at each market's official closing time.
//
//  How to deploy:
//  1. Open Extensions → Apps Script
//  2. Replace all content with this file
//  3. Run: MarketAI → 1. Create Market Sheets
//  4. Run: MarketAI → 2. Setup EOD Triggers
// ===============================================================================

const CONFIG = {
  SYMBOLS_SHEET: 'SYMBOLS',
  TIMEZONE: 'Asia/Kolkata', // IST — all time comparisons are done in IST

  // How many calendar days of EOD history to keep
  // (older columns get deleted by the nightly cleanup)
  KEEP_DAYS: 365,

  // Markets to track.
  // runAfterIST: IST time (HH:MM, 24h) after which this market's EOD data is ready.
  //   - NSE closes 3:30 PM IST  → run at 3:35 PM IST
  //   - JPX closes 3:30 PM JST  → 3:30 PM JST = 12:00 PM IST → run at 12:05 PM IST
  //   - ASX closes 4:00 PM AEST → 4:00 PM AEST = 11:30 AM IST → run at 11:35 AM IST
  //   - SGX closes 5:00 PM SGT  → 5:00 PM SGT = 1:30 PM IST  → run at 1:35 PM IST
  //   - HKEX closes 4:00 PM HKT → 4:00 PM HKT = 1:30 PM IST  → run at 1:35 PM IST
  //   - LSE closes 4:30 PM BST  → 4:30 PM BST = 9:00 PM IST  → run at 9:05 PM IST
  //   - NASDAQ closes 4PM EST   → 4:00 PM EST = 2:30 AM IST  → run at 2:35 AM IST
  //
  // NOTE: NASDAQ runAfterIST is after midnight IST, so its EOD data is written
  //       in the early hours of the *next* IST calendar day. The column header
  //       date is set from the GOOGLEFINANCE data itself, not the run time.

  MARKETS: [
    { name: 'NSE',    sheet: 'NSE',    symbolCol: 1,  priceCol: 2,  runAfterIST: '15:35' },
    { name: 'NASDAQ', sheet: 'NASDAQ', symbolCol: 3,  priceCol: 4,  runAfterIST: '02:35' },
    { name: 'LSE',    sheet: 'LSE',    symbolCol: 5,  priceCol: 6,  runAfterIST: '21:05' },
    { name: 'SGX',    sheet: 'SGX',    symbolCol: 7,  priceCol: 8,  runAfterIST: '13:35' },
    { name: 'HKEX',   sheet: 'HKEX',  symbolCol: 9,  priceCol: 10, runAfterIST: '13:35' },
    { name: 'JPX',    sheet: 'JPX',    symbolCol: 11, priceCol: 12, runAfterIST: '12:05' },
    { name: 'ASX',    sheet: 'ASX',    symbolCol: 13, priceCol: 14, runAfterIST: '11:35' },
  ],
};

// ─── MAIN EOD TRIGGER ──────────────────────────────────────────────────────────
// Called by multiple daily time-triggers (one per market close window).
// Each call only writes markets whose EOD time has passed AND haven't been
// written today yet.
function logStockPrices() {
  const now = getNowIST();
  const nowIST = Utilities.formatDate(now, CONFIG.TIMEZONE, 'HH:mm');
  const startTime = Date.now();
  console.log(`[MarketAI EOD] Run at IST ${nowIST}`);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const symbolsSheet = ss.getSheetByName(CONFIG.SYMBOLS_SHEET);
  if (!symbolsSheet) {
    console.warn('[MarketAI] SYMBOLS sheet missing');
    return;
  }

  const lastRow = symbolsSheet.getLastRow();
  if (lastRow < 1) {
    console.warn('[MarketAI] SYMBOLS sheet is empty');
    return;
  }

  const allData = symbolsSheet.getRange(1, 1, lastRow, 14).getValues();

  for (const market of CONFIG.MARKETS) {
    try {
      // Skip this market if its EOD time hasn't arrived yet in IST
      if (!isAfterIST(nowIST, market.runAfterIST)) {
        console.log(`[MarketAI] ${market.name}: EOD time ${market.runAfterIST} IST not reached yet (now ${nowIST}) — skipping`);
        continue;
      }

      const marketSheet = ss.getSheetByName(market.sheet);
      if (!marketSheet) {
        console.warn(`[MarketAI] Sheet "${market.sheet}" missing — run "Create Market Sheets" first`);
        continue;
      }

      // Skip if we already wrote today's EOD column for this market
      if (hasWrittenToday(marketSheet)) {
        console.log(`[MarketAI] ${market.name}: EOD already recorded today — skipping`);
        continue;
      }

      processMarket(ss, market, allData, now);
    } catch (e) {
      console.error(`[MarketAI] ${market.name} Error: ${e.message}`);
    }
  }

  console.log(`[MarketAI EOD] Run complete in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

// ─── CHECK: HAS TODAY'S EOD ALREADY BEEN WRITTEN? ─────────────────────────────
// Returns true if the last column header in this market sheet has today's date (IST).
function hasWrittenToday(marketSheet) {
  const lastCol = marketSheet.getLastColumn();
  if (lastCol < 2) return false; // Only the Symbol column exists — nothing written yet

  const headerCell = marketSheet.getRange(1, lastCol).getValue();
  if (!headerCell) return false;

  const headerDate = headerCell instanceof Date ? headerCell : new Date(headerCell);
  if (isNaN(headerDate.getTime())) return false;

  const todayStr   = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const headerStr  = Utilities.formatDate(headerDate, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return todayStr === headerStr;
}

// ─── CHECK: IS IT PAST A GIVEN IST TIME? ──────────────────────────────────────
// nowStr and targetStr are both "HH:MM" in 24h format.
// Handles midnight wrap: if target is "02:35" and now is "14:00", return false.
// If target is "02:35" and now is "02:40", return true.
function isAfterIST(nowStr, targetStr) {
  const [nh, nm] = nowStr.split(':').map(Number);
  const [th, tm] = targetStr.split(':').map(Number);
  return (nh * 60 + nm) >= (th * 60 + tm);
}

// ─── PROCESS ONE MARKET ────────────────────────────────────────────────────────
function processMarket(ss, market, allData, now) {
  const marketSheet = ss.getSheetByName(market.sheet);
  if (!marketSheet) return;

  const { symbols, prices } = extractMarketData(allData, market);
  if (symbols.length === 0) {
    console.log(`[MarketAI] ${market.name}: No valid prices found in SYMBOLS sheet`);
    return;
  }

  // Ensure symbol column is up-to-date
  syncSymbolColumn(marketSheet, symbols);

  const syncedSymbols = getSymbolColumn(marketSheet);
  if (syncedSymbols.length === 0) return;

  // Build ordered price array matching the sheet's symbol column
  const priceMap = {};
  symbols.forEach((s, i) => { priceMap[s] = prices[i]; });
  const orderedPrices = syncedSymbols.map(s => priceMap[s] !== undefined ? priceMap[s] : '');

  // Write the EOD column (timestamp = now in IST)
  appendPriceColumn(marketSheet, orderedPrices, now);
  console.log(`[MarketAI] ${market.name}: EOD column written at ${Utilities.formatDate(now, CONFIG.TIMEZONE, 'dd/MM/yyyy HH:mm')} (${symbols.length} symbols)`);
}

// ─── EXTRACT DATA FROM SYMBOLS SHEET ──────────────────────────────────────────
function extractMarketData(allData, market) {
  const symIdx   = market.symbolCol - 1;
  const priceIdx = market.priceCol  - 1;
  const symbols  = [];
  const prices   = [];

  for (let r = 0; r < allData.length; r++) {
    const row = allData[r];
    const sym = row.length > symIdx ? String(row[symIdx] || '').trim() : '';
    if (!sym) continue;

    const priceStr = row.length > priceIdx ? String(row[priceIdx] || '').trim() : '';
    if (['#N/A','#ERROR!','#VALUE!','#REF!','#NUM!','Loading...',''].includes(priceStr)) continue;

    const price = Number(priceStr);
    if (isNaN(price) || price <= 0) continue;

    symbols.push(sym);
    prices.push(price);
  }
  return { symbols, prices };
}

// ─── SMART SYMBOL SYNC ─────────────────────────────────────────────────────────
function syncSymbolColumn(marketSheet, latestSymbols) {
  const lastRow = marketSheet.getLastRow();

  if (lastRow < 2) {
    marketSheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
    if (latestSymbols.length > 0) {
      marketSheet.getRange(2, 1, latestSymbols.length, 1).setValues(latestSymbols.map(s => [s]));
    }
    return;
  }

  const currentSymbols = marketSheet.getRange(2, 1, lastRow - 1, 1).getValues().map(r => String(r[0] || '').trim());
  const latestSet = new Set(latestSymbols);

  // Remove symbols that are no longer in the feed (back-to-front to preserve row indices)
  for (let r = currentSymbols.length - 1; r >= 0; r--) {
    const sym = currentSymbols[r];
    if (sym && !latestSet.has(sym)) {
      marketSheet.deleteRow(r + 2);
    }
  }

  // Append any new symbols at the bottom
  const remainingSymbols = getSymbolColumn(marketSheet);
  const currentSet = new Set(remainingSymbols);
  const toAdd = latestSymbols.filter(s => !currentSet.has(s));
  if (toAdd.length > 0) {
    const insertAt = Math.max(marketSheet.getLastRow() + 1, 2);
    marketSheet.getRange(insertAt, 1, toAdd.length, 1).setValues(toAdd.map(s => [s]));
  }
}

function getSymbolColumn(marketSheet) {
  const lastRow = marketSheet.getLastRow();
  if (lastRow < 2) return [];
  return marketSheet.getRange(2, 1, lastRow - 1, 1).getValues()
    .map(r => String(r[0] || '').trim())
    .filter(s => s.length > 0);
}

// ─── APPEND EOD PRICE COLUMN ───────────────────────────────────────────────────
function appendPriceColumn(marketSheet, prices, now) {
  if (prices.length === 0) return;
  const nextCol = marketSheet.getLastColumn() + 1;
  // Header = IST timestamp (stored as Date, displayed as dd/MM/yyyy HH:mm)
  marketSheet.getRange(1, nextCol).setValue(now).setNumberFormat('dd/MM/yyyy HH:mm');
  marketSheet.getRange(2, nextCol, prices.length, 1)
    .setValues(prices.map(p => [p === '' ? '' : p]))
    .setNumberFormat('0.00');
}

// ─── NIGHTLY CLEANUP ───────────────────────────────────────────────────────────
// Deletes columns older than KEEP_DAYS. Since we now write once per day,
// there's no intraday rollup needed — just pure age-based deletion.
function dailyCleanup() {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const now = new Date();

  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - CONFIG.KEEP_DAYS);
  cutoff.setHours(0, 0, 0, 0);

  CONFIG.MARKETS.forEach(market => {
    const marketSheet = ss.getSheetByName(market.sheet);
    if (!marketSheet) return;

    const lastCol = marketSheet.getLastColumn();
    if (lastCol < 2) return;

    const headers = marketSheet.getRange(1, 2, 1, lastCol - 1).getValues()[0];
    const toDelete = [];

    headers.forEach((h, idx) => {
      if (!h) return;
      const d = h instanceof Date ? h : new Date(h);
      if (!isNaN(d.getTime()) && d < cutoff) {
        toDelete.push(idx + 2); // +2: col is 1-indexed, offset by symbol col
      }
    });

    // Delete from right-to-left so column indices stay valid
    toDelete.sort((a, b) => b - a).forEach(col => marketSheet.deleteColumn(col));

    if (toDelete.length > 0) {
      console.log(`[MarketAI] ${market.name}: Deleted ${toDelete.length} old EOD columns (>${CONFIG.KEEP_DAYS} days)`);
    }
  });
}

// ─── HELPERS ───────────────────────────────────────────────────────────────────
function getNowIST() {
  return new Date(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'));
}

// ─── SETUP ─────────────────────────────────────────────────────────────────────
function setupMarketSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  CONFIG.MARKETS.forEach(market => {
    let sheet = ss.getSheetByName(market.sheet);
    if (!sheet) {
      sheet = ss.insertSheet(market.sheet);
      sheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
      console.log(`[MarketAI] Created sheet: ${market.sheet}`);
    }
  });
  SpreadsheetApp.getUi().alert('✓ Market Sheets Initialized');
}

function setupTriggers() {
  // Remove all existing triggers
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // Daily EOD triggers — one per market close window (all times in IST):
  //   11:40 → ASX (closes 11:30 IST)
  //   12:10 → JPX (closes 12:00 IST)
  //   13:40 → SGX, HKEX (close 13:30 IST)
  //   15:40 → NSE (closes 15:30 IST)
  //   21:10 → LSE (closes ~21:00 IST)
  //   02:40 → NASDAQ (closes ~02:30 IST next day)
  const eodHours = [
    { hour: 11, minute: 40 },  // ASX
    { hour: 12, minute: 10 },  // JPX
    { hour: 13, minute: 40 },  // SGX, HKEX
    { hour: 15, minute: 40 },  // NSE ← primary
    { hour: 21, minute: 10 },  // LSE
    { hour: 2,  minute: 40 },  // NASDAQ
  ];

  eodHours.forEach(t => {
    ScriptApp.newTrigger('logStockPrices')
      .timeBased()
      .atHour(t.hour)
      .nearMinute(t.minute)
      .everyDays(1)
      .create();
  });

  // Nightly cleanup at 00:30 IST
  ScriptApp.newTrigger('dailyCleanup')
    .timeBased()
    .atHour(0)
    .nearMinute(30)
    .everyDays(1)
    .create();

  SpreadsheetApp.getUi().alert(
    '✓ EOD Triggers Set:\n' +
    '- 11:40 IST → ASX\n' +
    '- 12:10 IST → JPX\n' +
    '- 13:40 IST → SGX, HKEX\n' +
    '- 15:40 IST → NSE\n' +
    '- 21:10 IST → LSE\n' +
    '- 02:40 IST → NASDAQ\n' +
    '- 00:30 IST → Nightly cleanup'
  );
}

// Manual one-shot: force-write ALL markets right now (ignores time and today-guard)
function forceSnapshotNow() {
  const now  = getNowIST();
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const symbolsSheet = ss.getSheetByName(CONFIG.SYMBOLS_SHEET);
  if (!symbolsSheet) { console.warn('SYMBOLS sheet missing'); return; }

  const lastRow = symbolsSheet.getLastRow();
  if (lastRow < 1) { console.warn('SYMBOLS sheet empty'); return; }

  const allData = symbolsSheet.getRange(1, 1, lastRow, 14).getValues();

  for (const market of CONFIG.MARKETS) {
    try {
      processMarket(ss, market, allData, now);
    } catch (e) {
      console.error(`[MarketAI] ${market.name} Error: ${e.message}`);
    }
  }
  SpreadsheetApp.getUi().alert('✓ Force snapshot complete for all markets');
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('MarketAI')
    .addItem('1. Create Market Sheets',  'setupMarketSheets')
    .addItem('2. Setup EOD Triggers',    'setupTriggers')
    .addSeparator()
    .addItem('Force Snapshot Now (All)', 'forceSnapshotNow')
    .addItem('Force Cleanup Now',        'dailyCleanup')
    .addToUi();
}
