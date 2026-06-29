// ===============================================================================
//  MarketAI — Google Apps Script (GitHub Architecture, No Firebase)
//
//  Every 1 minute during market hours:
//    1. Read all prices from SYMBOLS sheet (GOOGLEFINANCE)
//    2. OHLC-pack and compare hash with previous capture
//    3. If changed: append to hidden _INTRADAY sheet + update NSE single row
//    4. If unchanged: skip
//
//  Daily at 15:40 IST (EOD):
//    1. Read all today's snapshots from _INTRADAY
//    2. Fetch existing data.json from GitHub
//    3. Merge (append today's snapshots)
//    4. Commit updated data.json via GitHub Git Data API
//    5. Clear _INTRADAY sheet for next day
// ===============================================================================

const CONFIG = {
  SYMBOLS_SHEET: 'SYMBOLS',
  INTRADAY_SHEET: '_INTRADAY',
  TIMEZONE: 'Asia/Kolkata',
  INTRADAY_INTERVAL_MINUTES: 1,
  NSE_MARKET_OPEN: '09:15',
  NSE_MARKET_CLOSE: '15:30',
  GITHUB_REPO: 'isiraglobal/market-claude',
  GITHUB_FILE: 'data.json',
  MAX_SNAPSHOTS: 2000,
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
const GITHUB_TOKEN = '';

// ─── Time helpers ─────────────────────────────────────────────────────────────

function getNowIST() {
  return new Date(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'));
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

// ─── HASH COMPARISON ──────────────────────────────────────────────────────────

function computePricesHash(prices) {
  const sorted = Object.keys(prices).sort();
  const str = sorted.map(k => k + ':' + prices[k]).join('|');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str);
  return digest.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

// ─── Capture prices from SYMBOLS sheet ────────────────────────────────────────

function captureOHLCSnapshot() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const symbolsSheet = ss.getSheetByName(CONFIG.SYMBOLS_SHEET);
  if (!symbolsSheet) { console.warn('[MarketAI] SYMBOLS sheet missing'); return null; }

  const lastRow = symbolsSheet.getLastRow();
  if (lastRow < 2) return null;

  const allData = symbolsSheet.getRange(2, 1, lastRow - 1, maxCol).getValues();
  const prices = {};

  for (let r = 0; r < allData.length; r++) {
    const row = allData[r];
    const sym = String(row[0] || '').trim();
    if (!sym) continue;

    const closeStr = String(row[1] || '').trim();
    if (badValues.includes(closeStr)) continue;
    const close = Number(closeStr);
    if (isNaN(close) || close <= 0) continue;

    const open  = Number(String(row[2] || '').trim());
    const high  = Number(String(row[3] || '').trim());
    const low   = Number(String(row[4] || '').trim());

    if (isFinite(open) && open > 0 && isFinite(high) && high > 0 && isFinite(low) && low > 0) {
      prices[sym] = [close, open, high, low].map(v => v.toFixed(2)).join(',');
    } else if (isFinite(close) && close > 0) {
      prices[sym] = String(close);
    }
  }

  return prices;
}

// ─── Hidden INTRADAY sheet ───────────────────────────────────────────────────

function ensureIntradaySheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.INTRADAY_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.INTRADAY_SHEET);
    sheet.hideSheet();
    sheet.getRange(1, 1, 1, 3).setValues([['TS', 'LABEL', 'SYMBOLS']]);
  }
  return sheet;
}

function appendIntradaySnapshot(prices, ts, label) {
  if (!prices || Object.keys(prices).length === 0) return;

  const sheet = ensureIntradaySheet();
  const priceStr = JSON.stringify(prices);
  const cellLimit = 45000;

  if (priceStr.length > cellLimit) {
    const symKeys = Object.keys(prices).sort();
    const chunks = [];
    let cur = {}, curLen = 2;
    for (const sym of symKeys) {
      const entry = JSON.stringify(sym) + ':' + JSON.stringify(prices[sym]) + ',';
      if (curLen + entry.length > cellLimit && Object.keys(cur).length > 0) {
        chunks.push(JSON.stringify(cur));
        cur = {};
        curLen = 2;
      }
      cur[sym] = prices[sym];
      curLen += entry.length;
    }
    if (Object.keys(cur).length > 0) chunks.push(JSON.stringify(cur));

    const rows = chunks.map((c, i) => [i === 0 ? ts : null, i === 0 ? label : null, c]);
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
  } else {
    sheet.appendRow([ts, label, priceStr]);
  }
}

function readIntradaySnapshots() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.INTRADAY_SHEET);
  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  const groups = {};

  for (const [tsVal, labelVal, pricesStr] of data) {
    if (!pricesStr) continue;
    const groupKey = tsVal ? String(tsVal) : '__cont__';
    if (!groups[groupKey] && tsVal) {
      groups[groupKey] = { ts: Number(tsVal), label: String(labelVal || ''), prices: {} };
    }
    try {
      Object.assign(groups[groupKey || '__cont__'].prices, JSON.parse(pricesStr));
    } catch (e) {}
  }

  return Object.values(groups).filter(g => g.ts > 0 && g.ts < 4102444800000).sort((a, b) => a.ts - b.ts);
}

function clearIntradaySheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.INTRADAY_SHEET);
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);
}

// ─── UPDATE NSE SINGLE ROW ───────────────────────────────────────────────────

function updateNSESingleRow(prices) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('NSE');
  if (!sheet) { console.warn('[MarketAI] NSE sheet missing'); return; }

  const lastRow = sheet.getLastRow();
  let existingSymbols = [];
  if (lastRow > 1) {
    existingSymbols = sheet.getRange(2, 1, lastRow - 1, 1)
      .getValues()
      .map(r => String(r[0] || '').trim())
      .filter(s => s.length > 0);
  }

  const maxRows = sheet.getMaxRows();
  const maxCols = sheet.getMaxColumns();
  if (maxRows > 1) sheet.deleteRows(2, maxRows - 1);
  if (maxCols > 2) sheet.deleteColumns(3, maxCols - 2);

  sheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
  const nowHeader = new Date();
  sheet.getRange(1, 2).setValue(nowHeader);
  sheet.getRange(1, 2).setNumberFormat('dd/MM/yyyy HH:mm');

  const rows = [];
  for (const sym of existingSymbols) {
    if (prices[sym] !== undefined) rows.push([sym, prices[sym]]);
  }
  for (const sym in prices) {
    if (!existingSymbols.includes(sym)) rows.push([sym, prices[sym]]);
  }

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  }

  console.log('[MarketAI] NSE single row updated: ' + rows.length + ' symbols');
}

// ─── 1-Min Intraday Capture ───────────────────────────────────────────────────

function captureIntradaySnapshot() {
  const startTime = Date.now();

  if (!isWeekday()) {
    console.log('[MarketAI] Weekend — skip');
    return;
  }
  if (!isMarketHours()) {
    console.log('[MarketAI] Outside market hours (' + getTimeIST() + ') — skip');
    return;
  }

  console.log('[MarketAI] Snapshot at ' + getTimeIST());

  const prices = captureOHLCSnapshot();
  if (!prices || Object.keys(prices).length === 0) {
    console.log('[MarketAI] No valid prices');
    return;
  }

  const hash = computePricesHash(prices);
  const props = PropertiesService.getScriptProperties();
  const prevHash = props.getProperty('lastSnapshotHash');

  if (hash === prevHash) {
    console.log('[MarketAI] No change — skip');
    return;
  }

  const ts = Date.now();
  const label = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd/MM/yyyy HH:mm');

  appendIntradaySnapshot(prices, ts, label);
  updateNSESingleRow(prices);

  props.setProperty('lastSnapshotHash', hash);
  console.log('[MarketAI] Snapshot stored (' + Object.keys(prices).length + ' symbols, ' + ((Date.now()-startTime)/1000).toFixed(1) + 's)');
}

// ─── GitHub Sync (EOD) ────────────────────────────────────────────────────────

function syncToGitHub() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN') || GITHUB_TOKEN;
  if (!token) {
    console.log('[GitHub] No GITHUB_TOKEN available — skipping sync');
    return;
  }

  const startTime = Date.now();
  const todaySnaps = readIntradaySnapshots();
  if (todaySnaps.length === 0) {
    console.log('[GitHub] No intraday snapshots to sync');
    return;
  }

  console.log('[GitHub] Read ' + todaySnaps.length + ' snapshots from _INTRADAY');

  let existing = { snapshots: [], symbols: [], lastSync: null };
  try {
    const raw = UrlFetchApp.fetch(
      'https://raw.githubusercontent.com/' + CONFIG.GITHUB_REPO + '/main/' + CONFIG.GITHUB_FILE,
      { muteHttpExceptions: true }
    );
    if (raw.getResponseCode() === 200) {
      existing = JSON.parse(raw.getContentText());
      console.log('[GitHub] Loaded existing: ' + existing.snapshots.length + ' snaps');
    }
  } catch (e) {
    console.log('[GitHub] No existing data, starting fresh');
  }

  const existingIds = new Set((existing.snapshots || []).map(s => s.id));
  const toAdd = todaySnaps.filter(s => !existingIds.has('s_' + s.ts));
  if (toAdd.length === 0) {
    console.log('[GitHub] No new snapshots to add');
    return;
  }

  for (const s of toAdd) {
    existing.snapshots.push({ id: 's_' + s.ts, ts: s.ts, label: s.label, prices: s.prices });
  }
  existing.snapshots.sort((a, b) => a.ts - b.ts);

  const allSyms = new Set();
  for (const s of existing.snapshots) {
    for (const sym in s.prices) allSyms.add(sym);
  }
  if (existing.symbols) {
    for (const sym of existing.symbols) allSyms.add(sym);
  }
  existing.symbols = [...allSyms].sort();
  existing.lastSync = Date.now();

  if (existing.snapshots.length > CONFIG.MAX_SNAPSHOTS) {
    existing.snapshots = existing.snapshots.slice(-CONFIG.MAX_SNAPSHOTS);
    console.log('[GitHub] Capped to ' + CONFIG.MAX_SNAPSHOTS + ' snapshots');
  }

  const content = JSON.stringify(existing);
  const msg = 'Market data: +' + toAdd.length + ' snaps, ' + existing.snapshots.length + ' total';

  const ok = gitCommitFile(CONFIG.GITHUB_REPO, CONFIG.GITHUB_FILE, content, token, msg);
  if (ok) {
    console.log('[GitHub] Sync OK: ' + existing.snapshots.length + ' snaps, ' + existing.symbols.length + ' syms (' + ((Date.now()-startTime)/1000).toFixed(1) + 's)');
    clearIntradaySheet();
  } else {
    console.log('[GitHub] Sync FAILED');
  }
}

// ─── Git Data API helpers ──────────────────────────────────────────────────────

function gitApi(url, token, method, payload) {
  const options = {
    method: method || 'GET',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
    contentType: 'application/json',
  };
  if (payload) options.payload = JSON.stringify(payload);
  return UrlFetchApp.fetch(url, options);
}

function gitCommitFile(repo, filePath, content, token, message) {
  const api = 'https://api.github.com/repos/' + repo;

  const blobRes = gitApi(api + '/git/blobs', token, 'POST', { content: content, encoding: 'utf-8' });
  const blob = JSON.parse(blobRes.getContentText());
  if (!blob.sha) { console.log('[Git] Blob creation failed'); return false; }

  const refRes = gitApi(api + '/git/refs/heads/main', token);
  const ref = JSON.parse(refRes.getContentText());
  if (!ref.object?.sha) { console.log('[Git] Failed to get ref'); return false; }
  const parentSha = ref.object.sha;

  const commitRes = gitApi(api + '/git/commits/' + parentSha, token);
  const commit = JSON.parse(commitRes.getContentText());
  if (!commit.tree?.sha) { console.log('[Git] Failed to get tree'); return false; }

  const treeRes = gitApi(api + '/git/trees', token, 'POST', {
    base_tree: commit.tree.sha,
    tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blob.sha }]
  });
  const tree = JSON.parse(treeRes.getContentText());
  if (!tree.sha) { console.log('[Git] Tree creation failed'); return false; }

  const newCommitRes = gitApi(api + '/git/commits', token, 'POST', {
    message: message,
    tree: tree.sha,
    parents: [parentSha]
  });
  const newCommit = JSON.parse(newCommitRes.getContentText());
  if (!newCommit.sha) { console.log('[Git] Commit creation failed'); return false; }

  const updateRes = gitApi(api + '/git/refs/heads/main', token, 'PATCH', { sha: newCommit.sha, force: false });
  return updateRes.getResponseCode() === 200;
}

// ─── EOD Trigger ──────────────────────────────────────────────────────────────

function logStockPrices() {
  const startTime = Date.now();
  console.log('[MarketAI EOD] Run at IST ' + getTimeIST());

  const prices = captureOHLCSnapshot();
  if (prices && Object.keys(prices).length > 0) {
    const ts = Date.now();
    const label = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd/MM/yyyy HH:mm');
    appendIntradaySnapshot(prices, ts, label);
    updateNSESingleRow(prices);
    console.log('[MarketAI EOD] Final snapshot appended');
  }

  syncToGitHub();

  console.log('[MarketAI EOD] Done in ' + ((Date.now()-startTime)/1000).toFixed(1) + 's');
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
  const toDelete = [];
  for (let r = 0; r < current.length; r++) {
    if (current[r] && !latestSet.has(current[r])) toDelete.push(r + 2);
  }
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

// ─── SETUP ────────────────────────────────────────────────────────────────────

function setupAll() {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  setupMarketSheetsInternal(ss);

  ScriptApp.newTrigger('captureIntradaySnapshot')
    .timeBased()
    .everyMinutes(CONFIG.INTRADAY_INTERVAL_MINUTES)
    .create();
  ScriptApp.newTrigger('logStockPrices').timeBased().atHour(15).nearMinute(40).everyDays(1).create();

  ensureIntradaySheet();

  const now = new Date().toISOString();
  props.setProperty('SETUP_DONE', now);
  props.setProperty('SETUP_VERSION', '3.0-github');
  props.deleteProperty('lastSnapshotHash');

  const msg =
    '✅ Full setup complete (' + now.replace('T', ' ').slice(0, 19) + ' IST+5:30)\n\n' +
    '• SYMBOLS sheet: GOOGLEFINANCE formulas refreshed\n' +
    '• NSE sheet: single-row format (latest prices)\n' +
    '• _INTRADAY sheet: created (hidden, for 1-min snapshots)\n' +
    '• Triggers: intraday every 1 min + EOD/GitHub sync at 15:40\n' +
    '• GitHub token: pre-configured ✓\n\n' +
    '• data.json on GitHub: 811 snaps, 2427 symbols migrated from Firebase ✓';
  try { ui.alert('MarketAI — Setup Complete', msg, ui.ButtonSet.OK); } catch (e) { console.log('[MarketAI] ' + msg); }
}

function setupMarketSheetsInternal(ss) {
  const symbolsSheet = ss.getSheetByName(CONFIG.SYMBOLS_SHEET);

  if (symbolsSheet) {
    const hdrLabels = ['SYMBOL'];
    CONFIG.MARKETS.forEach(m => hdrLabels.push(m.name, m.name + '_OPEN', m.name + '_HIGH', m.name + '_LOW'));
    const hdrRange = symbolsSheet.getRange(1, 1, 1, hdrLabels.length);
    hdrRange.setValues([hdrLabels]);
    hdrRange.setFontWeight('bold');

    const lastRow = symbolsSheet.getLastRow();
    if (lastRow > 1) {
      const symValues = symbolsSheet.getRange(2, 1, lastRow - 1, 1).getValues();
      CONFIG.MARKETS.forEach(market => {
        [['price', 0], ['open', 1], ['high', 2], ['low', 3]].forEach(([ft, fi]) => {
          const col = market.closeCol + fi;
          const formulas = symValues.map((r, ri) => {
            const sym = String(r[0] || '').trim();
            return sym ? [`=IF(A${ri + 2}="","",GOOGLEFINANCE("${market.prefix}:"&A${ri + 2},"${ft}"))`] : [''];
          });
          symbolsSheet.getRange(2, col, formulas.length, 1).setFormulas(formulas);
        });
      });
    }
  }

  CONFIG.MARKETS.forEach(market => {
    let sheet = ss.getSheetByName(market.sheet);
    if (!sheet) {
      sheet = ss.insertSheet(market.sheet);
      sheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
      sheet.getRange(1, 2).setValue('Latest').setFontWeight('bold');
    } else {
      const maxCols = sheet.getMaxColumns();
      if (maxCols > 2) sheet.deleteColumns(3, maxCols - 2);
      sheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');
      sheet.getRange(1, 2).setValue('Latest').setFontWeight('bold');
      const maxRows = sheet.getMaxRows();
      if (maxRows > 1) {
        const symbols = sheet.getRange(2, 1, maxRows - 1, 1).getValues().map(r => String(r[0] || '').trim()).filter(Boolean);
        if (symbols.length > 0) {
          const symSheet = ss.getSheetByName(CONFIG.SYMBOLS_SHEET);
          if (symSheet && symSheet.getLastRow() > 1) {
            const allSyms = symSheet.getRange(2, 1, symSheet.getLastRow() - 1, 1).getValues().map(r => String(r[0] || '').trim()).filter(Boolean);
            sheet.getRange(2, 1, sheet.getMaxRows() - 1, 2).clearContent();
            if (allSyms.length > 0) {
              sheet.getRange(2, 1, allSyms.length, 1).setValues(allSyms.map(s => [s]));
            }
          }
        }
      }
    }
  });
}

function setupMarketSheets() {
  setupMarketSheetsInternal(SpreadsheetApp.getActiveSpreadsheet());
  try { SpreadsheetApp.getUi().alert('✓ Market Sheets ready with single-row + GitHub architecture'); } catch (e) { console.log('[MarketAI] Market sheets ready'); }
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('captureIntradaySnapshot')
    .timeBased()
    .everyMinutes(CONFIG.INTRADAY_INTERVAL_MINUTES)
    .create();
  ScriptApp.newTrigger('logStockPrices').timeBased().atHour(15).nearMinute(40).everyDays(1).create();
  const msg =
    '✓ Triggers set:\n' +
    '• Intraday: every 1 min (Mon-Fri 9:15-15:30 IST)\n' +
    '• EOD/GitHub: 15:40 IST';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log('[MarketAI] ' + msg.replace(/\n/g, ' · ')); }
}

// ─── TRIGGER MAINTENANCE ─────────────────────────────────────────────────────

const REQUIRED_TRIGGER_FUNCS = ['captureIntradaySnapshot', 'logStockPrices'];

function ensureTriggers() {
  const existing = ScriptApp.getProjectTriggers();
  const active = new Set(existing.map(t => t.getHandlerFunction()));
  const missing = REQUIRED_TRIGGER_FUNCS.filter(f => !active.has(f));

  if (missing.length === 0 && existing.length >= 2) {
    console.log('[MarketAI] All triggers present');
    return { repaired: false, missing: [] };
  }

  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('captureIntradaySnapshot')
    .timeBased()
    .everyMinutes(CONFIG.INTRADAY_INTERVAL_MINUTES)
    .create();
  ScriptApp.newTrigger('logStockPrices').timeBased().atHour(15).nearMinute(40).everyDays(1).create();

  const msg = missing.length > 0
    ? 'Repaired ' + missing.length + ' missing trigger(s): ' + missing.join(', ')
    : 'Re-synced ' + REQUIRED_TRIGGER_FUNCS.length + ' triggers';
  console.log('[MarketAI] ' + msg);
  return { repaired: true, missing };
}

// ─── FORCE FUNCTIONS ─────────────────────────────────────────────────────────

function forceSnapshotNow() {
  captureIntradaySnapshot();
}
function forceEODNow() {
  logStockPrices();
}
function forceGitHubSync() {
  syncToGitHub();
}
function forceRepairTriggersNow() {
  const result = ensureTriggers();
  const msg = result.repaired ? '✓ Triggers repaired and re-synced.' : '✓ All triggers present.';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log('[MarketAI] ' + msg); }
}

// ─── MENU ─────────────────────────────────────────────────────────────────────

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const setupDone = props.getProperty('SETUP_DONE');

  ui.createMenu('MarketAI')
    .addItem('⚡ Full Setup (one-click)', 'setupAll')
    .addSeparator()
    .addSeparator()
    .addItem('Force Snapshot Now', 'forceSnapshotNow')
    .addItem('Force EOD + GitHub Sync', 'forceEODNow')
    .addItem('Force GitHub Sync Only', 'forceGitHubSync')
    .addSeparator()
    .addItem('Set GitHub Token', 'setGitHubTokenUI')
    .addItem('Recreate Market Sheets', 'setupMarketSheets')
    .addItem('Reset Triggers', 'setupTriggers')
    .addItem('Repair Triggers', 'forceRepairTriggersNow')
    .addToUi();

  if (!setupDone) {
    try {
      const response = ui.alert(
        'MarketAI — First-Time Setup',
        'This sheet needs a one-time setup:\n\n' +
        '• Install GOOGLEFINANCE formulas in SYMBOLS sheet\n' +
        '• Create _INTRADAY hidden sheet for intraday snapshots\n' +
        '• Set 1-minute intraday trigger + EOD/GitHub trigger\n\n' +
        'Run setup now?',
        ui.ButtonSet.YES_NO
      );
      if (response === ui.Button.YES) {
        setupAll();
      } else {
        props.setProperty('SETUP_DEFERRED', new Date().toISOString());
        ui.alert('Setup deferred. Run MarketAI → ⚡ Full Setup (one-click) when ready.');
      }
    } catch (e) {
      console.error('[MarketAI] onOpen setup error:', e.message);
      setupAll();
    }
  } else {
    try { ensureTriggers(); } catch (e) { console.error('[MarketAI] ensureTriggers error:', e.message); }
  }
}

function setGitHubTokenUI() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    'Set GitHub Token',
    'Enter your GitHub PAT (or leave blank to use the pre-configured token):',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() === ui.Button.OK) {
    const token = response.getResponseText().trim();
    if (token) {
      PropertiesService.getScriptProperties().setProperty('GITHUB_TOKEN', token);
    }
    ui.alert('✓ GitHub Token ready.');
  }
}
