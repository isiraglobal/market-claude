// ===============================================================================
//  MarketAI — Google Apps Script
//
//  09:00 daily — reset NSE sheet (clear columns B+), if trading day
//  09:15-15:30 IST every 1 min — capture prices, append column to NSE sheet
//  15:40 IST (EOD) — read NSE columns → merge with GitHub data.json → commit
//
//  Respects NSE holiday calendar. No duplicate snapshots across days.
//  Only appends when prices actually change (hash comparison).
// ===============================================================================

const CONFIG = {
  SYMBOLS_SHEET: 'SYMBOLS',
  TIMEZONE: 'Asia/Kolkata',
  NSE_MARKET_OPEN: '09:15',
  NSE_MARKET_CLOSE: '15:30',
  GITHUB_REPO: 'isiraglobal/market-claude',
  GITHUB_FILE: 'data.json',
  MAX_SNAPSHOTS: 2000,
};

const maxCol = 5;
const badValues = ['#N/A','#ERROR!','#VALUE!','#REF!','#NUM!','Loading...',''];

const NSE_HOLIDAYS = {
  2026: [
    '2026-01-26', // Republic Day
    '2026-03-03', // Holi
    '2026-03-26', // Shri Ram Navami
    '2026-03-31', // Shri Mahavir Jayanti
    '2026-04-03', // Good Friday
    '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
    '2026-05-01', // Maharashtra Day
    '2026-05-28', // Bakri Id
    '2026-06-26', // Muharram
    '2026-09-14', // Ganesh Chaturthi
    '2026-10-02', // Mahatma Gandhi Jayanti
    '2026-10-20', // Dussehra
    '2026-11-10', // Diwali-Balipratipada
    '2026-11-24', // Prakash Gurpurb Sri Guru Nanak Dev
    '2026-12-25', // Christmas
  ],
};

function getDateStr() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function getTimeIST() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'HH:mm');
}

function getDateLabelIST() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd/MM/yyyy HH:mm');
}

function minutesSinceMidnight(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function isMarketHours() {
  const now = minutesSinceMidnight(getTimeIST());
  return now >= minutesSinceMidnight(CONFIG.NSE_MARKET_OPEN)
      && now <= minutesSinceMidnight(CONFIG.NSE_MARKET_CLOSE);
}

function isTradingDay() {
  const d = new Date().getDay();
  if (d === 0 || d === 6) return false;
  const today = getDateStr();
  const year = new Date().getFullYear();
  const holidays = NSE_HOLIDAYS[year] || [];
  return !holidays.includes(today);
}

function computePricesHash(prices) {
  const sorted = Object.keys(prices).sort();
  const str = sorted.map(k => k + ':' + prices[k]).join('|');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str);
  return digest.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function captureOHLCSnapshot() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const symbolsSheet = ss.getSheetByName(CONFIG.SYMBOLS_SHEET);
  if (!symbolsSheet) { console.warn('[MarketAI] SYMBOLS sheet missing'); return null; }

  const lastRow = symbolsSheet.getLastRow();
  if (lastRow < 2) return null;

  // Clear and rewrite GOOGLEFINANCE formulas to break Google Sheets caching when spreadsheet is closed
  const range = symbolsSheet.getRange(2, 2, lastRow - 1, 4); // Columns B, C, D, E
  const formulas = range.getFormulas();
  if (formulas && formulas.length > 0 && formulas[0].length > 0) {
    console.log('[MarketAI] Forcing GOOGLEFINANCE formulas to refresh...');
    range.clearContent();
    SpreadsheetApp.flush();
    Utilities.sleep(1000); // Wait 1 sec
    range.setFormulas(formulas);
    SpreadsheetApp.flush();
    console.log('[MarketAI] Formulas re-written. Waiting 6 seconds for Google Sheets recalculation...');
    Utilities.sleep(6000); // Wait 6 seconds for values to load
  }

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

function nseSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('NSE');
}

function resetSheetDaily() {
  if (!isTradingDay()) { console.log('[MarketAI] Holiday/weekend — no reset'); return; }

  const sheet = nseSheet();
  if (!sheet) return;

  const today = getDateStr();
  const props = PropertiesService.getScriptProperties();
  const lastReset = props.getProperty('sheetResetDate');
  if (lastReset === today) return;

  const lastCol = sheet.getLastColumn();
  if (lastCol > 1) {
    sheet.deleteColumns(2, lastCol - 1);
  }
  sheet.getRange(1, 1).setValue('Symbol').setFontWeight('bold');

  props.setProperty('sheetResetDate', today);
  props.deleteProperty('lastSnapshotHash');
  console.log('[MarketAI] NSE sheet reset for ' + today);
}

function appendMinuteColumn() {
  if (!isTradingDay()) { console.log('[MarketAI] Holiday/weekend — skip'); return; }
  if (!isMarketHours()) { console.log('[MarketAI] Outside market hours — skip'); return; }

  resetSheetDaily();

  const prices = captureOHLCSnapshot();
  if (!prices || Object.keys(prices).length === 0) { console.log('[MarketAI] No valid prices'); return; }

  const hash = computePricesHash(prices);
  const props = PropertiesService.getScriptProperties();
  const prevHash = props.getProperty('lastSnapshotHash');
  if (hash === prevHash) { console.log('[MarketAI] No change — skip'); return; }
  props.setProperty('lastSnapshotHash', hash);

  const sheet = nseSheet();
  if (!sheet) { console.log('[MarketAI] NSE sheet missing'); return; }

  const label = getDateLabelIST();
  const syms = Object.keys(prices);
  const existingSyms = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().map(r => String(r[0] || '').trim())
    : [];

  const allSyms = [...new Set([...existingSyms, ...syms])];
  const newCol = sheet.getLastColumn() + 1;

  sheet.getRange(1, newCol).setValue(label);
  sheet.getRange(1, newCol).setNumberFormat('dd/MM/yyyy HH:mm');

  if (allSyms.length > 0) {
    if (sheet.getLastRow() < 2) {
      sheet.getRange(2, 1, allSyms.length, 1).setValues(allSyms.map(s => [s]));
    }
    const rows = allSyms.map(sym => [prices[sym] !== undefined ? prices[sym] : '']);
    sheet.getRange(2, newCol, allSyms.length, 1).setValues(rows);
  }

  console.log('[MarketAI] Column appended: ' + allSyms.length + ' symbols at ' + label);
}

function logStockPrices() {
  if (!isTradingDay()) { console.log('[MarketAI EOD] Holiday/weekend — skip'); return; }

  const startTime = Date.now();
  console.log('[MarketAI EOD] Run at IST ' + getTimeIST());

  const sheet = nseSheet();
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 2) {
    console.log('[MarketAI EOD] No data in NSE sheet');
    return;
  }

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const snapshots = [];

  for (let c = 1; c < headers.length; c++) {
    const label = String(headers[c] || '').trim();
    if (!label) continue;
    const parsed = new Date(label);
    const ts = parsed.getTime();
    if (isNaN(ts)) continue;

    const prices = {};
    for (let r = 1; r < data.length; r++) {
      const sym = String(data[r][0] || '').trim();
      if (sym && data[r][c] !== undefined && String(data[r][c]).trim() !== '') {
        const val = String(data[r][c]).trim();
        const parts = val.split(',');
        if (parts.length === 4) {
          const cVal = parseFloat(parts[0]);
          const oVal = parseFloat(parts[1]);
          const hVal = parseFloat(parts[2]);
          const lVal = parseFloat(parts[3]);
          if (isFinite(cVal) && cVal > 0 && isFinite(oVal) && oVal > 0 && isFinite(hVal) && hVal > 0 && isFinite(lVal) && lVal > 0) {
            prices[sym] = { c: cVal, o: oVal, h: hVal, l: lVal };
          }
        } else {
          const numVal = parseFloat(val);
          if (isFinite(numVal) && numVal > 0) {
            prices[sym] = numVal;
          }
        }
      }
    }
    if (Object.keys(prices).length > 0) {
      snapshots.push({ id: 's_' + ts, ts, label, prices });
    }
  }

  if (snapshots.length === 0) {
    console.log('[MarketAI EOD] No valid snapshots found');
    return;
  }

  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  if (!token) { console.log('[GitHub] No GITHUB_TOKEN set — skipping sync'); return; }

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
  const toAdd = snapshots.filter(s => !existingIds.has(s.id));
  if (toAdd.length === 0) {
    console.log('[GitHub] No new snapshots to add');
    return;
  }

  for (const s of toAdd) {
    existing.snapshots.push(s);
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
    console.log('[GitHub] Sync OK: ' + existing.snapshots.length + ' snaps (' + ((Date.now()-startTime)/1000).toFixed(1) + 's)');
  } else {
    console.log('[GitHub] Sync FAILED');
  }

  // ── Supabase Sync ────────────────────────────────────────────────────────
  const supabaseUrl = props.getProperty('SUPABASE_URL');
  const supabaseKey = props.getProperty('SUPABASE_KEY');
  if (supabaseUrl && supabaseKey) {
    try {
      const baseUrl = supabaseUrl.replace(/\/$/, '');
      
      // 1. Extract and upsert unique symbols to "stocks" table
      const symbolsSet = new Set();
      for (const s of snapshots) {
        if (s.prices) {
          for (const sym in s.prices) symbolsSet.add(sym);
        }
      }
      const uniqueSymbols = Array.from(symbolsSet);
      const symbolsPayload = uniqueSymbols.map(sym => ({ sym: sym }));
      
      console.log('[Supabase] Upserting ' + uniqueSymbols.length + ' symbols...');
      const symBatchSize = 500;
      for (let i = 0; i < symbolsPayload.length; i += symBatchSize) {
        const chunk = symbolsPayload.slice(i, i + symBatchSize);
        UrlFetchApp.fetch(baseUrl + '/rest/v1/stocks', {
          method: 'POST',
          headers: {
            'apikey': supabaseKey,
            'Authorization': 'Bearer ' + supabaseKey,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          payload: JSON.stringify(chunk),
          muteHttpExceptions: true
        });
      }

      // 2. Flatten and batch upsert price rows to "stock_prices" table
      const pricesPayload = [];
      for (const s of snapshots) {
        if (s.prices) {
          for (const sym in s.prices) {
            const val = s.prices[sym];
            let close, open = null, high = null, low = null;
            if (typeof val === 'number') {
              close = val;
            } else if (val && typeof val === 'object') {
              close = val.c;
              open = val.o;
              high = val.h;
              low = val.l;
            }
            pricesPayload.push({
              sym: sym,
              ts: s.ts,
              label: s.label,
              close: close,
              open: open,
              high: high,
              low: low
            });
          }
        }
      }

      console.log('[Supabase] Upserting ' + pricesPayload.length + ' price rows in batches...');
      const priceBatchSize = 2000;
      let okCount = 0;
      for (let i = 0; i < pricesPayload.length; i += priceBatchSize) {
        const chunk = pricesPayload.slice(i, i + priceBatchSize);
        const res = UrlFetchApp.fetch(baseUrl + '/rest/v1/stock_prices', {
          method: 'POST',
          headers: {
            'apikey': supabaseKey,
            'Authorization': 'Bearer ' + supabaseKey,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          payload: JSON.stringify(chunk),
          muteHttpExceptions: true
        });
        if (res.getResponseCode() === 200 || res.getResponseCode() === 201) {
          okCount += chunk.length;
        } else {
          console.log('[Supabase] Price batch upsert failed: Code ' + res.getResponseCode() + ' - ' + res.getContentText().slice(0, 150));
        }
      }
      console.log('[Supabase] Price sync OK: ' + okCount + ' of ' + pricesPayload.length + ' rows upserted');
    } catch (e) {
      console.log('[Supabase] Sync Error: ' + e.message);
    }
  } else {
    console.log('[Supabase] No credentials set — skipping sync');
  }
}

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

function setGitHubToken(token) {
  if (token) {
    PropertiesService.getScriptProperties().setProperty('GITHUB_TOKEN', token);
  }
}

function setupAll() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('resetSheetDaily')
    .timeBased()
    .atHour(9)
    .nearMinute(0)
    .everyDays(1)
    .create();

  ScriptApp.newTrigger('appendMinuteColumn')
    .timeBased()
    .everyMinutes(1)
    .create();

  ScriptApp.newTrigger('logStockPrices')
    .timeBased()
    .atHour(15)
    .nearMinute(40)
    .everyDays(1)
    .create();

  const msg =
    'Setup complete:\n' +
    '• Sheet reset: daily at 09:00 IST\n' +
    '• Intraday: every 1 min (trading days, 9:15-15:30 IST)\n' +
    '• Appends new column to NSE sheet each minute (no duplicates)\n' +
    '• EOD sync: 15:40 IST → commits fresh data to GitHub data.json\n' +
    '• NSE holidays respected ✓\n' +
    '• ⚠ Set GitHub token via MarketAI → Set GitHub Token';

  try { SpreadsheetApp.getUi().alert('MarketAI — Setup Complete', msg, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { console.log('[MarketAI] ' + msg); }
}

function setGitHubTokenUI() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    'Set GitHub Token',
    'Enter your GitHub PAT:',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() === ui.Button.OK) {
    const token = response.getResponseText().trim();
    setGitHubToken(token);
    ui.alert('\u2713 GitHub Token saved.');
  }
}

function onOpen() {
  const ui = SpreadsheetApp.getUi();

  ui.createMenu('MarketAI')
    .addItem('\u26A1 Full Setup (one-click)', 'setupAll')
    .addSeparator()
    .addItem('Sync to GitHub Now', 'logStockPrices')
    .addSeparator()
    .addItem('Set GitHub Token', 'setGitHubTokenUI')
    .addToUi();
}
