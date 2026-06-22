// ===============================================================================
//  MarketAI — Google Apps Script
//  5-Minute Intraday Capture (NSE) + EOD OHLC (Other Markets)
//  Wide format: Col A = Symbols, Row 1 = Timestamps (dd/MM/yyyy HH:mm)
// ===============================================================================

const CONFIG = {
  SYMBOLS_SHEET: 'SYMBOLS',
  TIMEZONE: 'Asia/Kolkata',
  KEEP_DAYS: 30,
  INTRADAY_INTERVAL_MINUTES: 5,
  NSE_MARKET_OPEN: '09:15',
  NSE_MARKET_CLOSE: '15:30',
  MARKETS: [
    { name: 'NSE',    sheet: 'NSE',    prefix: 'NSE',    closeCol: 2,  openCol: 3,  highCol: 4,  lowCol: 5,  runAfterIST: '15:35', intraday: true },
    { name: 'NASDAQ', sheet: 'NASDAQ', prefix: 'NASDAQ', closeCol: 6,  openCol: 7,  highCol: 8,  lowCol: 9,  runAfterIST: '02:35', intraday: false },
    { name: 'LSE',    sheet: 'LSE',    prefix: 'LON',    closeCol: 10, openCol: 11, highCol: 12, lowCol: 13, runAfterIST: '21:05', intraday: false },
    { name: 'SGX',    sheet: 'SGX',    prefix: 'SGX',    closeCol: 14, openCol: 15, highCol: 16, lowCol: 17, runAfterIST: '13:35', intraday: false },
    { name: 'HKEX',   sheet: 'HKEX',   prefix: 'HKEX',   closeCol: 18, openCol: 19, highCol: 20, lowCol: 21, runAfterIST: '13:35', intraday: false },
    { name: 'JPX',    sheet: 'JPX',    prefix: 'TK2',    closeCol: 22, openCol: 23, highCol: 24, lowCol: 25, runAfterIST: '12:05', intraday: false },
    { name: 'ASX',    sheet: 'ASX',    prefix: 'ASX',    closeCol: 26, openCol: 27, highCol: 28, lowCol: 29, runAfterIST: '11:35', intraday: false },
  ],
};

const maxCol = Math.max(...CONFIG.MARKETS.map(m => m.lowCol));
const badValues = ['#N/A','#ERROR!','#VALUE!','#REF!','#NUM!','Loading...',''];

function getNowIST() {
  return new Date(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'));
}

function getNowISTStr() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');
}

function getTimeIST() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'HH:mm');
}

function getDayIST() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function minutesSinceMidnight(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function isMarketHours() {
  const now = minutesSinceMidnight(getTimeIST());
  const open = minutesSinceMidnight(CONFIG.NSE_MARKET_OPEN);
  const close = minutesSinceMidnight(CONFIG.NSE_MARKET_CLOSE);
  return now >= open && now <= close;
}

function isWeekday() {
  const day = new Date().getDay();
  return day >= 1 && day <= 5;
}

function lastSnapshotMinutesAgo(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 2) return 99;
  const header = sheet.getRange(1, lastCol).getValue();
  if (!header) return 99;
  const d = header instanceof Date ? header : new Date(header);
  if (isNaN(d.getTime())) return 99;
  const now = new Date();
  return (now.getTime() - d.getTime()) / 60000;
}

function isAfterIST(nowStr, targetStr) {
  const [nh, nm] = nowStr.split(':').map(Number);
  const [th, tm] = targetStr.split(':').map(Number);
  return (nh * 60 + nm) >= (th * 60 + tm);
}

function hasWrittenToday(marketSheet) {
  const lastCol = marketSheet.getLastColumn();
  if (lastCol < 2) return false;
  const header = marketSheet.getRange(1, lastCol).getValue();
  if (!header) return false;
  const d = header instanceof Date ? header : new Date(header);
  if (isNaN(d.getTime())) return false;
  const todayStr = getDayIST();
  const hdrStr = Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return todayStr === hdrStr;
}

// ─── MAIN INTRADAY TRIGGER (runs every 5 min) ────────────────────────────────
function captureIntradaySnapshot() {
  const startTime = Date.now();
  const nowStr = getNowISTStr();

  if (!isWeekday()) {
    console.log(`[MarketAI] Weekend — skipping intraday`);
    return;
  }

  if (!isMarketHours()) {
    console.log(`[MarketAI] Outside NSE market hours (${getTimeIST()}) — skipping intraday`);
    return;
  }

  console.log(`[MarketAI] Intraday snapshot at ${nowStr}`);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const symbolsSheet = ss.getSheetByName(CONFIG.SYMBOLS_SHEET);
  if (!symbolsSheet) { console.warn('[MarketAI] SYMBOLS sheet missing'); return; }

  const lastRow = symbolsSheet.getLastRow();
  if (lastRow < 2) { console.warn('[MarketAI] SYMBOLS sheet empty'); return; }

  const nseConfig = CONFIG.MARKETS.find(m => m.name === 'NSE');
  if (!nseConfig) return;

  const nseSheet = ss.getSheetByName(nseConfig.sheet);
  if (!nseSheet) { console.warn('[MarketAI] NSE sheet missing'); return; }

  // Only capture if last snapshot was >= INTRADAY_INTERVAL_MINUTES ago
  const minsAgo = lastSnapshotMinutesAgo(nseSheet);
  if (minsAgo < CONFIG.INTRADAY_INTERVAL_MINUTES) {
    console.log(`[MarketAI] Last snapshot ${Math.round(minsAgo)}m ago — skipping (interval: ${CONFIG.INTRADAY_INTERVAL_MINUTES}m)`);
    return;
  }

  // Read all symbols and their close prices from SYMBOLS sheet
  const allData = symbolsSheet.getRange(1, 1, lastRow, maxCol).getValues();

  // Read existing symbols in NSE sheet to sync
  syncSymbolColumn(nseSheet, allData.slice(1).map(r => String(r[0] || '').trim()).filter(Boolean));
  const syncedSymbols = getSymbolColumn(nseSheet);
  if (!syncedSymbols.length) return;

  // Build symbol → price map
  const priceMap = {};
  const closeIdx = nseConfig.closeCol - 1;
  for (let r = 1; r < allData.length; r++) {
    const row = allData[r];
    const sym = String(row[0] || '').trim();
    if (!sym) continue;
    const priceStr = row.length > closeIdx ? String(row[closeIdx] || '').trim() : '';
    if (badValues.includes(priceStr)) continue;
    const price = Number(priceStr);
    if (isNaN(price) || price <= 0) continue;
    priceMap[sym] = price;
  }

  if (Object.keys(priceMap).length === 0) {
    console.log('[MarketAI] No valid prices found');
    return;
  }

  // Write prices in symbol order matching NSE sheet
  const orderedPrices = syncedSymbols.map(s => priceMap[s] !== undefined ? priceMap[s] : '');
  const now = new Date();
  const nextCol = nseSheet.getLastColumn() + 1;
  nseSheet.getRange(1, nextCol).setValue(now).setNumberFormat('dd/MM/yyyy HH:mm');
  nseSheet.getRange(2, nextCol, orderedPrices.length, 1).setValues(
    orderedPrices.map(v => [v === '' ? '' : v])
  );

  console.log(`[MarketAI] Intraday snapshot written: ${Object.keys(priceMap).length} prices at ${nowStr} (${(Date.now()-startTime)/1000}s)`);
}

// ─── EOD TRIGGER (existing for all markets including NSE backup) ─────────────
function logStockPrices() {
  const now = getNowIST();
  const nowIST = getTimeIST();
  const startTime = Date.now();
  console.log(`[MarketAI EOD] Run at IST ${nowIST}`);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const symbolsSheet = ss.getSheetByName(CONFIG.SYMBOLS_SHEET);
  if (!symbolsSheet) { console.warn('[MarketAI] SYMBOLS sheet missing'); return; }

  const lastRow = symbolsSheet.getLastRow();
  if (lastRow < 1) { console.warn('[MarketAI] SYMBOLS sheet empty'); return; }

  const allData = symbolsSheet.getRange(1, 1, lastRow, maxCol).getValues();

  for (const market of CONFIG.MARKETS) {
    try {
      if (!isAfterIST(nowIST, market.runAfterIST)) continue;
      const marketSheet = ss.getSheetByName(market.sheet);
      if (!marketSheet) { console.warn(`[MarketAI] Sheet "${market.sheet}" missing`); continue; }
      // For intraday markets (NSE), still write EOD OHLC even if intraday snapshots exist
      if (!market.intraday && hasWrittenToday(marketSheet)) continue;
      processMarket(ss, market, allData, now);
    } catch (e) { console.error(`[MarketAI] ${market.name} Error: ${e.message}`); }
  }
  console.log(`[MarketAI EOD] Run in ${((Date.now()-startTime)/1000).toFixed(1)}s`);
}

// ─── INTRADAY OHLC COMPUTATION ────────────────────────────────────────────────
// Reads all intraday snapshots for today and computes OPEN/HIGH/LOW/CLOSE per symbol.
// This avoids relying on broken GOOGLEFINANCE "high"/"low" parameters.
function getIntradayOHLCMap(marketSheet) {
  const lastCol = marketSheet.getLastColumn();
  const lastRow = marketSheet.getLastRow();
  if (lastCol < 2 || lastRow < 2) return {};

  const todayStr = getDayIST();
  const headers = marketSheet.getRange(1, 2, 1, lastCol - 1).getValues()[0];

  // Find columns with today's timestamps
  const todayCols = [];
  headers.forEach((h, idx) => {
    if (!h) return;
    const d = h instanceof Date ? h : new Date(h);
    if (isNaN(d.getTime())) return;
    const hdrStr = Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
    if (hdrStr === todayStr) todayCols.push(idx + 1); // idx+1 = 1-indexed offset within the read range
  });

  if (todayCols.length === 0) return {};

  // Read all data in one batch
  const allData = marketSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  const ohlcMap = {};
  for (let r = 0; r < allData.length; r++) {
    const sym = String(allData[r][0] || '').trim();
    if (!sym) continue;

    const prices = [];
    for (let c = 0; c < todayCols.length; c++) {
      const val = allData[r][todayCols[c]]; // todayCols[c] is 1-indexed offset (col A = 0)
      if (val !== '' && !isNaN(val) && Number(val) > 0) prices.push(Number(val));
    }

    if (prices.length >= 2) {
      let hi = prices[0], lo = prices[0];
      for (let i = 1; i < prices.length; i++) {
        if (prices[i] > hi) hi = prices[i];
        if (prices[i] < lo) lo = prices[i];
      }
      ohlcMap[sym] = { open: prices[0], high: hi, low: lo, close: prices[prices.length - 1] };
    } else if (prices.length === 1) {
      ohlcMap[sym] = { open: prices[0], high: prices[0], low: prices[0], close: prices[0] };
    }
  }
  return ohlcMap;
}

// ─── EXTRACT OHLC ─────────────────────────────────────────────────────────────
function extractMarketData(allData, market, intradayOHLC) {
  const symIdx=0, cIdx=market.closeCol-1, oIdx=market.openCol-1, hIdx=market.highCol-1, lIdx=market.lowCol-1;
  const symbols=[], ohlcData=[];

  for (let r = 1; r < allData.length; r++) {
    const row = allData[r];
    const sym = row.length > symIdx ? String(row[symIdx] || '').trim() : '';
    if (!sym) continue;

    const closeStr = row.length > cIdx ? String(row[cIdx] || '').trim() : '';
    if (badValues.includes(closeStr)) continue;
    const close = Number(closeStr);
    if (isNaN(close) || close <= 0) continue;

    let open, high, low;

    // For intraday markets, prefer OHLC computed from actual snapshots
    const snap = intradayOHLC && intradayOHLC[sym];
    if (snap) {
      open  = snap.open;
      high  = snap.high;
      low   = snap.low;
      close = snap.close;
    } else {
      const openStr = row.length > oIdx ? String(row[oIdx] || '').trim() : '';
      const highStr = row.length > hIdx ? String(row[hIdx] || '').trim() : '';
      const lowStr  = row.length > lIdx ? String(row[lIdx] || '').trim() : '';
      open  = (openStr && !badValues.includes(openStr))  ? Number(openStr)  : close;
      high  = (highStr && !badValues.includes(highStr))  ? Number(highStr)  : close;
      low   = (lowStr  && !badValues.includes(lowStr))   ? Number(lowStr)   : close;
    }

    const safe = v => isNaN(v) ? close : v;
    const ohlcStr = [close, safe(open), safe(high), safe(low)].map(v => v.toFixed(2)).join(',');
    symbols.push(sym);
    ohlcData.push(ohlcStr);
  }
  return { symbols, ohlcData };
}

function processMarket(ss, market, allData, now) {
  const marketSheet = ss.getSheetByName(market.sheet);
  if (!marketSheet) return;

  // For intraday markets, compute OHLC from actual snapshots (avoids broken GOOGLEFINANCE high/low)
  const intradayOHLC = market.intraday ? getIntradayOHLCMap(marketSheet) : null;
  const { symbols, ohlcData } = extractMarketData(allData, market, intradayOHLC);
  if (!symbols.length) { console.log(`[MarketAI] ${market.name}: No valid data`); return; }

  syncSymbolColumn(marketSheet, symbols);
  const syncedSymbols = getSymbolColumn(marketSheet);
  if (!syncedSymbols.length) return;

  const ohlcMap = {};
  symbols.forEach((s, i) => { ohlcMap[s] = ohlcData[i]; });
  const ordered = syncedSymbols.map(s => ohlcMap[s] !== undefined ? ohlcMap[s] : '');

  appendPriceColumn(marketSheet, ordered, now);
  console.log(`[MarketAI] ${market.name}: OHLC written (${symbols.length} symbols)`);
}

// ─── SYMBOL COLUMN SYNC ──────────────────────────────────────────────────────
// Batch deletion: groups consecutive rows into contiguous ranges and deletes
// each range in a single Sheets API call instead of one call per row.
// For 2400+ rows this reduces API calls from O(n) to O(contiguous ranges).
function syncSymbolColumn(marketSheet, latestSymbols) {
  const lastRow = marketSheet.getLastRow();
  if (lastRow < 2) {
    marketSheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
    if (latestSymbols.length) marketSheet.getRange(2,1,latestSymbols.length,1).setValues(latestSymbols.map(s=>[s]));
    return;
  }
  const current = marketSheet.getRange(2,1,lastRow-1,1).getValues().map(r=>String(r[0]||'').trim());
  const latestSet = new Set(latestSymbols);

  // Collect rows to delete (1-indexed sheet rows, row 1 = header)
  const toDelete = [];
  for (let r = 0; r < current.length; r++) {
    if (current[r] && !latestSet.has(current[r])) toDelete.push(r + 2);
  }

  // Batch delete from bottom up: group consecutive rows into one deleteRows() call
  if (toDelete.length > 0) {
    toDelete.sort((a, b) => b - a);
    let i = 0;
    while (i < toDelete.length) {
      const endRow = toDelete[i];
      let startRow = endRow;
      while (i + 1 < toDelete.length && toDelete[i + 1] === startRow - 1) { i++; startRow = toDelete[i]; }
      marketSheet.deleteRows(startRow, endRow - startRow + 1);
      i++;
    }
  }

  // Compute remaining from original array (avoids re-reading the sheet)
  const deletedSet = new Set(toDelete.map(r => r - 2));
  const remaining = [];
  for (let i = 0; i < current.length; i++) { if (!deletedSet.has(i) && current[i]) remaining.push(current[i]); }
  const remainingSet = new Set(remaining);
  const toAdd = latestSymbols.filter(s => !remainingSet.has(s));
  if (toAdd.length) marketSheet.getRange(Math.max(marketSheet.getLastRow()+1,2),1,toAdd.length,1).setValues(toAdd.map(s=>[s]));
}

function getSymbolColumn(marketSheet) {
  const lastRow = marketSheet.getLastRow();
  return lastRow < 2 ? [] : marketSheet.getRange(2,1,lastRow-1,1).getValues().map(r=>String(r[0]||'').trim()).filter(s=>s.length);
}

function appendPriceColumn(marketSheet, priceValues, now) {
  if (!priceValues.length) return;
  const nextCol = marketSheet.getLastColumn() + 1;
  marketSheet.getRange(1, nextCol).setValue(now).setNumberFormat('dd/MM/yyyy HH:mm');
  marketSheet.getRange(2, nextCol, priceValues.length, 1).setValues(priceValues.map(s => [s === '' ? '' : s]));
}

// ─── CLEANUP ─────────────────────────────────────────────────────────────────
function dailyCleanup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CONFIG.KEEP_DAYS);
  cutoff.setHours(0, 0, 0, 0);

  CONFIG.MARKETS.forEach(market => {
    const sheet = ss.getSheetByName(market.sheet);
    if (!sheet) return;
    const lastCol = sheet.getLastColumn();
    if (lastCol < 2) return;
    const headers = sheet.getRange(1, 2, 1, lastCol - 1).getValues()[0];
    const toDelete = [];
    headers.forEach((h, idx) => {
      if (!h) return;
      const d = h instanceof Date ? h : new Date(h);
      if (!isNaN(d.getTime()) && d < cutoff) toDelete.push(idx + 2);
    });
    toDelete.sort((a, b) => b - a).forEach(col => sheet.deleteColumn(col));
    const actualLast = Math.max(1, sheet.getLastColumn());
    const maxCols = sheet.getMaxColumns();
    if (maxCols > actualLast) sheet.deleteColumns(actualLast + 1, maxCols - actualLast);
  });
}

// ─── SETUP ────────────────────────────────────────────────────────────────────
function setupMarketSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const symbolsSheet = ss.getSheetByName(CONFIG.SYMBOLS_SHEET);

  if (symbolsSheet) {
    const hdrLabels = ['SYMBOL'];
    CONFIG.MARKETS.forEach(m => {
      hdrLabels.push(m.name, m.name + '_OPEN', m.name + '_HIGH', m.name + '_LOW');
    });
    const hdrRange = symbolsSheet.getRange(1, 1, 1, hdrLabels.length);
    hdrRange.setValues([hdrLabels]);
    hdrRange.setFontWeight('bold');

    const lastRow = symbolsSheet.getLastRow();
    if (lastRow > 1) {
      const symValues = symbolsSheet.getRange(2, 1, lastRow - 1, 1).getValues();
      CONFIG.MARKETS.forEach(market => {
        const funcTypes = ['price', 'open', 'high', 'low'];
        funcTypes.forEach((ft, fi) => {
          const col = market.closeCol + fi;
          const formulas = symValues.map((r, ri) => {
            const rowNum = ri + 2;
            const sym = String(r[0] || '').trim();
            return sym ? [`=IF(A${rowNum}="","",GOOGLEFINANCE("${market.prefix}:"&A${rowNum},"${ft}"))`] : [''];
          });
          symbolsSheet.getRange(2, col, formulas.length, 1).setFormulas(formulas);
        });
      });
    }
  }

  CONFIG.MARKETS.forEach(market => {
    if (!ss.getSheetByName(market.sheet)) {
      const sheet = ss.insertSheet(market.sheet);
      sheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
    }
  });

  SpreadsheetApp.getUi().alert('✓ Market Sheets ready with GOOGLEFINANCE formulas');
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // 5-minute intraday trigger for NSE (Mon-Fri, 9:15-15:30 IST)
  ScriptApp.newTrigger('captureIntradaySnapshot')
    .timeBased()
    .everyMinutes(CONFIG.INTRADAY_INTERVAL_MINUTES)
    .create();

  // EOD triggers for all markets
  [{h: 11, m: 40}, {h: 12, m: 10}, {h: 13, m: 40}, {h: 15, m: 40}, {h: 21, m: 10}, {h: 2, m: 40}].forEach(t => {
    ScriptApp.newTrigger('logStockPrices').timeBased().atHour(t.h).nearMinute(t.m).everyDays(1).create();
  });

  ScriptApp.newTrigger('dailyCleanup').timeBased().atHour(0).nearMinute(30).everyDays(1).create();

  SpreadsheetApp.getUi().alert(
    '✓ Triggers set:\n' +
    '• Intraday: every 5 min (Mon-Fri 9:15-15:30 IST)\n' +
    '• EOD: 11:40 ASX · 12:10 JPX · 13:40 SGX/HKEX · 15:40 NSE · 21:10 LSE · 02:40 NASDAQ\n' +
    '• Cleanup: daily 00:30'
  );
}

function forceSnapshotNow() {
  captureIntradaySnapshot();
}

function forceCleanupNow() {
  dailyCleanup();
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('MarketAI')
    .addItem('1. Create Market Sheets', 'setupMarketSheets')
    .addItem('2. Setup Triggers', 'setupTriggers')
    .addSeparator()
    .addItem('Force Snapshot Now', 'forceSnapshotNow')
    .addItem('Force Cleanup Now', 'forceCleanupNow')
    .addToUi();
}
