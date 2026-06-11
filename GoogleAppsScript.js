// ===============================================================================
//  MarketAI — Google Apps Script
//  Multi-Market | Auto Symbol Sync | 7 Day Retention | Change Only Writes
// ===============================================================================

const CONFIG = {
  SYMBOLS_SHEET: 'SYMBOLS',
  TIMEZONE: 'Asia/Kolkata',
  KEEP_DAYS: 7,

  MARKETS: [
    { name: 'NSE', sheet: 'NSE', symbolCol: 1, priceCol: 2 },
    { name: 'NASDAQ', sheet: 'NASDAQ', symbolCol: 3, priceCol: 4 },
    { name: 'LSE', sheet: 'LSE', symbolCol: 5, priceCol: 6 },
    { name: 'SGX', sheet: 'SGX', symbolCol: 7, priceCol: 8 },
    { name: 'HKEX', sheet: 'HKEX', symbolCol: 9, priceCol: 10 },
    { name: 'JPX', sheet: 'JPX', symbolCol: 11, priceCol: 12 },
    { name: 'ASX', sheet: 'ASX', symbolCol: 13, priceCol: 14 },
  ],
};

// ─── MAIN TRIGGER ─────────────────────────────────────────────────────────────
function logStockPrices() {
  const now = getNowIST();
  const startTime = new Date().getTime();
  console.log(`[MarketAI] Run starting at ${formatTime(now)}`);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const symbolsSheet = ss.getSheetByName(CONFIG.SYMBOLS_SHEET);
  if (!symbolsSheet) {
    console.warn('[MarketAI] SYMBOLS sheet is missing');
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
      processMarket(ss, market, allData, now);
    } catch (e) {
      console.error(`[MarketAI] ${market.name} Error: ${e.message}`);
    }
  }

  const executionTime = (new Date().getTime() - startTime) / 1000;
  console.log(`[MarketAI] Run complete in ${executionTime} seconds`);
}

// ─── PROCESS ONE MARKET ────────────────────────────────────────────────────────
function processMarket(ss, market, allData, now) {
  const marketSheet = ss.getSheetByName(market.sheet);
  if (!marketSheet) {
    console.warn(`[MarketAI] Tab "${market.sheet}" is missing. Run Create Market Sheets.`);
    return;
  }

  const { symbols, prices } = extractMarketData(allData, market);
  if (symbols.length === 0) return;

  syncSymbolColumn(marketSheet, symbols);

  const syncedSymbols = getSymbolColumn(marketSheet);
  if (syncedSymbols.length === 0) return;

  const priceMap = {};
  symbols.forEach((s, i) => {
    priceMap[s] = prices[i];
  });

  const orderedPrices = syncedSymbols.map(s =>
    priceMap[s] !== undefined ? priceMap[s] : ''
  );

  if (pricesUnchanged(marketSheet, orderedPrices)) {
    console.log(`[MarketAI] ${market.name}: Prices unchanged, skipping update.`);
    return;
  }

  appendPriceColumn(marketSheet, orderedPrices, now);
}

// ─── EXTRACT DATA ──────────────────────────────────────────────────────────────
function extractMarketData(allData, market) {
  const symIdx = market.symbolCol - 1;
  const priceIdx = market.priceCol - 1;
  const symbols = [];
  const prices = [];

  for (let r = 0; r < allData.length; r++) {
    const row = allData[r];

    const sym = row.length > symIdx ? String(row[symIdx] || '').trim() : '';
    if (!sym) continue;

    const priceStr = row.length > priceIdx ? String(row[priceIdx] || '').trim() : '';
    if (['#N/A', '#ERROR!', '#VALUE!', '#REF!', '#NUM!', 'Loading...'].includes(priceStr)) continue;

    const price = priceStr === '' ? '' : Number(priceStr);
    if (priceStr !== '' && isNaN(price)) continue;

    symbols.push(sym);
    prices.push(price);
  }

  return { symbols, prices };
}

// ─── SMART SYMBOL SYNC ─────────────────────────────────────────────────────────
function syncSymbolColumn(marketSheet, latestSymbols) {
  const lastRow = marketSheet.getLastRow();

  if (lastRow < 1) {
    marketSheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
    if (latestSymbols.length > 0) {
      marketSheet.getRange(2, 1, latestSymbols.length, 1)
        .setValues(latestSymbols.map(s => [s]));
    }
    return;
  }

  if (lastRow === 1) {
    if (marketSheet.getRange(1, 1).getValue() !== 'Symbol') {
      marketSheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
    }
    if (latestSymbols.length > 0) {
      marketSheet.getRange(2, 1, latestSymbols.length, 1)
        .setValues(latestSymbols.map(s => [s]));
    }
    return;
  }

  const currentSymbols = marketSheet
    .getRange(2, 1, lastRow - 1, 1)
    .getValues()
    .map(r => String(r[0] || '').trim());

  const latestSet = new Set(latestSymbols);

  for (let r = currentSymbols.length - 1; r >= 0; r--) {
    const sym = currentSymbols[r];
    if (sym !== '' && !latestSet.has(sym)) {
      marketSheet.deleteRow(r + 2);
    }
  }

  const remainingSymbols = getSymbolColumn(marketSheet);
  const currentSet = new Set(remainingSymbols);
  const toAdd = latestSymbols.filter(s => !currentSet.has(s));

  if (toAdd.length > 0) {
    const insertAt = Math.max(marketSheet.getLastRow() + 1, 2);
    marketSheet.getRange(insertAt, 1, toAdd.length, 1)
      .setValues(toAdd.map(s => [s]));
  }
}

function getSymbolColumn(marketSheet) {
  const lastRow = marketSheet.getLastRow();
  if (lastRow < 2) return [];

  return marketSheet.getRange(2, 1, lastRow - 1, 1)
    .getValues()
    .map(r => String(r[0] || '').trim())
    .filter(s => s.length > 0);
}

// ─── WRITE NEW PRICE COLUMN ────────────────────────────────────────────────────
function appendPriceColumn(marketSheet, prices, now) {
  if (prices.length === 0) return;

  const nextCol = marketSheet.getLastColumn() + 1;

  marketSheet.getRange(1, nextCol)
    .setValue(now)
    .setNumberFormat('dd/MM/yyyy HH:mm');

  marketSheet.getRange(2, nextCol, prices.length, 1)
    .setValues(prices.map(p => [p === '' ? '' : p]))
    .setNumberFormat('0.00');
}

// ─── CHANGE DETECTION ─────────────────────────────────────────────────────────
function pricesUnchanged(marketSheet, newPrices) {
  const lastCol = marketSheet.getLastColumn();
  if (lastCol < 2) return false;

  const validNew = newPrices.filter(p => p !== '' && !isNaN(Number(p)));
  if (validNew.length === 0) return true;

  const lastPrices = marketSheet.getRange(2, lastCol, newPrices.length, 1)
    .getValues()
    .map(r => r[0]);

  for (let i = 0; i < newPrices.length; i++) {
    const p = newPrices[i];
    const np = Number(p);
    const lp = Number(lastPrices[i]);

    if (p === '' || isNaN(np)) continue;
    if (lastPrices[i] === '' || isNaN(lp)) return false;
    if (Math.abs(np - lp) > 0.001) return false;
  }

  return true;
}

// ─── 7 DAY CLEANUP ─────────────────────────────────────────────────────────────
function cleanupOldData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const now = getNowIST();

  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - CONFIG.KEEP_DAYS);
  cutoff.setHours(0, 0, 0, 0);

  CONFIG.MARKETS.forEach(market => {
    const sheet = ss.getSheetByName(market.sheet);
    if (!sheet) return;

    const lastCol = sheet.getLastColumn();
    if (lastCol < 2) return;

    const headers = sheet.getRange(1, 2, 1, lastCol - 1).getValues()[0];
    const colsToDelete = [];

    headers.forEach((header, idx) => {
      if (!header) return;

      const d = header instanceof Date ? header : new Date(header);
      if (isNaN(d.getTime())) return;

      if (d < cutoff) {
        colsToDelete.push(idx + 2);
      }
    });

    colsToDelete.sort((a, b) => b - a);
    colsToDelete.forEach(col => sheet.deleteColumn(col));

    if (colsToDelete.length > 0) {
      console.log(`[MarketAI] ${market.name}: Deleted ${colsToDelete.length} old columns`);
    }
  });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getNowIST() {
  return new Date(
    Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss')
  );
}

function formatTime(d) {
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'dd/MM/yyyy HH:mm:ss');
}

// ─── SETUP ─────────────────────────────────────────────────────────────────────
function setupMarketSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  CONFIG.MARKETS.forEach(market => {
    let sheet = ss.getSheetByName(market.sheet);
    if (!sheet) {
      sheet = ss.insertSheet(market.sheet);
      sheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
    } else {
      if (sheet.getRange(1, 1).getValue() !== 'Symbol') {
        sheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
      }
    }
  });

  SpreadsheetApp.getUi().alert('✓ Market Sheets Initialized');
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('logStockPrices')
    .timeBased()
    .everyMinutes(10)
    .create();

  ScriptApp.newTrigger('cleanupOldData')
    .timeBased()
    .atHour(0)
    .everyDays(1)
    .create();

  SpreadsheetApp.getUi().alert(
    '✓ Triggers Set:\n' +
    '- Data logging every 10 mins\n' +
    '- Cleanup every midnight'
  );
}

function forceSnapshotNow() {
  logStockPrices();
}

function forceCleanupNow() {
  cleanupOldData();
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