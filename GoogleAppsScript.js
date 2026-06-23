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

function getFirebaseConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    projectId: props.getProperty('FIREBASE_PROJECT_ID') || '',
    apiKey:    props.getProperty('FIREBASE_API_KEY')    || '',
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

  const url = `https://firestore.googleapis.com/v1/projects/${fb.projectId}/databases/(default)/documents/${path}?key=${fb.apiKey}`;

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

  const url     = `https://firestore.googleapis.com/v1/projects/${fb.projectId}/databases/(default)/documents:batchWrite?key=${fb.apiKey}`;
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
      name:   `projects/${fb.projectId}/databases/(default)/documents/${path}`,
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
  const startTime = Date.now();
  const nowIST    = getTimeIST();
  const todayStr  = getDayIST();

  if (!isWeekday()) {
    console.log('[Firebase] Weekend — skipping Firebase upload');
    return;
  }

  console.log(`[Firebase] Starting EOD upload for ${todayStr} at ${nowIST}`);

  const fb = getFirebaseConfig();
  if (!fb.projectId || !fb.apiKey) {
    console.error('[Firebase] FIREBASE_PROJECT_ID and FIREBASE_API_KEY must be set in Script Properties');
    return;
  }

  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const nseSheet = ss.getSheetByName(CONFIG.NSE_SHEET);
  if (!nseSheet) { console.error('[Firebase] NSE sheet missing'); return; }

  const lastCol = nseSheet.getLastColumn();
  const lastRow = nseSheet.getLastRow();
  if (lastCol < 2 || lastRow < 2) {
    console.warn('[Firebase] NSE sheet has no data to upload');
    return;
  }

  // Read header row to find today's columns
  const headers    = nseSheet.getRange(1, 2, 1, lastCol - 1).getValues()[0];
  const todayCols  = [];  // 0-indexed within headers array (col B = headers[0])
  const colTsMap   = {};  // col-offset → timestamp ms

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

  if (todayCols.length === 0) {
    console.warn('[Firebase] No today columns found in NSE sheet');
    return;
  }

  console.log(`[Firebase] Found ${todayCols.length} minute snapshots for ${todayStr}`);

  // Read all data (symbols + today's columns only)
  // We batch-read to stay within Sheets API limits
  const symValues  = nseSheet.getRange(2, 1, lastRow - 1, 1).getValues().map(r => String(r[0] || '').trim());
  const allSymbols = symValues.filter(Boolean);

  // Build per-symbol minute bars { [sym]: [{ts, price}, ...] }
  const symbolBars  = {};
  const CHUNK_SIZE  = 500; // read this many rows at a time

  for (let rowStart = 0; rowStart < allSymbols.length; rowStart += CHUNK_SIZE) {
    const chunkSyms = allSymbols.slice(rowStart, rowStart + CHUNK_SIZE);
    const rowCount  = chunkSyms.length;

    // Read all today's columns for this chunk of rows
    // nseSheet row 2 = allSymbols[0], so sheet row = rowStart + 2
    const data = nseSheet.getRange(rowStart + 2, 2, rowCount, lastCol - 1).getValues();

    for (let r = 0; r < chunkSyms.length; r++) {
      const sym = chunkSyms[r];
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
  }

  const symbols = Object.keys(symbolBars);
  console.log(`[Firebase] Building payloads for ${symbols.length} symbols`);

  // Prepare Firestore batch writes (max 500 per batch)
  const BATCH_LIMIT = 400; // Stay under 500 Firestore limit
  let   writes      = [];
  let   batchCount  = 0;
  let   writeCount  = 0;

  function flushBatch() {
    if (writes.length === 0) return;
    const ok = firestoreBatchWrite(writes);
    console.log(`[Firebase] Batch ${++batchCount}: ${writes.length} writes → ${ok ? 'OK' : 'FAIL'}`);
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

    const fields = {
      symbol:        sym,
      date:          todayStr,
      open:          open,
      high:          high,
      low:           low,
      close:         close,
      snapshotCount: bars.length,
      syncedAt:      Date.now(),
      minuteBars:    bars,  // array of {ts, price}
    };

    writes.push(buildFirestoreWrite(`historicalData/${todayStr}/stocks/${sym}`, fields, fb));
    writeCount++;

    if (writes.length >= BATCH_LIMIT) flushBatch();
  }

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

    if (writes.length >= BATCH_LIMIT) flushBatch();
  }

  // 3. Stock index (master symbol list)
  writes.push(buildFirestoreWrite('stockIndex/master', {
    symbols:     symbols,
    count:       symbols.length,
    lastUpdated: Date.now(),
    lastDate:    todayStr,
  }, fb));
  writeCount++;

  // 4. Day metadata
  writes.push(buildFirestoreWrite(`intradaySnapshots/${todayStr}/metadata`, {
    date:          todayStr,
    snapshotCount: todayCols.length,
    symbolCount:   symbols.length,
    syncedAt:      Date.now(),
  }, fb));
  writeCount++;

  flushBatch(); // flush remaining

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Firebase] Upload complete: ${writeCount} docs, ${batchCount} batches, ${symbols.length} symbols in ${elapsed}s`);
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

// ─── SIMULATE PER-MINUTE DATA (testing) ─────────────────────────────────────
//
// Populates NSE sheet with realistic simulated per-minute prices for ALL
// symbols for the past N_DAYS days. Uses a random walk model.
// Run manually from MarketAI menu → "Simulate Data (Testing)".

function simulateMinuteData() {
  const N_DAYS              = 5;   // how many trading days to simulate
  const BARS_PER_DAY        = 75;  // ~75 minutes per NSE session (9:15–10:30, enough for testing)
  const VOLATILITY_PER_MIN  = 0.003; // 0.3% max move per minute
  const BASE_PRICE_MIN      = 50;
  const BASE_PRICE_MAX      = 3000;

  console.log(`[Simulate] Generating ${N_DAYS} days × ${BARS_PER_DAY} bars for all NSE symbols…`);
  const startTime = Date.now();

  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const nseSheet = ss.getSheetByName(CONFIG.NSE_SHEET);
  if (!nseSheet) { console.error('[Simulate] NSE sheet not found'); return; }

  const lastRow = nseSheet.getLastRow();
  if (lastRow < 2) { console.error('[Simulate] NSE sheet has no symbols (run "Create Market Sheets" first)'); return; }

  // Get existing symbols
  const symbols = nseSheet.getRange(2, 1, lastRow - 1, 1).getValues()
                          .map(r => String(r[0] || '').trim()).filter(Boolean);

  if (symbols.length === 0) { console.error('[Simulate] No symbols in NSE sheet'); return; }

  console.log(`[Simulate] Found ${symbols.length} symbols`);

  // Clear existing time-series columns
  const existingLastCol = nseSheet.getLastColumn();
  if (existingLastCol > 1) {
    nseSheet.deleteColumns(2, existingLastCol - 1);
  }

  // Build trading day timestamps going back N_DAYS from today
  const allTimestamps = [];
  const today         = new Date();

  for (let d = N_DAYS - 1; d >= 0; d--) {
    const dayDate = new Date(today);
    dayDate.setDate(today.getDate() - d);
    const weekday = dayDate.getDay();
    if (weekday === 0 || weekday === 6) continue; // skip weekends

    const dateStr = Utilities.formatDate(dayDate, CONFIG.TIMEZONE, 'yyyy-MM-dd');

    for (let m = 0; m < BARS_PER_DAY; m++) {
      const minOffset = m;
      const hour      = 9 + Math.floor((15 + minOffset) / 60);
      const minute    = (15 + minOffset) % 60;
      const ts        = new Date(`${dateStr}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00+05:30`);
      allTimestamps.push(ts);
    }
  }

  const totalCols = allTimestamps.length;
  console.log(`[Simulate] Total columns to write: ${totalCols}`);

  if (totalCols === 0) { console.error('[Simulate] No timestamps generated'); return; }

  // Write header row (timestamps)
  const headerRow = allTimestamps.map(ts => ts);
  nseSheet.getRange(1, 2, 1, totalCols).setValues([headerRow]).setNumberFormat('dd/MM/yyyy HH:mm');

  // Generate prices for all symbols using random walk
  // We write in column chunks to stay within Sheets API limits
  const WRITE_CHUNK  = 50;  // columns per batch write
  const N            = symbols.length;

  // Initialize base prices per symbol (seeded from symbol string for consistency)
  const basePrices = symbols.map(sym => {
    let hash = 0;
    for (let i = 0; i < sym.length; i++) hash = (hash * 31 + sym.charCodeAt(i)) & 0xffffffff;
    return BASE_PRICE_MIN + (Math.abs(hash) % (BASE_PRICE_MAX - BASE_PRICE_MIN));
  });

  // Generate all price data as a 2D array [symbol][colIndex]
  // We do this in column chunks
  let currentPrices = basePrices.slice(); // copy

  for (let colStart = 0; colStart < totalCols; colStart += WRITE_CHUNK) {
    const colEnd   = Math.min(colStart + WRITE_CHUNK, totalCols);
    const chunkLen = colEnd - colStart;

    // Build 2D array: rows = symbols, cols = this chunk's timestamps
    const chunk = [];
    for (let s = 0; s < N; s++) {
      chunk.push([]);
    }

    for (let c = 0; c < chunkLen; c++) {
      // Apply random walk to each symbol's price
      for (let s = 0; s < N; s++) {
        const move = 1 + (Math.random() * 2 - 1) * VOLATILITY_PER_MIN;
        currentPrices[s] = Math.max(1, currentPrices[s] * move);
        chunk[s].push(parseFloat(currentPrices[s].toFixed(2)));
      }
    }

    // Write this chunk
    nseSheet.getRange(2, colStart + 2, N, chunkLen).setValues(chunk);

    console.log(`[Simulate] Written cols ${colStart + 1}–${colEnd} of ${totalCols}`);
    SpreadsheetApp.flush(); // flush after each chunk to avoid timeouts
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Simulate] Done! ${symbols.length} symbols × ${totalCols} columns in ${elapsed}s`);
  SpreadsheetApp.getUi().alert(
    `✓ Simulation Complete!\n\n` +
    `• ${symbols.length} symbols\n` +
    `• ${N_DAYS} trading days\n` +
    `• ${BARS_PER_DAY} bars/day = ${totalCols} total columns\n` +
    `• Time taken: ${elapsed}s\n\n` +
    `You can now test the Firebase upload via: MarketAI → Force Firebase Upload Now`
  );
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
      CONFIG.MARKETS.forEach(market => {
        const funcTypes = ['price', 'open', 'high', 'low'];
        funcTypes.forEach((ft, fi) => {
          const col      = market.closeCol + fi;
          const formulas = symValues.map((r, ri) => {
            const rowNum = ri + 2;
            const sym    = String(r[0] || '').trim();
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

  // 2. Send to Firebase at 4:00 PM IST
  ScriptApp.newTrigger('sendToFirebase')
    .timeBased()
    .atHour(CONFIG.FIREBASE_SEND_HOUR_IST)
    .nearMinute(CONFIG.FIREBASE_SEND_MINUTE_IST)
    .everyDays(1)
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
    '• Firebase Upload: 4:00 PM IST daily\n' +
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

function forceSimulateData() {
  simulateMinuteData();
}

// ─── MENU ─────────────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('MarketAI')
    .addItem('1. Create Market Sheets',      'setupMarketSheets')
    .addItem('2. Setup Firebase Credentials','setupFirebaseCredentials')
    .addItem('3. Setup All Triggers',        'setupTriggers')
    .addSeparator()
    .addItem('📊 Simulate Data (Testing)',   'forceSimulateData')
    .addSeparator()
    .addItem('Force Snapshot Now',           'forceSnapshotNow')
    .addItem('Force Firebase Upload Now',    'forceFirebaseUploadNow')
    .addItem('Force Sheet Reset Now',        'forceResetSheetNow')
    .addItem('Force EOD Cleanup Now',        'forceCleanupNow')
    .addToUi();
}
