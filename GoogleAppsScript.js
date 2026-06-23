// ===============================================================================
//  MarketAI — Google Apps Script
//  Per-Minute Intraday Capture (NSE) + EOD OHLC (Other Markets)
//  Wide format: Col A = Symbols, Row 1 = Timestamps (dd/MM/yyyy HH:mm)
//
//  TRIGGERS (set via setupTriggers()):
//    captureIntradaySnapshot  → every 1 min (active during NSE market hours)
//    sendToFirebase           → 4:00 PM IST daily (upload day data to Firestore)
//    resetSheet               → 8:00 AM IST daily (clear NSE time-series columns)
//    logStockPrices           → various IST times (EOD OHLC for all markets)
//    dailyCleanup             → 00:30 IST daily (prune old columns)
//
//  FIREBASE CONFIG:
//    Set Script Properties (File → Project Properties → Script Properties):
//      FIREBASE_PROJECT_ID  → your-firebase-project-id
//      FIREBASE_API_KEY     → your-web-api-key
//      FIREBASE_AUTH_TOKEN  → (optional) service account token for elevated writes
// ===============================================================================

const CONFIG = {
  SYMBOLS_SHEET:              'SYMBOLS',
  NSE_SHEET:                  'NSE',
  TIMEZONE:                   'Asia/Kolkata',
  KEEP_DAYS:                  30,
  INTRADAY_INTERVAL_MINUTES:  1,           // per-minute capture
  NSE_MARKET_OPEN:            '09:15',
  NSE_MARKET_CLOSE:           '15:30',
  FIREBASE_SEND_HOUR_IST:     16,          // 4:00 PM IST
  FIREBASE_SEND_MINUTE_IST:   0,
  RESET_HOUR_IST:             8,           // 8:00 AM IST
  RESET_MINUTE_IST:           0,
  FIREBASE_BATCH_SIZE:        50,          // Number of symbols to upload in each run
  FIREBASE_BATCH_DELAY_MINUTES: 10,         // Delay of 10 mins between batches
  MARKETS: [
    { name: 'NSE',    sheet: 'NSE',    prefix: 'NSE',    closeCol: 2,  openCol: 3,  highCol: 4,  lowCol: 5,  runAfterIST: '15:35', intraday: true  },
    { name: 'NASDAQ', sheet: 'NASDAQ', prefix: 'NASDAQ', closeCol: 6,  openCol: 7,  highCol: 8,  lowCol: 9,  runAfterIST: '02:35', intraday: false },
    { name: 'LSE',    sheet: 'LSE',    prefix: 'LON',    closeCol: 10, openCol: 11, highCol: 12, lowCol: 13, runAfterIST: '21:05', intraday: false },
    { name: 'SGX',    sheet: 'SGX',    prefix: 'SGX',    closeCol: 14, openCol: 15, highCol: 16, lowCol: 17, runAfterIST: '13:35', intraday: false },
    { name: 'HKEX',   sheet: 'HKEX',  prefix: 'HKEX',   closeCol: 18, openCol: 19, highCol: 20, lowCol: 21, runAfterIST: '13:35', intraday: false },
    { name: 'JPX',    sheet: 'JPX',   prefix: 'TK2',    closeCol: 22, openCol: 23, highCol: 24, lowCol: 25, runAfterIST: '12:05', intraday: false },
    { name: 'ASX',    sheet: 'ASX',   prefix: 'ASX',    closeCol: 26, openCol: 27, highCol: 28, lowCol: 29, runAfterIST: '11:35', intraday: false },
  ],
};

const maxCol    = Math.max(...CONFIG.MARKETS.map(m => m.lowCol));
const badValues = ['#N/A', '#ERROR!', '#VALUE!', '#REF!', '#NUM!', 'Loading...', ''];

// ─── TIME HELPERS ────────────────────────────────────────────────────────────

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
  const now   = minutesSinceMidnight(getTimeIST());
  const open  = minutesSinceMidnight(CONFIG.NSE_MARKET_OPEN);
  const close = minutesSinceMidnight(CONFIG.NSE_MARKET_CLOSE);
  return now >= open && now <= close;
}

function isWeekday() {
  // Use IST date to check weekday
  const dateIST = new Date(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd'));
  const day = new Date(dateIST.getUTCFullYear(), dateIST.getUTCMonth(), dateIST.getUTCDate()).getDay();
  return day >= 1 && day <= 5;
}

function lastSnapshotMinutesAgo(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 2) return 99;
  const header = sheet.getRange(1, lastCol).getValue();
  if (!header) return 99;
  const d = header instanceof Date ? header : new Date(header);
  if (isNaN(d.getTime())) return 99;
  return (Date.now() - d.getTime()) / 60000;
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
  return getDayIST() === Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

// ─── FIREBASE HELPERS ────────────────────────────────────────────────────────
// Auto-configured from Firebase CLI (project: argen0, db: default, region: eur3)

const FIREBASE_PROJECT_ID = 'argen0';
const FIREBASE_API_KEY    = 'AIzaSyBv3vXMpMWhm3Y672LyAyrsjtO8edvXVp0';
const FIREBASE_DB_NAME    = 'default'; // database is named 'default' (not '(default)')

function getFirebaseConfig() {
  // Script Properties can override these defaults at runtime
  const props = PropertiesService.getScriptProperties();
  return {
    projectId: props.getProperty('FIREBASE_PROJECT_ID') || FIREBASE_PROJECT_ID,
    apiKey:    props.getProperty('FIREBASE_API_KEY')    || FIREBASE_API_KEY,
    dbName:    props.getProperty('FIREBASE_DB_NAME')    || FIREBASE_DB_NAME,
    authToken: props.getProperty('FIREBASE_AUTH_TOKEN') || '',
  };
}

/**
 * Write a document to Firestore via REST API.
 * path example: "historicalData/2026-06-23/stocks/RELIANCE"
 */
function firestoreSet(path, fields) {
  const fb = getFirebaseConfig();
  if (!fb.projectId || !fb.apiKey) {
    console.warn('[Firebase] No credentials configured — skipping Firestore write');
    return false;
  }

  const url = `https://firestore.googleapis.com/v1/projects/${fb.projectId}/databases/${fb.dbName}/documents/${path}?key=${fb.apiKey}`;

  const payload = { fields: toFirestoreFields(fields) };
  const options = {
    method:             'PATCH',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  if (fb.authToken) {
    options.headers = { Authorization: `Bearer ${fb.authToken}` };
  }

  try {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) return true;
    console.error(`[Firebase] PATCH ${path} → HTTP ${code}: ${resp.getContentText().slice(0, 200)}`);
    return false;
  } catch (e) {
    console.error(`[Firebase] fetch error for ${path}: ${e.message}`);
    return false;
  }
}

/**
 * Convert a plain JS object into Firestore field format.
 * Supports: string, number, boolean, null, array (of primitives), object (nested map).
 */
function toFirestoreFields(obj) {
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    result[key] = toFirestoreValue(val);
  }
  return result;
}

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean')          return { booleanValue: val };
  if (typeof val === 'number')           return { doubleValue: val };
  if (typeof val === 'string')           return { stringValue: val };
  if (Array.isArray(val)) {
    return {
      arrayValue: {
        values: val.map(v => toFirestoreValue(v))
      }
    };
  }
  if (typeof val === 'object') {
    return {
      mapValue: { fields: toFirestoreFields(val) }
    };
  }
  return { stringValue: String(val) };
}

/**
 * Batch write to Firestore using the batchWrite endpoint.
 * Writes up to 500 documents per batch (Firestore limit).
 */
function firestoreBatchWrite(writes) {
  const fb = getFirebaseConfig();
  if (!fb.projectId || !fb.apiKey) return false;

  const url     = `https://firestore.googleapis.com/v1/projects/${fb.projectId}/databases/${fb.dbName}/documents:batchWrite?key=${fb.apiKey}`;
  const options = {
    method:             'POST',
    contentType:        'application/json',
    muteHttpExceptions: true,
    payload:            JSON.stringify({ writes }),
  };
  if (fb.authToken) options.headers = { Authorization: `Bearer ${fb.authToken}` };

  try {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) return true;
    console.error(`[Firebase] batchWrite → HTTP ${code}: ${resp.getContentText().slice(0, 300)}`);
    return false;
  } catch (e) {
    console.error(`[Firebase] batchWrite error: ${e.message}`);
    return false;
  }
}

/**
 * Build a Firestore write operation (UPSERT) for batchWrite.
 */
function buildFirestoreWrite(path, fields, fb) {
  return {
    update: {
      name:   `projects/${fb.projectId}/databases/${fb.dbName}/documents/${path}`,
      fields: toFirestoreFields(fields),
    },
  };
}

// ─── MAIN INTRADAY TRIGGER (runs every 1 min) ────────────────────────────────

function captureIntradaySnapshot() {
  const startTime = Date.now();
  const nowStr    = getNowISTStr();

  if (!isWeekday()) {
    console.log(`[MarketAI] Weekend — skipping intraday`);
    return;
  }

  if (!isMarketHours()) {
    console.log(`[MarketAI] Outside NSE hours (${getTimeIST()}) — skipping`);
    return;
  }

  console.log(`[MarketAI] Intraday snapshot at ${nowStr}`);

  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const symbolsSheet = ss.getSheetByName(CONFIG.SYMBOLS_SHEET);
  if (!symbolsSheet) { console.warn('[MarketAI] SYMBOLS sheet missing'); return; }

  const lastRow = symbolsSheet.getLastRow();
  if (lastRow < 2) { console.warn('[MarketAI] SYMBOLS sheet empty'); return; }

  const nseConfig = CONFIG.MARKETS.find(m => m.name === 'NSE');
  if (!nseConfig) return;

  const nseSheet = ss.getSheetByName(nseConfig.sheet);
  if (!nseSheet) { console.warn('[MarketAI] NSE sheet missing'); return; }

  // Guard: skip if last snapshot was less than 1 min ago
  const minsAgo = lastSnapshotMinutesAgo(nseSheet);
  if (minsAgo < CONFIG.INTRADAY_INTERVAL_MINUTES) {
    console.log(`[MarketAI] Last snapshot ${Math.round(minsAgo * 100) / 100}m ago — skipping`);
    return;
  }

  // Read all symbols and their GOOGLEFINANCE close prices
  const allData = symbolsSheet.getRange(1, 1, lastRow, maxCol).getValues();

  // Sync symbol column in NSE sheet
  syncSymbolColumn(nseSheet, allData.slice(1).map(r => String(r[0] || '').trim()).filter(Boolean));
  const syncedSymbols = getSymbolColumn(nseSheet);
  if (!syncedSymbols.length) return;

  // Build symbol → price map from SYMBOLS sheet close column
  const priceMap  = {};
  const closeIdx  = nseConfig.closeCol - 1;
  for (let r = 1; r < allData.length; r++) {
    const row     = allData[r];
    const sym     = String(row[0] || '').trim();
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

  // Append new column with timestamp header
  const orderedPrices = syncedSymbols.map(s => priceMap[s] !== undefined ? priceMap[s] : '');
  const now           = new Date();
  const nextCol       = nseSheet.getLastColumn() + 1;
  nseSheet.getRange(1, nextCol).setValue(now).setNumberFormat('dd/MM/yyyy HH:mm');
  nseSheet.getRange(2, nextCol, orderedPrices.length, 1)
          .setValues(orderedPrices.map(v => [v === '' ? '' : v]));

  console.log(`[MarketAI] Snapshot written: ${Object.keys(priceMap).length} prices at ${nowStr} (col ${nextCol}) in ${(Date.now() - startTime) / 1000}s`);
}

// ─── SEND TO FIREBASE (4:00 PM IST trigger) ──────────────────────────────────
//
// Reads all today's per-minute columns from NSE sheet, builds per-symbol
// OHLC + minute-bar arrays, and batch-writes to Firestore:
//   /historicalData/{date}/stocks/{symbol}
//   /stocks/{symbol}                        (latest price index)
//   /stockIndex/master                      (symbol list)

function sendToFirebase() {
  const todayStr = getDayIST();
  console.log(`[Firebase] Manually initializing batched upload for ${todayStr}...`);

  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('FB_BATCH_COMPLETE'); // clear completion flag so we can force rerun
  props.setProperty('FB_BATCH_OFFSET', '0');
  props.setProperty('FB_BATCH_DATE', todayStr);

  executeFirebaseBatchPeriodic(todayStr, props);
}

/**
 * Periodically called (every 10 min) to upload EOD data.
 * Checks time (after 4 PM IST), weekday status, same/unchanged data, and runs chunk.
 */
function sendToFirebaseBatchPeriodic() {
  if (!isWeekday()) {
    console.log('[Firebase] Periodic Sync: Weekend — skipping');
    return;
  }

  // Check if it is past 4:00 PM IST (16:00)
  const timeIST = getTimeIST();
  const [h, m] = timeIST.split(':').map(Number);
  const minutes = h * 60 + m;
  const fourPm = 16 * 60; // 16:00 IST

  if (minutes < fourPm) {
    console.log(`[Firebase] Periodic Sync: Outside sync hours (${timeIST}) — skipping`);
    return;
  }

  const todayStr = getDayIST();
  const props    = PropertiesService.getScriptProperties();

  // If today's upload is already complete, exit
  if (props.getProperty('FB_BATCH_COMPLETE') === todayStr) {
    return;
  }

  // Otherwise, run the batch upload
  executeFirebaseBatchPeriodic(todayStr, props);
}

/**
 * Executes a single batch upload chunk.
 */
function executeFirebaseBatchPeriodic(todayStr, props) {
  const startTime = Date.now();

  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const nseSheet = ss.getSheetByName(CONFIG.NSE_SHEET);
  if (!nseSheet) { console.error('[Firebase] NSE sheet missing'); return; }

  const lastCol = nseSheet.getLastColumn();
  const lastRow = nseSheet.getLastRow();
  if (lastCol < 2 || lastRow < 2) {
    console.warn('[Firebase] NSE sheet has no data to upload');
    return;
  }

  // Find today's columns
  const headers   = nseSheet.getRange(1, 2, 1, lastCol - 1).getValues()[0];
  const todayCols = [];
  const colTsMap  = {};

  headers.forEach((h, idx) => {
    if (!h) return;
    const d = h instanceof Date ? h : new Date(h);
    if (isNaN(d.getTime())) return;
    const dayStr = Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
    if (dayStr === todayStr) {
      todayCols.push(idx);
      colTsMap[idx] = d.getTime();
    }
  });

  // If no columns recorded for today (no new data or holiday), skip EOD upload completely
  if (todayCols.length === 0) {
    console.log(`[Firebase] No new columns captured today. Skipping EOD upload for ${todayStr}.`);
    props.setProperty('FB_BATCH_COMPLETE', todayStr);
    return;
  }

  // Initialize or resume batch run
  let batchDate = props.getProperty('FB_BATCH_DATE');
  let offset = 0;

  if (batchDate !== todayStr) {
    props.setProperty('FB_BATCH_DATE', todayStr);
    props.setProperty('FB_BATCH_OFFSET', '0');
    offset = 0;
  } else {
    offset = Number(props.getProperty('FB_BATCH_OFFSET') || '0');
  }

  const symValues  = nseSheet.getRange(2, 1, lastRow - 1, 1).getValues().map(r => String(r[0] || '').trim());
  const allSymbols = symValues.filter(Boolean);
  const BATCH_SIZE = CONFIG.FIREBASE_BATCH_SIZE;

  if (offset >= allSymbols.length) {
    console.log(`[Firebase] All symbols already uploaded. Finalizing.`);
    finalizeFirebaseUpload(todayStr, todayCols.length, allSymbols.length, props);
    return;
  }

  const batchSymbols = allSymbols.slice(offset, offset + BATCH_SIZE);
  console.log(`[Firebase] Processing batch: symbols ${offset} to ${offset + batchSymbols.length} of ${allSymbols.length}`);

  // Build per-symbol minute bars for this batch
  const symbolBars = {};
  const data = nseSheet.getRange(offset + 2, 2, batchSymbols.length, lastCol - 1).getValues();

  for (let r = 0; r < batchSymbols.length; r++) {
    const sym = batchSymbols[r];
    if (!sym) continue;
    const bars = [];
    for (const colOffset of todayCols) {
      const val = data[r][colOffset];
      if (val !== '' && !isNaN(val) && Number(val) > 0) {
        bars.push({ ts: colTsMap[colOffset], price: Number(val) });
      }
    }
    if (bars.length > 0) symbolBars[sym] = bars;
  }

  const symbols = Object.keys(symbolBars);
  console.log(`[Firebase] Building payloads for ${symbols.length} symbols in this batch`);

  const fb = getFirebaseConfig();
  let writes = [];
  let writeCount = 0;
  let batchCount = 0;

  function flushBatch() {
    if (writes.length === 0) return;
    const ok = firestoreBatchWrite(writes);
    console.log(`[Firebase] REST Batch ${++batchCount}: ${writes.length} writes → ${ok ? 'OK' : 'FAIL'}`);
    writes = [];
  }

  // 1. Per-symbol daily document: historicalData/{date}/stocks/{symbol}
  for (const sym of symbols) {
    const bars  = symbolBars[sym];
    const prices = bars.map(b => b.price);
    const open   = prices[0];
    const close  = prices[prices.length - 1];
    let   high   = open, low = open;
    for (const p of prices) { if (p > high) high = p; if (p < low) low = p; }

    writes.push(buildFirestoreWrite(`historicalData/${todayStr}/stocks/${sym}`, {
      symbol:        sym,
      date:          todayStr,
      open:          open,
      high:          high,
      low:           low,
      close:         close,
      snapshotCount: bars.length,
      syncedAt:      Date.now(),
      minuteBars:    bars,
    }, fb));
    writeCount++;

    if (writes.length >= 100) flushBatch();
  }
  flushBatch();

  // 2. Latest price index: stocks/{symbol}
  for (const sym of symbols) {
    const bars   = symbolBars[sym];
    const prices = bars.map(b => b.price);
    const close  = prices[prices.length - 1];
    let   high   = prices[0], low = prices[0];
    for (const p of prices) { if (p > high) high = p; if (p < low) low = p; }

    writes.push(buildFirestoreWrite(`stocks/${sym}`, {
      symbol:      sym,
      lastPrice:   close,
      lastUpdated: Date.now(),
      todayDate:   todayStr,
      todayOpen:   prices[0],
      todayHigh:   high,
      todayLow:    low,
      todayClose:  close,
    }, fb));
    writeCount++;

    if (writes.length >= 400) flushBatch();
  }
  flushBatch();

  // Save new offset
  const nextOffset = offset + BATCH_SIZE;
  props.setProperty('FB_BATCH_OFFSET', String(nextOffset));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Firebase] Batch run complete. ${writeCount} docs processed in ${elapsed}s`);

  // If final batch, finalize immediately
  if (nextOffset >= allSymbols.length) {
    finalizeFirebaseUpload(todayStr, todayCols.length, allSymbols.length, props);
  }
}

/**
 * Finalizes the upload by writing metadata and pushing master symbols index.
 */
function finalizeFirebaseUpload(todayStr, snapshotCount, symbolCount, props) {
  console.log(`[Firebase] Finalizing upload for ${todayStr}...`);
  const fb = getFirebaseConfig();

  // Finalize master index
  pushSymbolIndexToFirebase();

  // Day metadata
  const metaWrites = [
    buildFirestoreWrite(`intradaySnapshots/${todayStr}/metadata`, {
      date:          todayStr,
      snapshotCount: snapshotCount,
      symbolCount:   symbolCount,
      syncedAt:      Date.now(),
    }, fb)
  ];
  firestoreBatchWrite(metaWrites);

  // Set today's run as complete
  props.setProperty('FB_BATCH_COMPLETE', todayStr);
  
  // Clean up batch properties
  props.deleteProperty('FB_BATCH_OFFSET');
  props.deleteProperty('FB_BATCH_DATE');
  console.log(`[Firebase] Batched upload fully completed for today.`);
}

// ─── RESET SHEET (8:00 AM IST trigger) ───────────────────────────────────────
//
// Clears all timestamp columns from NSE sheet (keeps Col A = symbols).
// This runs every morning before market open to give a fresh slate.

function resetSheet() {
  if (!isWeekday()) {
    console.log('[Reset] Weekend — skipping sheet reset');
    return;
  }

  console.log('[Reset] Starting morning sheet reset…');

  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const nseSheet = ss.getSheetByName(CONFIG.NSE_SHEET);
  if (!nseSheet) { console.warn('[Reset] NSE sheet not found'); return; }

  const lastCol = nseSheet.getLastColumn();
  if (lastCol <= 1) {
    console.log('[Reset] NSE sheet already has no time-series columns — nothing to do');
    return;
  }

  // Delete all columns B onwards (columns 2 → lastCol)
  // We delete from right to left to avoid index shifting
  const colsToDelete = lastCol - 1;
  if (colsToDelete > 0) {
    nseSheet.deleteColumns(2, colsToDelete);
  }

  console.log(`[Reset] Cleared ${colsToDelete} time-series columns from NSE sheet. Ready for new day.`);
  SpreadsheetApp.flush();
}



// ─── EOD TRIGGER (existing for all markets including NSE backup) ──────────────

function logStockPrices() {
  const now      = getNowIST();
  const nowIST   = getTimeIST();
  const startTime = Date.now();
  console.log(`[MarketAI EOD] Run at IST ${nowIST}`);

  const ss           = SpreadsheetApp.getActiveSpreadsheet();
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
      if (!market.intraday && hasWrittenToday(marketSheet)) continue;
      processMarket(ss, market, allData, now);
    } catch (e) {
      console.error(`[MarketAI] ${market.name} Error: ${e.message}`);
    }
  }
  console.log(`[MarketAI EOD] Completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

// ─── INTRADAY OHLC COMPUTATION ────────────────────────────────────────────────

function getIntradayOHLCMap(marketSheet) {
  const lastCol = marketSheet.getLastColumn();
  const lastRow = marketSheet.getLastRow();
  if (lastCol < 2 || lastRow < 2) return {};

  const todayStr = getDayIST();
  const headers  = marketSheet.getRange(1, 2, 1, lastCol - 1).getValues()[0];

  const todayCols = [];
  headers.forEach((h, idx) => {
    if (!h) return;
    const d = h instanceof Date ? h : new Date(h);
    if (isNaN(d.getTime())) return;
    const hdrStr = Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
    if (hdrStr === todayStr) todayCols.push(idx + 1);
  });

  if (todayCols.length === 0) return {};

  const allData = marketSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const ohlcMap = {};

  for (let r = 0; r < allData.length; r++) {
    const sym = String(allData[r][0] || '').trim();
    if (!sym) continue;

    const prices = [];
    for (let c = 0; c < todayCols.length; c++) {
      const val = allData[r][todayCols[c]];
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
  const symIdx = 0, cIdx = market.closeCol - 1, oIdx = market.openCol - 1, hIdx = market.highCol - 1, lIdx = market.lowCol - 1;
  const symbols = [], ohlcData = [];

  for (let r = 1; r < allData.length; r++) {
    const row = allData[r];
    const sym = row.length > symIdx ? String(row[symIdx] || '').trim() : '';
    if (!sym) continue;

    const closeStr = row.length > cIdx ? String(row[cIdx] || '').trim() : '';
    if (badValues.includes(closeStr)) continue;
    const close = Number(closeStr);
    if (isNaN(close) || close <= 0) continue;

    let open, high, low;

    const snap = intradayOHLC && intradayOHLC[sym];
    if (snap) {
      open  = snap.open;
      high  = snap.high;
      low   = snap.low;
    } else {
      const openStr = row.length > oIdx ? String(row[oIdx] || '').trim() : '';
      const highStr = row.length > hIdx ? String(row[hIdx] || '').trim() : '';
      const lowStr  = row.length > lIdx ? String(row[lIdx] || '').trim() : '';
      open  = (openStr && !badValues.includes(openStr)) ? Number(openStr) : close;
      high  = (highStr && !badValues.includes(highStr)) ? Number(highStr) : close;
      low   = (lowStr  && !badValues.includes(lowStr))  ? Number(lowStr)  : close;
    }

    const safe    = v => isNaN(v) ? close : v;
    const ohlcStr = [close, safe(open), safe(high), safe(low)].map(v => v.toFixed(2)).join(',');
    symbols.push(sym);
    ohlcData.push(ohlcStr);
  }
  return { symbols, ohlcData };
}

function processMarket(ss, market, allData, now) {
  const marketSheet = ss.getSheetByName(market.sheet);
  if (!marketSheet) return;

  const intradayOHLC        = market.intraday ? getIntradayOHLCMap(marketSheet) : null;
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

function syncSymbolColumn(marketSheet, latestSymbols) {
  const lastRow = marketSheet.getLastRow();
  if (lastRow < 2) {
    marketSheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
    if (latestSymbols.length) marketSheet.getRange(2, 1, latestSymbols.length, 1).setValues(latestSymbols.map(s => [s]));
    return;
  }
  const current    = marketSheet.getRange(2, 1, lastRow - 1, 1).getValues().map(r => String(r[0] || '').trim());
  const latestSet  = new Set(latestSymbols);

  const toDelete   = [];
  for (let r = 0; r < current.length; r++) {
    if (current[r] && !latestSet.has(current[r])) toDelete.push(r + 2);
  }

  if (toDelete.length > 0) {
    toDelete.sort((a, b) => b - a);
    let i = 0;
    while (i < toDelete.length) {
      const endRow   = toDelete[i];
      let   startRow = endRow;
      while (i + 1 < toDelete.length && toDelete[i + 1] === startRow - 1) { i++; startRow = toDelete[i]; }
      marketSheet.deleteRows(startRow, endRow - startRow + 1);
      i++;
    }
  }

  const deletedSet = new Set(toDelete.map(r => r - 2));
  const remaining  = [];
  for (let i = 0; i < current.length; i++) {
    if (!deletedSet.has(i) && current[i]) remaining.push(current[i]);
  }
  const remainingSet = new Set(remaining);
  const toAdd        = latestSymbols.filter(s => !remainingSet.has(s));
  if (toAdd.length) {
    marketSheet.getRange(Math.max(marketSheet.getLastRow() + 1, 2), 1, toAdd.length, 1)
               .setValues(toAdd.map(s => [s]));
  }
}

function getSymbolColumn(marketSheet) {
  const lastRow = marketSheet.getLastRow();
  return lastRow < 2
    ? []
    : marketSheet.getRange(2, 1, lastRow - 1, 1).getValues()
                 .map(r => String(r[0] || '').trim()).filter(s => s.length);
}

function appendPriceColumn(marketSheet, priceValues, now) {
  if (!priceValues.length) return;
  const nextCol = marketSheet.getLastColumn() + 1;
  marketSheet.getRange(1, nextCol).setValue(now).setNumberFormat('dd/MM/yyyy HH:mm');
  marketSheet.getRange(2, nextCol, priceValues.length, 1)
             .setValues(priceValues.map(s => [s === '' ? '' : s]));
}

// ─── CLEANUP ─────────────────────────────────────────────────────────────────

function dailyCleanup() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CONFIG.KEEP_DAYS);
  cutoff.setHours(0, 0, 0, 0);

  CONFIG.MARKETS.forEach(market => {
    const sheet = ss.getSheetByName(market.sheet);
    if (!sheet) return;
    const lastCol = sheet.getLastColumn();
    if (lastCol < 2) return;
    const headers  = sheet.getRange(1, 2, 1, lastCol - 1).getValues()[0];
    const toDelete = [];
    headers.forEach((h, idx) => {
      if (!h) return;
      const d = h instanceof Date ? h : new Date(h);
      if (!isNaN(d.getTime()) && d < cutoff) toDelete.push(idx + 2);
    });
    toDelete.sort((a, b) => b - a).forEach(col => sheet.deleteColumn(col));
    const actualLast = Math.max(1, sheet.getLastColumn());
    const maxCols    = sheet.getMaxColumns();
    if (maxCols > actualLast) sheet.deleteColumns(actualLast + 1, maxCols - actualLast);
  });
}

// ─── SETUP ────────────────────────────────────────────────────────────────────

function setupMarketSheets() {
  const ss           = SpreadsheetApp.getActiveSpreadsheet();
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
      const numCols   = hdrLabels.length - 1;
      const formulas2D = [];

      for (let ri = 0; ri < symValues.length; ri++) {
        const rowNum = ri + 2;
        const sym = String(symValues[ri][0] || '').trim();
        const rowFormulas = [];

        if (!sym) {
          for (let c = 0; c < numCols; c++) rowFormulas.push('');
        } else {
          CONFIG.MARKETS.forEach(market => {
            rowFormulas.push(`=IF(A${rowNum}="","",GOOGLEFINANCE("${market.prefix}:"&A${rowNum},"price"))`);
            rowFormulas.push(`=IF(A${rowNum}="","",GOOGLEFINANCE("${market.prefix}:"&A${rowNum},"open"))`);
            rowFormulas.push(`=IF(A${rowNum}="","",GOOGLEFINANCE("${market.prefix}:"&A${rowNum},"high"))`);
            rowFormulas.push(`=IF(A${rowNum}="","",GOOGLEFINANCE("${market.prefix}:"&A${rowNum},"low"))`);
          });
        }
        formulas2D.push(rowFormulas);
      }

      symbolsSheet.getRange(2, 2, formulas2D.length, numCols).setFormulas(formulas2D);
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

function setupFirebaseCredentials() {
  const ui = SpreadsheetApp.getUi();

  const projectIdResp = ui.prompt(
    'Firebase Setup (1/2)',
    'Enter your Firebase Project ID:',
    ui.ButtonSet.OK_CANCEL
  );
  if (projectIdResp.getSelectedButton() !== ui.Button.OK) return;

  const apiKeyResp = ui.prompt(
    'Firebase Setup (2/2)',
    'Enter your Firebase Web API Key:',
    ui.ButtonSet.OK_CANCEL
  );
  if (apiKeyResp.getSelectedButton() !== ui.Button.OK) return;

  const props = PropertiesService.getScriptProperties();
  props.setProperty('FIREBASE_PROJECT_ID', projectIdResp.getResponseText().trim());
  props.setProperty('FIREBASE_API_KEY',    apiKeyResp.getResponseText().trim());

  ui.alert(
    '✓ Firebase credentials saved!\n\n' +
    'Project ID: ' + projectIdResp.getResponseText().trim() + '\n\n' +
    'These are stored securely in Script Properties (not in code or git).\n\n' +
    'Test by running: MarketAI → Force Firebase Upload Now'
  );
}

function setupTriggers() {
  // Remove all existing triggers
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // 1. Per-minute intraday capture (NSE 9:15–15:30 IST)
  ScriptApp.newTrigger('captureIntradaySnapshot')
    .timeBased()
    .everyMinutes(CONFIG.INTRADAY_INTERVAL_MINUTES)
    .create();

  // 2. Send to Firebase (runs every 10 minutes, uploads after 4:00 PM IST)
  ScriptApp.newTrigger('sendToFirebaseBatchPeriodic')
    .timeBased()
    .everyMinutes(10)
    .create();

  // 3. Reset sheet at 8:00 AM IST
  ScriptApp.newTrigger('resetSheet')
    .timeBased()
    .atHour(CONFIG.RESET_HOUR_IST)
    .nearMinute(CONFIG.RESET_MINUTE_IST)
    .everyDays(1)
    .create();

  // 4. EOD triggers for all markets
  [
    { h: 11, m: 40 },  // ASX
    { h: 12, m: 10 },  // JPX
    { h: 13, m: 40 },  // SGX / HKEX
    { h: 15, m: 40 },  // NSE
    { h: 21, m: 10 },  // LSE
    { h: 2,  m: 40 },  // NASDAQ
  ].forEach(t => {
    ScriptApp.newTrigger('logStockPrices')
      .timeBased().atHour(t.h).nearMinute(t.m).everyDays(1).create();
  });

  // 5. Daily cleanup at 00:30 IST
  ScriptApp.newTrigger('dailyCleanup')
    .timeBased().atHour(0).nearMinute(30).everyDays(1).create();

  SpreadsheetApp.getUi().alert(
    '✓ All Triggers Set:\n\n' +
    '• Intraday (NSE): every 1 min (Mon–Fri 9:15–15:30 IST)\n' +
    '• Firebase Upload: every 10 min (runs after 4:00 PM IST)\n' +
    '• Sheet Reset:    8:00 AM IST daily\n' +
    '• EOD (ASX):      11:40 IST\n' +
    '• EOD (JPX):      12:10 IST\n' +
    '• EOD (SGX/HKEX): 13:40 IST\n' +
    '• EOD (NSE):      15:40 IST\n' +
    '• EOD (LSE):      21:10 IST\n' +
    '• EOD (NASDAQ):   02:40 IST\n' +
    '• Cleanup:        00:30 IST daily\n'
  );
}

// ─── FORCE / MANUAL HELPERS ───────────────────────────────────────────────────

function forceSnapshotNow() {
  captureIntradaySnapshot();
  SpreadsheetApp.getUi().alert('Snapshot captured (check logs for details).');
}

function forceFirebaseUploadNow() {
  sendToFirebase();
  SpreadsheetApp.getUi().alert('Firebase upload triggered (check logs for details).');
}

function forceResetSheetNow() {
  const ui   = SpreadsheetApp.getUi();
  const resp = ui.alert(
    '⚠️ Confirm Sheet Reset',
    'This will delete ALL time-series columns from the NSE sheet.\nThis action cannot be undone.\n\nContinue?',
    ui.ButtonSet.YES_NO
  );
  if (resp === ui.Button.YES) {
    resetSheet();
    ui.alert('✓ NSE sheet reset complete.');
  }
}

function forceCleanupNow() {
  dailyCleanup();
}



// ─── FULL SETUP (run this once — does everything) ─────────────────────────────
//
// This is the SINGLE function to run when setting up the system fresh.
// It will:
//  1. Create all market sheets and add GOOGLEFINANCE formulas
//  2. Delete all existing triggers and set up all new ones
//  3. Capture an immediate intraday snapshot (if market is open)
//  4. Push current data to Firebase
//  5. Show a summary of what was done

function fullSetup() {
  const ui        = SpreadsheetApp.getUi();
  const log       = [];
  const startTime = Date.now();

  log.push('🚀 MarketAI Full Setup Starting...\n');



  // ── Step 2: Delete all triggers → set up fresh ────────────────────────────
  try {
    const existing = ScriptApp.getProjectTriggers();
    existing.forEach(t => ScriptApp.deleteTrigger(t));
    log.push(`✓ Cleared ${existing.length} old trigger(s)`);

    // Clear batch state properties to ensure clean slate
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty('FB_BATCH_OFFSET');
    props.deleteProperty('FB_BATCH_DATE');
    props.deleteProperty('FB_BATCH_COMPLETE');

    // Per-minute intraday
    ScriptApp.newTrigger('captureIntradaySnapshot').timeBased()
      .everyMinutes(CONFIG.INTRADAY_INTERVAL_MINUTES).create();

    // Firebase upload periodic trigger
    ScriptApp.newTrigger('sendToFirebaseBatchPeriodic').timeBased()
      .everyMinutes(10).create();

    // Sheet reset at 8 AM IST
    ScriptApp.newTrigger('resetSheet').timeBased()
      .atHour(CONFIG.RESET_HOUR_IST).nearMinute(CONFIG.RESET_MINUTE_IST)
      .everyDays(1).create();

    // EOD triggers
    [{h:11,m:40},{h:12,m:10},{h:13,m:40},{h:15,m:40},{h:21,m:10},{h:2,m:40}].forEach(t => {
      ScriptApp.newTrigger('logStockPrices').timeBased()
        .atHour(t.h).nearMinute(t.m).everyDays(1).create();
    });

    // Daily cleanup
    ScriptApp.newTrigger('dailyCleanup').timeBased()
      .atHour(0).nearMinute(30).everyDays(1).create();

    log.push('✓ Triggers set: 1-min capture | 10-min Firebase | 8AM reset | EOD | cleanup');
  } catch (e) {
    log.push(`✗ Trigger setup error: ${e.message}`);
  }





  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.push(`\n⏱ Completed in ${elapsed}s`);

  ui.alert(
    '✅ MarketAI — Full Setup Complete',
    log.join('\n'),
    ui.ButtonSet.OK
  );
}

// ─── PUSH SYMBOL INDEX TO FIREBASE ───────────────────────────────────────────
// Writes the master symbol list to /stockIndex/master in Firestore.
// Called by fullSetup() and can also be run standalone.

function pushSymbolIndexToFirebase() {
  const fb = getFirebaseConfig();
  if (!fb.projectId || !fb.apiKey) return;

  const ss           = SpreadsheetApp.getActiveSpreadsheet();
  const symbolsSheet = ss.getSheetByName(CONFIG.SYMBOLS_SHEET);
  if (!symbolsSheet || symbolsSheet.getLastRow() < 2) return;

  const symbols = symbolsSheet.getRange(2, 1, symbolsSheet.getLastRow() - 1, 1)
    .getValues().map(r => String(r[0] || '').trim()).filter(Boolean);

  const path = `stockIndex/master`;
  firestoreSet(path, {
    symbols:     symbols,
    count:       symbols.length,
    lastUpdated: Date.now(),
    lastDate:    getDayIST(),
  });
  console.log(`[Firebase] Symbol index pushed: ${symbols.length} symbols`);
}

// ─── FETCH TODAY'S DATA FROM SHEETS (for API / web-app use) ──────────────────
// Returns the latest per-minute prices from the NSE sheet for TODAY only.
// Used by the dashboard to get live intraday data.

function getTodayDataFromSheets() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const nseSheet = ss.getSheetByName(CONFIG.NSE_SHEET);
  if (!nseSheet || nseSheet.getLastColumn() < 2) return { date: getDayIST(), snapshots: [], symbols: [] };

  const todayStr = getDayIST();
  const lastCol  = nseSheet.getLastColumn();
  const lastRow  = nseSheet.getLastRow();
  const headers  = nseSheet.getRange(1, 2, 1, lastCol - 1).getValues()[0];

  // Find today's columns
  const todayCols = [];
  const colTs     = {};
  const colLabels = {};
  headers.forEach((h, idx) => {
    if (!h) return;
    const d = h instanceof Date ? h : new Date(h);
    if (isNaN(d.getTime())) return;
    const dayStr = Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
    if (dayStr === todayStr) {
      todayCols.push(idx);
      colTs[idx]     = d.getTime();
      colLabels[idx] = Utilities.formatDate(d, CONFIG.TIMEZONE, 'HH:mm');
    }
  });

  if (todayCols.length === 0) return { date: todayStr, snapshots: [], symbols: [] };

  // Read all symbols
  const symValues = nseSheet.getRange(2, 1, lastRow - 1, 1).getValues()
    .map(r => String(r[0] || '').trim());
  const symbols   = symValues.filter(Boolean);

  // Build snapshots: [{ts, label, prices: {SYM: price}}]
  const snapshots = todayCols.map(colIdx => ({ ts: colTs[colIdx], label: colLabels[colIdx], prices: {} }));

  // Read all today's price data in one batch
  const allData = nseSheet.getRange(2, 2, lastRow - 1, lastCol - 1).getValues();
  for (let r = 0; r < symValues.length; r++) {
    const sym = symValues[r];
    if (!sym) continue;
    for (let i = 0; i < todayCols.length; i++) {
      const val = allData[r][todayCols[i]];
      if (val !== '' && !isNaN(val) && Number(val) > 0) {
        snapshots[i].prices[sym] = Number(val);
      }
    }
  }

  return {
    date:      todayStr,
    snapshots: snapshots.filter(s => Object.keys(s.prices).length > 0),
    symbols,
  };
}

// ─── doGet — Web App endpoint (optional, deploy as web app for API access) ────
// Deploy this script as a Web App (Execute as: Me, Who has access: Anyone)
// Then your frontend can call:
//   GET <webapp-url>?action=today   → today's Sheets data (live)
//   GET <webapp-url>?action=ping    → health check
//
// Historical data comes directly from Firebase via /api/firebase on Vercel.

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'ping';

  if (action === 'ping') {
    return ContentService.createTextOutput(JSON.stringify({
      ok:        true,
      time:      getNowISTStr(),
      marketOpen: isMarketHours() && isWeekday(),
    })).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'today') {
    try {
      const data = getTodayDataFromSheets();
      return ContentService.createTextOutput(JSON.stringify({
        ok:   true,
        data,
      })).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false, error: err.message,
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  return ContentService.createTextOutput(JSON.stringify({
    ok: false, error: 'Unknown action. Use: ping, today',
  })).setMimeType(ContentService.MimeType.JSON);
}

// ─── MENU ─────────────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('MarketAI')
    .addItem('🚀 Full Setup (Run This First!)', 'fullSetup')

    .addSeparator()
    .addItem('Force Snapshot Now',              'forceSnapshotNow')
    .addItem('Force Firebase Upload Now',       'forceFirebaseUploadNow')
    .addItem('Force Sheet Reset Now',           'forceResetSheetNow')
    .addItem('Force EOD Cleanup Now',           'forceCleanupNow')
    .addSeparator()
    .addItem('Advanced: Setup Sheets Only',     'setupMarketSheets')
    .addItem('Advanced: Setup Triggers Only',   'setupTriggers')
    .addItem('Advanced: Push Symbol Index',     'pushSymbolIndexToFirebase')
    .addToUi();
}
