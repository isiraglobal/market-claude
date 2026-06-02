// netlify/functions/sync.js
// Called by cron (Netlify Scheduled Functions) and by the frontend on open.
// Reads Sheet2 CSV → merges into the persistent data pool → writes back.

const https = require("https");
const fs = require("fs");
const path = require("path");

const SHEET_ID = "10Wha7-e2_51oaK8MaJfvC6RacmHptXuKvtHMQBIvVXY";
const SHEET_TAB = "Sheet2";
const DATA_FILE = path.join(__dirname, "../../data.json");
const MAX_SNAPSHOTS = 200; // keep up to 200 snapshots (10 days × ~20 per day)

// ── helpers ───────────────────────────────────────────────────────────────────
function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "MarketAI-Sync/1.0" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

function parseCSV(text, maxCols = 200) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];
  
  const headerParts = lines[0].split(",");
  const totalCols = headerParts.length;
  
  // We keep column 0 (Symbols) and up to the last maxCols columns
  const keepCols = [0];
  const startCol = Math.max(1, totalCols - maxCols);
  for (let c = startCol; c < totalCols; c++) {
    keepCols.push(c);
  }
  
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const parts = line.split(",");
    const cells = [];
    for (let j = 0; j < keepCols.length; j++) {
      const colIdx = keepCols[j];
      if (colIdx < parts.length) {
        cells.push(parts[colIdx]);
      } else {
        cells.push("");
      }
    }
    rows.push(cells);
  }
  return rows;
}

function clean(v) {
  if (!v) return "";
  let s = v.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function parseTimestamp(raw) {
  const s = clean(raw);
  if (!s || s === "SYMBOL") return null;
  if (/^\d{10,}$/.test(s)) {
    const ts = +s;
    // Validate timestamp is reasonable (after 2000, before 2100)
    if (ts >= 946684800000 && ts <= 4102444800000) return ts;
    return null;
  }
  const gviz = s.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/i);
  if (gviz) {
    const [,yr,mo,day,hh=0,mm=0,ss=0] = gviz;
    const yr_num = +yr;
    // Validate year is reasonable (2000-2100)
    if (yr_num < 2000 || yr_num > 2100) return null;
    const ts = new Date(yr_num,+mo,+day,+hh,+mm,+ss).getTime();
    return isNaN(ts) ? null : ts;
  }
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (dmy) {
    const [,day,mon,yr,hh,mm,ss="00"] = dmy;
    const yr_num = +yr;
    if (yr_num < 2000 || yr_num > 2100) return null;
    const ts = new Date(`${yr}-${mon.padStart(2,"0")}-${day.padStart(2,"0")}T${hh.padStart(2,"0")}:${mm}:${ss}`).getTime();
    return isNaN(ts) ? null : ts;
  }
  const d = new Date(s);
  const ts = d.getTime();
  if (!isNaN(ts) && ts >= 946684800000 && ts <= 4102444800000) return ts;
  return null;
}

function parsePrice(raw) {
  if (!raw) return null;
  let s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).trim();
  }
  if (!s || s === "#N/A" || s === "N/A" || s === "#VALUE!" || s === "#REF!" || s === "#ERROR!" || s === "#NUM!") return null;
  let n = parseFloat(s);
  if (isNaN(n)) {
    n = parseFloat(s.replace(/[^\d.-]/g,""));
  }
  return isFinite(n) && n > 0 ? n : null;
}

function parseSheet(csvText) {
  const rows = parseCSV(csvText, MAX_SNAPSHOTS);
  if (rows.length < 2) return { snapshots: [], symbols: [] };
  const header = rows[0];
  const meta = [];
  for (let c = 1; c < header.length; c++) {
    const ts = parseTimestamp(header[c]);
    if (ts) meta.push({ col: c, label: clean(header[c]), ts });
  }
  const priceMap = {};
  meta.forEach(m => { priceMap[m.ts + "_" + m.col] = {}; });
  const syms = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const sym = clean(row[0]).toUpperCase().replace(/\s+/g,"");
    if (!sym || sym === "SYMBOL") continue;
    for (const m of meta) {
      const p = parsePrice(row[m.col]);
      if (p !== null) { priceMap[m.ts + "_" + m.col][sym] = p; syms.add(sym); }
    }
  }
  const snapshots = meta
    .map(m => ({ id: `snap_${m.ts}_${m.col}`, ts: m.ts, label: m.label, prices: priceMap[m.ts + "_" + m.col] }))
    .filter(s => Object.keys(s.prices).length > 0)
    .sort((a,b) => a.ts - b.ts);
  return { snapshots, symbols: [...syms].sort() };
}

function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch(e) {}
  return { snapshots: [], symbols: [], lastSync: null, syncCount: 0 };
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

// ── main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };

  try {
    const ts = Date.now();
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_TAB)}&t=${ts}`;
    const resp = await fetchURL(url);

    if (resp.status !== 200) throw new Error(`Sheet returned HTTP ${resp.status}`);
    if (resp.body.toLowerCase().startsWith("<!doctype")) throw new Error("Got HTML instead of CSV — sheet may not be public");

    const { snapshots: newSnaps, symbols: newSyms } = parseSheet(resp.body);
    if (newSnaps.length === 0) throw new Error("No valid snapshots parsed from sheet");

    // Merge with existing pool
    const pool = readData();
    const existingIds = new Set((pool.snapshots || []).map(s => s.id));
    const added = newSnaps.filter(s => !existingIds.has(s.id));

    // Validate snapshots before adding
    const validAdded = added.filter(snap => {
      if (!snap.id || !snap.ts || typeof snap.ts !== 'number') return false;
      if (!snap.prices || typeof snap.prices !== 'object') return false;
      // Validate all prices are valid numbers
      for (const sym in snap.prices) {
        const p = snap.prices[sym];
        if (typeof p !== 'number' || !isFinite(p) || p <= 0) return false;
      }
      return true;
    });

    pool.snapshots = [...(pool.snapshots || []), ...validAdded];

    // Keep last MAX_SNAPSHOTS (rolling window — matches App Script's 10-day rolling)
    if (pool.snapshots.length > MAX_SNAPSHOTS) {
      pool.snapshots = pool.snapshots.slice(pool.snapshots.length - MAX_SNAPSHOTS);
    }
    // Sort and deduplicate by timestamp+id
    const seen = new Set();
    pool.snapshots = pool.snapshots.filter(s => {
      const key = s.ts + '_' + s.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a,b) => a.ts - b.ts);

    // Rebuild symbol list from all retained snapshots
    const allSyms = new Set();
    pool.snapshots.forEach(s => Object.keys(s.prices).forEach(k => allSyms.add(k)));
    pool.symbols = [...allSyms].sort();
    pool.lastSync = Date.now();
    pool.syncCount = (pool.syncCount || 0) + 1;
    pool.snapshotsAdded = added.length;

    writeData(pool);

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        ok: true,
        snapshotsAdded: added.length,
        totalSnapshots: pool.snapshots.length,
        totalSymbols: pool.symbols.length,
        lastSync: pool.lastSync
      })
    };
  } catch(err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};
