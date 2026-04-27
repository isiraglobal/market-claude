// ===============================================================================
//  MarketAI — Google Apps Script (SHEETS ONLY + ROLLUP)
//  Multi-Market | Auto Symbol Sync
// ===============================================================================

const CONFIG = {
  SYMBOLS_SHEET: 'SYMBOLS',
  TIMEZONE: 'Asia/Kolkata',
  
  // 🚨 SET TO 'true' TO TEST ON WEEKENDS. SET TO 'false' ON MONDAY TO SAVE SPACE.
  FORCE_WRITE_ALL: true,

  // ROLLUP STRATEGY SETTINGS
  DETAILED_DAYS: 3, // Keep every 5-min column for this many days
  ARCHIVE_DAYS: 60, // Keep 1 closing column per day for this many days

  MARKETS: [
    { name: 'NSE',    sheet: 'NSE',    symbolCol: 1,  priceCol: 2  },
    { name: 'NASDAQ', sheet: 'NASDAQ', symbolCol: 3,  priceCol: 4  },
    { name: 'LSE',    sheet: 'LSE',    symbolCol: 5,  priceCol: 6  },
    { name: 'SGX',    sheet: 'SGX',    symbolCol: 7,  priceCol: 8  },
    { name: 'HKEX',   sheet: 'HKEX',   symbolCol: 9,  priceCol: 10 },
    { name: 'JPX',    sheet: 'JPX',    symbolCol: 11, priceCol: 12 },
    { name: 'ASX',    sheet: 'ASX',    symbolCol: 13, priceCol: 14 },
  ],
};

// ─── MAIN 5-MINUTE TRIGGER ─────────────────────────────────────────────────────
function logStockPrices() {
  const now = getNowIST();
  const startTime = new Date().getTime();
  console.log(`[MarketAI] ── Run starting at ${formatTime(now)} ──`);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const symbolsSheet = ss.getSheetByName(CONFIG.SYMBOLS_SHEET);
  if (!symbolsSheet) return;

  const lastRow = symbolsSheet.getLastRow();
  if (lastRow < 1) {
    console.warn('[MarketAI] SYMBOLS sheet is empty');
    return;
  }

  const allData = symbolsSheet.getRange(1, 1, lastRow, 14).getValues();

  // Process each market
  for (const market of CONFIG.MARKETS) {
    try {
      processMarket(ss, market, allData, now);
    } catch (e) {
      console.error(`[MarketAI] ${market.name} Error: ${e.message}`);
    }
  }

  const executionTime = (new Date().getTime() - startTime) / 1000;
  console.log(`[MarketAI] ── Run complete in ${executionTime} seconds ──`);
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
  symbols.forEach((s, i) => { priceMap[s] = prices[i]; });
  const orderedPrices = syncedSymbols.map(s => priceMap[s] !== undefined ? priceMap[s] : '');

  // STALE GUARD: Will bypass if FORCE_WRITE_ALL is true
  if (!CONFIG.FORCE_WRITE_ALL && pricesUnchanged(marketSheet, orderedPrices)) {
    console.log(`[MarketAI] ${market.name}: Prices unchanged — skipping sheet update.`);
    return; 
  }

  appendPriceColumn(marketSheet, orderedPrices, now);
}

// ─── EXTRACT DATA (IN MEMORY) ──────────────────────────────────────────────────
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

  if (lastRow < 2) {
    marketSheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
    if (latestSymbols.length > 0) {
      const values = latestSymbols.map(s => [s]);
      marketSheet.getRange(2, 1, values.length, 1).setValues(values);
    }
    return;
  }

  const currentSymbols = marketSheet.getRange(2, 1, lastRow - 1, 1).getValues().map(r => String(r[0] || '').trim());
  const latestSet = new Set(latestSymbols);

  let deletedCount = 0;
  for (let r = currentSymbols.length - 1; r >= 0; r--) {
    const sym = currentSymbols[r];
    if (sym !== "" && !latestSet.has(sym)) {
      marketSheet.deleteRow(r + 2); 
      deletedCount++;
    }
  }

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

// ─── FAST COLUMN APPEND ────────────────────────────────────────────────────────
function appendPriceColumn(marketSheet, prices, now) {
  if (prices.length === 0) return;
  const nextCol = marketSheet.getLastColumn() + 1;
  
  marketSheet.getRange(1, nextCol).setValue(now).setNumberFormat('dd/MM/yyyy HH:mm');
  marketSheet.getRange(2, nextCol, prices.length, 1)
    .setValues(prices.map(p => [p === '' ? '' : p]))
    .setNumberFormat('0.00');
}

// ─── STALE GUARD ───────────────────────────────────────────────────────────────
function pricesUnchanged(marketSheet, newPrices) {
  const lastCol = marketSheet.getLastColumn();
  if (lastCol < 2) return false;

  const validNew = newPrices.filter(p => p !== '' && !isNaN(Number(p)));
  if (validNew.length === 0) return true;

  const lastPrices = marketSheet.getRange(2, lastCol, newPrices.length, 1).getValues().map(r => r[0]);

  return !newPrices.some((p, i) => {
    const np = Number(p), lp = Number(lastPrices[i]);
    if (p === '' || isNaN(np)) return false;
    if (lastPrices[i] === '' || isNaN(lp)) return true;
    return Math.abs(np - lp) > 0.001;
  });
}

// ─── ROLLUP DAILY CLEANUP ──────────────────────────────────────────────────────
function dailyCleanup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const now = getNowIST();

  const detailedCutoff = new Date(now);
  detailedCutoff.setDate(detailedCutoff.getDate() - CONFIG.DETAILED_DAYS);
  detailedCutoff.setHours(0, 0, 0, 0);

  const archiveCutoff = new Date(now);
  archiveCutoff.setDate(archiveCutoff.getDate() - (CONFIG.DETAILED_DAYS + CONFIG.ARCHIVE_DAYS));
  archiveCutoff.setHours(0, 0, 0, 0);

  CONFIG.MARKETS.forEach(market => {
    const marketSheet = ss.getSheetByName(market.sheet);
    if (!marketSheet) return;

    const lastCol = marketSheet.getLastColumn();
    if (lastCol < 3) return;

    const headers = marketSheet.getRange(1, 2, 1, lastCol - 1).getValues()[0];
    const colData = [];

    headers.forEach((h, idx) => {
      if (!h) return;
      const d = h instanceof Date ? h : new Date(h);
      if (!isNaN(d.getTime())) {
        const dateStr = Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
        colData.push({ col: idx + 2, dateObj: d, dateStr: dateStr, time: d.getTime() });
      }
    });

    const toDelete = [];
    const archiveDaysMap = {};

    colData.forEach(item => {
      if (item.dateObj < archiveCutoff) {
        toDelete.push(item.col);
      } else if (item.dateObj < detailedCutoff) {
        if (!archiveDaysMap[item.dateStr]) archiveDaysMap[item.dateStr] = [];
        archiveDaysMap[item.dateStr].push(item);
      }
    });

    for (const dateStr in archiveDaysMap) {
      const dayCols = archiveDaysMap[dateStr];
      dayCols.sort((a, b) => b.time - a.time);
      for (let i = 1; i < dayCols.length; i++) {
        toDelete.push(dayCols[i].col);
      }
    }

    toDelete.sort((a, b) => b - a);
    toDelete.forEach(col => marketSheet.deleteColumn(col));

    if (toDelete.length > 0) {
      console.log(`[MarketAI] ${market.name}: Rolled up ${toDelete.length} columns.`);
    }
  });
}

// ─── HELPERS & SETUP ───────────────────────────────────────────────────────────
function getNowIST() {
  return new Date(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'));
}
function formatTime(d) {
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'dd/MM/yyyy HH:mm:ss');
}

function setupMarketSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  CONFIG.MARKETS.forEach(market => {
    let sheet = ss.getSheetByName(market.sheet);
    if (!sheet) {
      sheet = ss.insertSheet(market.sheet);
      sheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
    }
  });
  SpreadsheetApp.getUi().alert('✓ Market Sheets Initialized');
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('logStockPrices').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('dailyCleanup').timeBased().atHour(0).everyDays(1).create();
  SpreadsheetApp.getUi().alert('✓ Triggers Set:\n- Data logging every 5 mins\n- Rollup Cleanup runs every night at midnight');
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('MarketAI')
    .addItem('1. Create Market Sheets', 'setupMarketSheets')
    .addItem('2. Setup Fast Triggers', 'setupTriggers')
    .addSeparator()
    .addItem('Force Snapshot Now', 'logStockPrices')
    .addItem('Force Rollup Cleanup Now', 'dailyCleanup')
    .addToUi();
}
