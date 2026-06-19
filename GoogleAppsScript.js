// ===============================================================================
//  MarketAI — Google Apps Script
//  EOD OHLC Capture | All Markets | Auto Symbol Sync | 365 Day Retention
// ===============================================================================
//
// SYMBOLS sheet column layout:
//   Col 1:  SYMBOL
//   Col 2:  NSE (close)      =GOOGLEFINANCE("NSE:"&A2, "price")
//   Col 3:  NSE_OPEN         =GOOGLEFINANCE("NSE:"&A2, "open")
//   Col 4:  NSE_HIGH         =GOOGLEFINANCE("NSE:"&A2, "high")
//   Col 5:  NSE_LOW          =GOOGLEFINANCE("NSE:"&A2, "low")
//   Col 6:  NASDAQ (close)   =GOOGLEFINANCE("NASDAQ:"&A2, "price")
//   Col 7:  NASDAQ_OPEN      =GOOGLEFINANCE("NASDAQ:"&A2, "open")
//   Col 8:  NASDAQ_HIGH      =GOOGLEFINANCE("NASDAQ:"&A2, "high")
//   Col 9:  NASDAQ_LOW       =GOOGLEFINANCE("NASDAQ:"&A2, "low")
//   Col 10: LSE (close)      =GOOGLEFINANCE("LON:"&A2, "price")
//   ... etc (4 columns per market)
//
// Market sheets store OHLC as: "close,open,high,low" (one cell per symbol per day)

const CONFIG = {
  SYMBOLS_SHEET: 'SYMBOLS',
  TIMEZONE: 'Asia/Kolkata',
  KEEP_DAYS: 365,
  MARKETS: [
    { name: 'NSE',    sheet: 'NSE',    prefix: 'NSE',    closeCol: 2,  openCol: 3,  highCol: 4,  lowCol: 5,  runAfterIST: '15:35' },
    { name: 'NASDAQ', sheet: 'NASDAQ', prefix: 'NASDAQ', closeCol: 6,  openCol: 7,  highCol: 8,  lowCol: 9,  runAfterIST: '02:35' },
    { name: 'LSE',    sheet: 'LSE',    prefix: 'LON',    closeCol: 10, openCol: 11, highCol: 12, lowCol: 13, runAfterIST: '21:05' },
    { name: 'SGX',    sheet: 'SGX',    prefix: 'SGX',    closeCol: 14, openCol: 15, highCol: 16, lowCol: 17, runAfterIST: '13:35' },
    { name: 'HKEX',   sheet: 'HKEX',   prefix: 'HKEX',   closeCol: 18, openCol: 19, highCol: 20, lowCol: 21, runAfterIST: '13:35' },
    { name: 'JPX',    sheet: 'JPX',    prefix: 'TK2',    closeCol: 22, openCol: 23, highCol: 24, lowCol: 25, runAfterIST: '12:05' },
    { name: 'ASX',    sheet: 'ASX',    prefix: 'ASX',    closeCol: 26, openCol: 27, highCol: 28, lowCol: 29, runAfterIST: '11:35' },
  ],
};

const maxCol = Math.max(...CONFIG.MARKETS.map(m => m.lowCol));
const badValues = ['#N/A','#ERROR!','#VALUE!','#REF!','#NUM!','Loading...',''];

// ─── MAIN TRIGGER ─────────────────────────────────────────────────────────────
function logStockPrices() {
  const now = getNowIST();
  const nowIST = Utilities.formatDate(now, CONFIG.TIMEZONE, 'HH:mm');
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
      if (hasWrittenToday(marketSheet)) continue;
      processMarket(ss, market, allData, now);
    } catch (e) { console.error(`[MarketAI] ${market.name} Error: ${e.message}`); }
  }
  console.log(`[MarketAI EOD] Run in ${((Date.now()-startTime)/1000).toFixed(1)}s`);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getNowIST() { return new Date(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss')); }
function isAfterIST(nowStr, targetStr) {
  const [nh,nm]=nowStr.split(':').map(Number); const [th,tm]=targetStr.split(':').map(Number);
  return (nh*60+nm) >= (th*60+tm);
}
function hasWrittenToday(marketSheet) {
  const lastCol = marketSheet.getLastColumn();
  if (lastCol < 2) return false;
  const header = marketSheet.getRange(1, lastCol).getValue();
  if (!header) return false;
  const d = header instanceof Date ? header : new Date(header);
  if (isNaN(d.getTime())) return false;
  const todayStr = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const hdrStr = Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return todayStr === hdrStr;
}

// ─── PROCESS ONE MARKET ───────────────────────────────────────────────────────
function processMarket(ss, market, allData, now) {
  const marketSheet = ss.getSheetByName(market.sheet);
  if (!marketSheet) return;

  const { symbols, ohlcData } = extractMarketData(allData, market);
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

// ─── EXTRACT OHLC ─────────────────────────────────────────────────────────────
function extractMarketData(allData, market) {
  const symIdx=market.symbolCol-1, cIdx=market.closeCol-1, oIdx=market.openCol-1, hIdx=market.highCol-1, lIdx=market.lowCol-1;
  const symbols=[], ohlcData=[];

  for (let r = 0; r < allData.length; r++) {
    const row = allData[r];
    const sym = row.length > symIdx ? String(row[symIdx] || '').trim() : '';
    if (!sym) continue;

    const closeStr = row.length > cIdx ? String(row[cIdx] || '').trim() : '';
    const openStr  = row.length > oIdx ? String(row[oIdx] || '').trim() : '';
    const highStr  = row.length > hIdx ? String(row[hIdx] || '').trim() : '';
    const lowStr   = row.length > lIdx ? String(row[lIdx] || '').trim() : '';

    if (badValues.includes(closeStr)) continue;
    const close = Number(closeStr);
    if (isNaN(close) || close <= 0) continue;

    const open  = (openStr && !badValues.includes(openStr))  ? Number(openStr)  : close;
    const high  = (highStr && !badValues.includes(highStr))  ? Number(highStr)  : close;
    const low   = (lowStr && !badValues.includes(lowStr))    ? Number(lowStr)   : close;

    const safe = v => isNaN(v) ? close : v;
    const ohlcStr = [close, safe(open), safe(high), safe(low)].map(v => v.toFixed(2)).join(',');
    symbols.push(sym);
    ohlcData.push(ohlcStr);
  }
  return { symbols, ohlcData };
}

// ─── SYMBOL COLUMN SYNC ──────────────────────────────────────────────────────
function syncSymbolColumn(marketSheet, latestSymbols) {
  const lastRow = marketSheet.getLastRow();
  if (lastRow < 2) {
    marketSheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
    if (latestSymbols.length) marketSheet.getRange(2,1,latestSymbols.length,1).setValues(latestSymbols.map(s=>[s]));
    return;
  }
  const current = marketSheet.getRange(2,1,lastRow-1,1).getValues().map(r=>String(r[0]||'').trim());
  const latestSet = new Set(latestSymbols);
  for (let r = current.length-1; r >= 0; r--) { if (current[r] && !latestSet.has(current[r])) marketSheet.deleteRow(r+2); }
  const remaining = getSymbolColumn(marketSheet);
  const toAdd = latestSymbols.filter(s => !new Set(remaining).has(s));
  if (toAdd.length) marketSheet.getRange(Math.max(marketSheet.getLastRow()+1,2),1,toAdd.length,1).setValues(toAdd.map(s=>[s]));
}
function getSymbolColumn(marketSheet) {
  const lastRow = marketSheet.getLastRow();
  return lastRow < 2 ? [] : marketSheet.getRange(2,1,lastRow-1,1).getValues().map(r=>String(r[0]||'').trim()).filter(s=>s.length);
}

// ─── WRITE OHLC COLUMN ───────────────────────────────────────────────────────
function appendPriceColumn(marketSheet, ohlcStrings, now) {
  if (!ohlcStrings.length) return;
  const nextCol = marketSheet.getLastColumn() + 1;
  marketSheet.getRange(1, nextCol).setValue(now).setNumberFormat('dd/MM/yyyy HH:mm');
  marketSheet.getRange(2, nextCol, ohlcStrings.length, 1).setValues(ohlcStrings.map(s => [s === '' ? '' : s]));
}

// ─── CLEANUP ─────────────────────────────────────────────────────────────────
function dailyCleanup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - CONFIG.KEEP_DAYS); cutoff.setHours(0,0,0,0);
  CONFIG.MARKETS.forEach(market => {
    const sheet = ss.getSheetByName(market.sheet);
    if (!sheet) return;
    const lastCol = sheet.getLastColumn();
    if (lastCol < 2) return;
    const headers = sheet.getRange(1, 2, 1, lastCol-1).getValues()[0];
    const toDelete = [];
    headers.forEach((h, idx) => {
      if (!h) return;
      const d = h instanceof Date ? h : new Date(h);
      if (!isNaN(d.getTime()) && d < cutoff) toDelete.push(idx + 2);
    });
    toDelete.sort((a,b)=>b-a).forEach(col => sheet.deleteColumn(col));
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
    // Write OHLC column headers for all markets
    const hdrLabels = ['SYMBOL'];
    CONFIG.MARKETS.forEach(m => {
      hdrLabels.push(m.name, m.name+'_OPEN', m.name+'_HIGH', m.name+'_LOW');
    });
    const hdrRange = symbolsSheet.getRange(1, 1, 1, hdrLabels.length);
    hdrRange.setValues([hdrLabels]);
    hdrRange.setFontWeight('bold');

    // Add GOOGLEFINANCE formulas
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

  // Create market sheets
  CONFIG.MARKETS.forEach(market => {
    if (!ss.getSheetByName(market.sheet)) {
      const sheet = ss.insertSheet(market.sheet);
      sheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
    }
  });

  SpreadsheetApp.getUi().alert('✓ Market Sheets with OHLC columns ready');
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // EOD triggers for each market close window
  [{h:11,m:40},{h:12,m:10},{h:13,m:40},{h:15,m:40},{h:21,m:10},{h:2,m:40}].forEach(t => {
    ScriptApp.newTrigger('logStockPrices').timeBased().atHour(t.h).nearMinute(t.m).everyDays(1).create();
  });
  ScriptApp.newTrigger('dailyCleanup').timeBased().atHour(0).nearMinute(30).everyDays(1).create();

  SpreadsheetApp.getUi().alert('✓ Triggers set:\n11:40 ASX · 12:10 JPX · 13:40 SGX/HKEX · 15:40 NSE · 21:10 LSE · 02:40 NASDAQ');
}

function forceSnapshotNow() {
  logStockPrices();
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
