// ===============================================================================
//  MarketAI — Google Apps Script  (FIXED FINAL)
//  Multi-Market | Cloudflare D1 | Auto Symbol Sync
//
//  SYMBOLS sheet — NO header row, data starts row 1:
//    Col A/B  = NSE    symbols/prices
//    Col C/D  = NASDAQ symbols/prices
//    Col E/F  = LSE    symbols/prices
//    Col G/H  = SGX    symbols/prices
//    Col I/J  = HKEX   symbols/prices
//    Col K/L  = JPX    symbols/prices
//    Col M/N  = ASX    symbols/prices
//
//  Per-market sheet (e.g. "NSE"):
//    Row 1 col A  = "Symbol" header
//    Row 1 col B+ = timestamp headers
//    Col A rows 2+= symbol names (auto-synced)
//    Col B+ rows 2+= price snapshots
//
//  First time: MarketAI menu → Create Market Sheets → Setup Trigger
// ===============================================================================

const CONFIG = {
  SYMBOLS_SHEET: 'SYMBOLS',
  CLOUDFLARE_WORKER_URL: 'https://your-worker.your-subdomain.workers.dev',
  TIMEZONE: 'Asia/Kolkata',
  MAX_DAYS_IN_SHEET: 18,

  MARKETS: [
    { name:'NSE',    sheet:'NSE',    symbolCol:1,  priceCol:2,  openHour:9,  openMin:15, closeHour:15, closeMin:30 },
    { name:'NASDAQ', sheet:'NASDAQ', symbolCol:3,  priceCol:4,  openHour:19, openMin:30, closeHour:2,  closeMin:0  },
    { name:'LSE',    sheet:'LSE',    symbolCol:5,  priceCol:6,  openHour:13, openMin:30, closeHour:22, closeMin:0  },
    { name:'SGX',    sheet:'SGX',    symbolCol:7,  priceCol:8,  openHour:6,  openMin:30, closeHour:15, closeMin:0  },
    { name:'HKEX',   sheet:'HKEX',  symbolCol:9,  priceCol:10, openHour:5,  openMin:30, closeHour:12, closeMin:0  },
    { name:'JPX',    sheet:'JPX',   symbolCol:11, priceCol:12, openHour:5,  openMin:30, closeHour:12, closeMin:0  },
    { name:'ASX',    sheet:'ASX',   symbolCol:13, priceCol:14, openHour:4,  openMin:0,  closeHour:10, closeMin:0  },
  ],
};

// ─── MAIN ──────────────────────────────────────────────────────────────────────
function logStockPrices() {
  const now = getNowIST();
  console.log(`[MarketAI] ── Run at ${formatTime(now)} ──`);

  if (isWeekend(now)) { console.log('[MarketAI] Weekend — skip'); return; }

  const ss            = SpreadsheetApp.getActiveSpreadsheet();
  const symbolsSheet  = getSheet(ss, CONFIG.SYMBOLS_SHEET);
  if (!symbolsSheet)  return;

  const lastRow = symbolsSheet.getLastRow();
  const lastCol = symbolsSheet.getLastColumn();
  console.log(`[MarketAI] SYMBOLS: ${lastRow} rows, ${lastCol} cols`);

  if (lastRow < 1) { console.warn('[MarketAI] SYMBOLS empty'); return; }

  // Read entire SYMBOLS block once
  const readCols = Math.min(lastCol, 14);
  const allData  = symbolsSheet.getRange(1, 1, lastRow, readCols).getValues();
  console.log(`[MarketAI] Read ${allData.length} rows × ${readCols} cols`);

  for (const market of CONFIG.MARKETS) {
    try {
      processMarket(ss, market, allData, now);
    } catch (e) {
      console.error(`[MarketAI] ${market.name} error: ${e.message}\n${e.stack}`);
    }
  }
  console.log('[MarketAI] ── Run complete ──');
}

// ─── PROCESS ONE MARKET ────────────────────────────────────────────────────────
function processMarket(ss, market, allData, now) {
  if (!isMarketOpenNow(market, now)) {
    console.log(`[MarketAI] ${market.name}: closed`);
    return;
  }

  const marketSheet = getSheet(ss, market.sheet);
  if (!marketSheet) {
    console.error(`[MarketAI] ${market.name}: sheet missing — run Create Market Sheets`);
    return;
  }

  // FIX: start from row index 0 — SYMBOLS has no header row
  const { symbols, prices } = extractMarketData(allData, market);
  console.log(`[MarketAI] ${market.name}: ${symbols.length} symbols extracted`);

  if (symbols.length === 0) {
    console.warn(`[MarketAI] ${market.name}: col ${market.symbolCol} empty/out of range`);
    return;
  }

  syncSymbolColumn(marketSheet, symbols, market.name);

  const syncedSymbols = getSymbolColumn(marketSheet);
  if (syncedSymbols.length === 0) return;

  const priceBySymbol = {};
  symbols.forEach((s, i) => { priceBySymbol[s] = prices[i]; });
  const orderedPrices = syncedSymbols.map(s =>
    priceBySymbol[s] !== undefined ? priceBySymbol[s] : ''
  );

  if (pricesUnchanged(marketSheet, orderedPrices)) {
    console.log(`[MarketAI] ${market.name}: no change — skip`);
    return;
  }

  appendPriceColumn(marketSheet, orderedPrices, now, market.name);
  pushToCloudflare(market.name, syncedSymbols, orderedPrices, now);
  cleanupOldColumns(marketSheet, market.name);
}

// ─── EXTRACT ───────────────────────────────────────────────────────────────────
// KEY FIX: loop from r=0 (no header row in SYMBOLS sheet)
function extractMarketData(allData, market) {
  const symIdx   = market.symbolCol - 1;
  const priceIdx = market.priceCol  - 1;
  const symbols  = [];
  const prices   = [];

  for (let r = 0; r < allData.length; r++) {
    const row = allData[r];

    // Guard: row shorter than expected
    const rawSym = row.length > symIdx ? row[symIdx] : '';
    const sym    = String(rawSym === null || rawSym === undefined ? '' : rawSym).trim();
    if (!sym) continue;

    // Guard: price column might not exist
    const rawPrice = row.length > priceIdx ? row[priceIdx] : '';
    const priceStr = String(rawPrice === null || rawPrice === undefined ? '' : rawPrice).trim();

    // Skip GOOGLEFINANCE error values
    if (['#N/A','#ERROR!','#VALUE!','#REF!','#NUM!','Loading...'].includes(priceStr)) {
      console.log(`[MarketAI] ${market.name}: skip "${sym}" — "${priceStr}"`);
      continue;
    }

    const price = priceStr === '' ? '' : Number(priceStr);
    if (priceStr !== '' && isNaN(price)) {
      console.log(`[MarketAI] ${market.name}: skip "${sym}" — not numeric: "${priceStr}"`);
      continue;
    }

    symbols.push(sym);
    prices.push(price);
  }

  return { symbols, prices };
}

// ─── SYNC SYMBOL COLUMN ────────────────────────────────────────────────────────
function syncSymbolColumn(marketSheet, latestSymbols, marketName) {
  // Ensure header
  if (String(marketSheet.getRange(1, 1).getValue()).trim() !== 'Symbol') {
    marketSheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
  }

  const currentSymbols = getSymbolColumn(marketSheet);
  const currentSet     = new Set(currentSymbols);
  const latestSet      = new Set(latestSymbols);

  // Remove obsolete — walk backwards
  const lastRow = marketSheet.getLastRow();
  for (let r = lastRow; r >= 2; r--) {
    const cellVal = marketSheet.getRange(r, 1).getValue();
    const sym     = String(cellVal === null || cellVal === undefined ? '' : cellVal).trim();
    if (sym && !latestSet.has(sym)) {
      marketSheet.deleteRow(r);
      console.log(`[MarketAI] ${marketName}: removed "${sym}" row ${r}`);
    }
  }

  // Add new
  const toAdd = latestSymbols.filter(s => !currentSet.has(s));
  if (toAdd.length > 0) {
    const newLastRow = marketSheet.getLastRow();
    const insertAt   = Math.max(newLastRow + 1, 2);
    marketSheet.getRange(insertAt, 1, toAdd.length, 1).setValues(toAdd.map(s => [s]));
    console.log(`[MarketAI] ${marketName}: added ${toAdd.length} — ${toAdd.join(', ')}`);
  }
}

// ─── GET SYMBOL COLUMN ─────────────────────────────────────────────────────────
function getSymbolColumn(marketSheet) {
  const lastRow = marketSheet.getLastRow();
  if (lastRow < 2) return [];
  return marketSheet
    .getRange(2, 1, lastRow - 1, 1)
    .getValues()
    .map(r => String(r[0] === null || r[0] === undefined ? '' : r[0]).trim())
    .filter(s => s.length > 0);
}

// ─── APPEND PRICE COLUMN ───────────────────────────────────────────────────────
function appendPriceColumn(marketSheet, prices, now, marketName) {
  if (prices.length === 0) return;
  const nextCol    = marketSheet.getLastColumn() + 1;
  const headerCell = marketSheet.getRange(1, nextCol);
  headerCell.setValue(now);
  headerCell.setNumberFormat('dd/MM/yyyy HH:mm');
  const priceRange = marketSheet.getRange(2, nextCol, prices.length, 1);
  priceRange.setValues(prices.map(p => [p === '' ? '' : p]));
  priceRange.setNumberFormat('0.00');
  console.log(`[MarketAI] ${marketName}: wrote ${prices.length} prices → col ${nextCol}`);
}

// ─── STALE GUARD ───────────────────────────────────────────────────────────────
// FIX: distinguish "no prior data" vs "all blank" vs "unchanged"
function pricesUnchanged(marketSheet, newPrices) {
  const lastCol = marketSheet.getLastColumn();

  // No prior price columns → always write
  if (lastCol < 2) {
    console.log('[MarketAI] pricesUnchanged: no prior cols → write');
    return false;
  }

  // Count valid new prices
  const validNew = newPrices.filter(p => p !== '' && !isNaN(Number(p)));
  if (validNew.length === 0) {
    // All blank — GOOGLEFINANCE not loaded yet
    console.log('[MarketAI] pricesUnchanged: all prices blank → skip');
    return true;
  }

  const rowCount   = newPrices.length;
  const lastPrices = marketSheet
    .getRange(2, lastCol, rowCount, 1)
    .getValues()
    .map(r => r[0]);

  const anyChanged = newPrices.some((p, i) => {
    const np = Number(p);
    const lp = Number(lastPrices[i]);
    if (p === '' || isNaN(np))                     return false;
    if (lastPrices[i] === '' || isNaN(lp))         return true;  // new data where none existed
    return Math.abs(np - lp) > 0.001;
  });

  return !anyChanged;
}

// ─── CLEANUP ───────────────────────────────────────────────────────────────────
function cleanupOldColumns(marketSheet, marketName) {
  const lastCol = marketSheet.getLastColumn();
  if (lastCol < 3) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CONFIG.MAX_DAYS_IN_SHEET);
  cutoff.setHours(0, 0, 0, 0);

  const headers  = marketSheet.getRange(1, 2, 1, lastCol - 1).getValues()[0];
  const toDelete = [];
  headers.forEach((h, idx) => {
    if (!h) return;
    const d = h instanceof Date ? h : new Date(h);
    if (!isNaN(d.getTime()) && d < cutoff) toDelete.push(idx + 2);
  });
  toDelete.reverse().forEach(col => marketSheet.deleteColumn(col));
  if (toDelete.length > 0)
    console.log(`[MarketAI] ${marketName}: pruned ${toDelete.length} old cols`);
}

// ─── CLOUDFLARE PUSH ───────────────────────────────────────────────────────────
function pushToCloudflare(marketName, symbols, prices, now) {
  const tsStr = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

  const data = symbols
    .map((sym, i) => ({ symbol: sym, market: marketName, price: prices[i] }))
    .filter(item => {
      if (!item.symbol) return false;
      if (item.price === '' || item.price === null || item.price === undefined) return false;
      const n = Number(item.price);
      return !isNaN(n) && n > 0;
    });

  if (data.length === 0) {
    console.warn(`[MarketAI] ${marketName}: nothing valid to push`);
    return;
  }

  const options = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify({ timestamp: tsStr, data }),
    muteHttpExceptions: true,
    followRedirects:    true,
  };

  try {
    const res  = UrlFetchApp.fetch(CONFIG.CLOUDFLARE_WORKER_URL + '/store', options);
    const code = res.getResponseCode();
    if (code === 200) {
      console.log(`[MarketAI] ${marketName}: ✓ pushed ${data.length} prices @ ${tsStr}`);
    } else {
      console.error(`[MarketAI] ${marketName}: ✗ HTTP ${code} — ${res.getContentText()}`);
    }
  } catch (e) {
    console.error(`[MarketAI] ${marketName}: ✗ network — ${e.message}`);
  }
}

// ─── MARKET HOURS (IST) ────────────────────────────────────────────────────────
function isMarketOpenNow(market, now) {
  const cur   = now.getHours() * 60 + now.getMinutes();
  const open  = market.openHour  * 60 + market.openMin;
  const close = market.closeHour * 60 + market.closeMin;
  // Overnight (NASDAQ wraps midnight)
  if (open > close) return cur >= open || cur <= close;
  return cur >= open && cur <= close;
}

function isWeekend(now) { const d = now.getDay(); return d === 0 || d === 6; }

// ─── HELPERS ───────────────────────────────────────────────────────────────────
function getNowIST() {
  const s = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  return new Date(s);
}
function formatTime(d) {
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'dd/MM/yyyy HH:mm:ss');
}
function getSheet(ss, name) {
  const s = ss.getSheetByName(name);
  if (!s) console.error(`[MarketAI] Sheet not found: "${name}"`);
  return s;
}

// ─── SETUP ─────────────────────────────────────────────────────────────────────
function setupMarketSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const created = [], existing = [];
  CONFIG.MARKETS.forEach(market => {
    let sheet = ss.getSheetByName(market.sheet);
    if (!sheet) {
      sheet = ss.insertSheet(market.sheet);
      sheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
      created.push(market.sheet);
    } else {
      existing.push(market.sheet);
    }
  });
  const msg = [
    created.length  ? `✓ Created: ${created.join(', ')}`        : '',
    existing.length ? `↩ Exists:  ${existing.join(', ')}`       : '',
    '',
    'Next → Setup 5-Min Trigger',
  ].filter(Boolean).join('\n');
  SpreadsheetApp.getUi().alert('Market Sheets Setup\n\n' + msg);
}

// ─── TRIGGER ───────────────────────────────────────────────────────────────────
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'logStockPrices') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('logStockPrices').timeBased().everyMinutes(5).create();
  SpreadsheetApp.getUi().alert('✓ Trigger set — runs every 5 min');
}
function removeTrigger() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'logStockPrices') { ScriptApp.deleteTrigger(t); n++; }
  });
  SpreadsheetApp.getUi().alert(n > 0 ? `✓ Removed ${n} trigger(s)` : 'No triggers found');
}

// ─── MANUAL CONTROLS ───────────────────────────────────────────────────────────

// Force snapshot for ALL markets, ignoring trading hours
function forceSnapshot() {
  const ss           = SpreadsheetApp.getActiveSpreadsheet();
  const symbolsSheet = getSheet(ss, CONFIG.SYMBOLS_SHEET);
  if (!symbolsSheet) return;

  const now      = getNowIST();
  const lastRow  = symbolsSheet.getLastRow();
  if (lastRow < 1) { SpreadsheetApp.getUi().alert('SYMBOLS sheet is empty'); return; }

  const readCols = Math.min(symbolsSheet.getLastColumn(), 14);
  const allData  = symbolsSheet.getRange(1, 1, lastRow, readCols).getValues();

  for (const market of CONFIG.MARKETS) {
    try {
      const marketSheet = getSheet(ss, market.sheet);
      if (!marketSheet) continue;

      const { symbols, prices } = extractMarketData(allData, market);
      if (symbols.length === 0) {
        console.warn(`[forceSnapshot] ${market.name}: no symbols`);
        continue;
      }

      syncSymbolColumn(marketSheet, symbols, market.name);

      const synced       = getSymbolColumn(marketSheet);
      const bySymbol     = {};
      symbols.forEach((s, i) => { bySymbol[s] = prices[i]; });
      const ordered = synced.map(s => bySymbol[s] !== undefined ? bySymbol[s] : '');

      appendPriceColumn(marketSheet, ordered, now, market.name);
      pushToCloudflare(market.name, synced, ordered, now);
      cleanupOldColumns(marketSheet, market.name);
    } catch (e) {
      console.error(`[forceSnapshot] ${market.name}: ${e.message}`);
    }
  }
  SpreadsheetApp.getUi().alert(`✓ Snapshot done — ${formatTime(now)}`);
}

// Sync symbol lists only, no price logging
function syncSymbolsOnly() {
  const ss           = SpreadsheetApp.getActiveSpreadsheet();
  const symbolsSheet = getSheet(ss, CONFIG.SYMBOLS_SHEET);
  if (!symbolsSheet) return;

  const lastRow  = symbolsSheet.getLastRow();
  if (lastRow < 1) { SpreadsheetApp.getUi().alert('SYMBOLS sheet is empty'); return; }

  const readCols = Math.min(symbolsSheet.getLastColumn(), 14);
  const allData  = symbolsSheet.getRange(1, 1, lastRow, readCols).getValues();

  for (const market of CONFIG.MARKETS) {
    const marketSheet = getSheet(ss, market.sheet);
    if (!marketSheet) continue;
    const { symbols } = extractMarketData(allData, market);
    if (symbols.length === 0) continue;
    syncSymbolColumn(marketSheet, symbols, market.name);
  }
  SpreadsheetApp.getUi().alert('✓ Symbols synced across all market sheets');
}

// Prune old columns from all market sheets
function manualCleanup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  CONFIG.MARKETS.forEach(market => {
    const sheet = ss.getSheetByName(market.sheet);
    if (sheet) cleanupOldColumns(sheet, market.name);
  });
  SpreadsheetApp.getUi().alert('✓ Cleanup done on all market sheets');
}

// Test Cloudflare connectivity
function testCloudflareConnection() {
  pushToCloudflare('NSE', ['TEST_SYMBOL'], [9999.99], getNowIST());
  SpreadsheetApp.getUi().alert('Test push sent\nCheck: Cloudflare Dashboard → Workers → Logs');
}

// Debug: show exactly what script reads from SYMBOLS
function debugSymbolsSheet() {
  const ss           = SpreadsheetApp.getActiveSpreadsheet();
  const symbolsSheet = getSheet(ss, CONFIG.SYMBOLS_SHEET);
  if (!symbolsSheet) return;

  const lastRow  = symbolsSheet.getLastRow();
  const readCols = Math.min(symbolsSheet.getLastColumn(), 14);
  const allData  = symbolsSheet.getRange(1, 1, lastRow, readCols).getValues();

  let report = `SYMBOLS: ${lastRow} rows × ${readCols} cols\n\n`;
  for (const market of CONFIG.MARKETS) {
    const { symbols, prices } = extractMarketData(allData, market);
    report += `${market.name} (col${market.symbolCol}/col${market.priceCol}): ${symbols.length} found\n`;
    if (symbols.length > 0)
      report += `  First 3: ${symbols.slice(0,3).map((s,i)=>`${s}=${prices[i]}`).join(', ')}\n`;
  }
  console.log(report);
  SpreadsheetApp.getUi().alert(report);
}

// ─── MENU ──────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('MarketAI')
    .addItem('1. Create Market Sheets',       'setupMarketSheets')
    .addItem('2. Setup 5-Min Trigger',        'setupTrigger')
    .addSeparator()
    .addItem('Sync Symbols Only',             'syncSymbolsOnly')
    .addItem('Force Snapshot (All Markets)',  'forceSnapshot')
    .addItem('Manual Cleanup (All Sheets)',   'manualCleanup')
    .addSeparator()
    .addItem('Debug: Read SYMBOLS Sheet',     'debugSymbolsSheet')
    .addItem('Test Cloudflare Connection',    'testCloudflareConnection')
    .addItem('Remove Trigger',               'removeTrigger')
    .addToUi();
}
