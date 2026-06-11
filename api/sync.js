// api/sync.js
// Fetches Google Sheet prices (Sheet1 and Sheet2) → merges into Vercel KV or local files

const fs = require("fs");
const path = require("path");
const https = require("https");

const SHEET_ID = "10Wha7-e2_51oaK8MaJfvC6RacmHptXuKvtHMQBIvVXY";
const DATA_FILE = path.join(__dirname, "../data.json");

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const MAX_SNAPSHOTS = 200; // Rolling window size

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
};

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "MarketAI-Sync/1.0" } }, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

function requestREST(url, method, body = null) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: method,
        headers: {
          Authorization: `Bearer ${KV_TOKEN}`,
          "Content-Type": "application/json"
        }
      };
      const req = https.request(options, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => responseBody += chunk);
        res.on("end", () => {
          try { resolve(JSON.parse(responseBody)); }
          catch (e) { resolve({ error: "Invalid JSON", body: responseBody }); }
        });
      });
      req.on("error", reject);
      if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
      req.end();
    } catch (err) { reject(err); }
  });
}

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const res = await requestREST(`${KV_URL}/get/${key}`, "GET");
    return res.result ? JSON.parse(res.result) : null;
  } catch (e) { return null; }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    await requestREST(`${KV_URL}/set/${key}`, "POST", JSON.stringify(value));
    return true;
  } catch (e) { return false; }
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const cells = [];
    let cur = "", inQ = false;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (c === '"') {
        if (inQ && line[j + 1] === '"') { cur += '"'; j++; }
        else { inQ = !inQ; }
      } else if (c === ',' && !inQ) {
        cells.push(cur.trim());
        cur = "";
      } else {
        cur += c;
      }
    }
    cells.push(cur.trim());
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
    if (ts >= 946684800000 && ts <= 4102444800000) return ts;
    return null;
  }
  const gviz = s.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/i);
  if (gviz) {
    const [, yr, mo, day, hh = 0, mm = 0, ss = 0] = gviz;
    const yr_num = +yr;
    if (yr_num < 2000 || yr_num > 2100) return null;
    const ts = new Date(yr_num, +mo, +day, +hh, +mm, +ss).getTime();
    return isNaN(ts) ? null : ts;
  }
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (dmy) {
    const [, day, mon, yr, hh, mm, ss = "00"] = dmy;
    const yr_num = +yr;
    if (yr_num < 2000 || yr_num > 2100) return null;
    const ts = new Date(`${yr}-${mon.padStart(2, "0")}-${day.padStart(2, "0")}T${hh.padStart(2, "0")}:${mm}:${ss}`).getTime();
    return isNaN(ts) ? null : ts;
  }
  const d = new Date(s);
  const ts = d.getTime();
  if (!isNaN(ts) && ts >= 946684800000 && ts <= 4102444800000) return ts;
  return null;
}

function parsePrice(raw) {
  if (!raw) return null;
  let s = clean(raw);
  if (!s || ["#N/A", "N/A", "#VALUE!", "#REF!", "#ERROR!", "#NUM!"].includes(s)) return null;
  let n = parseFloat(s);
  if (isNaN(n)) n = parseFloat(s.replace(/[^\d.-]/g, ""));
  return isFinite(n) && n > 0 ? n : null;
}

// Banded DP Sequence Alignment to fix symbol mapping for old format
function alignRows(s1, s2) {
  const N = s2.length - 1; // s2 rows (prices)
  const M = s1.length - 1; // s1 rows (symbols)
  const W = 30; // band width

  const dp = Array.from({ length: N + 1 }, () => ({}));
  const parent = Array.from({ length: N + 1 }, () => ({}));

  function getScore(i, j) {
    const s2Row = s2[i];
    const s2Price = parseFloat(s2Row[s2Row.length - 1]);
    const s1Price = parseFloat(s1[j][4]);
    if (isNaN(s2Price) || isNaN(s1Price) || s2Price <= 0 || s1Price <= 0) return -10;
    const diff = Math.abs(s2Price - s1Price) / s1Price;
    return diff < 0.05 ? 10 - diff * 100 : -10;
  }

  dp[0][0] = 0;

  for (let i = 0; i <= N; i++) {
    const startJ = Math.max(0, i - W);
    const endJ = Math.min(M, i + W);
    for (let j = startJ; j <= endJ; j++) {
      if (dp[i][j] === undefined || dp[i][j] === -Infinity) continue;

      // Match
      if (i < N && j < M && Math.abs((i + 1) - (j + 1)) <= W) {
        const nextScore = dp[i][j] + getScore(i + 1, j + 1);
        if (dp[i + 1][j + 1] === undefined || nextScore > dp[i + 1][j + 1]) {
          dp[i + 1][j + 1] = nextScore;
          parent[i + 1][j + 1] = { prev_i: i, prev_j: j, action: "match" };
        }
      }

      // Skip s2 row
      if (i < N && Math.abs((i + 1) - j) <= W) {
        const nextScore = dp[i][j] - 2;
        if (dp[i + 1][j] === undefined || nextScore > dp[i + 1][j]) {
          dp[i + 1][j] = nextScore;
          parent[i + 1][j] = { prev_i: i, prev_j: j, action: "skip_s2" };
        }
      }

      // Skip s1 row
      if (j < M && Math.abs(i - (j + 1)) <= W) {
        const nextScore = dp[i][j] - 1;
        if (dp[i][j + 1] === undefined || nextScore > dp[i][j + 1]) {
          dp[i][j + 1] = nextScore;
          parent[i][j + 1] = { prev_i: i, prev_j: j, action: "skip_s1" };
        }
      }
    }
  }

  let best_j = M;
  let max_score = -Infinity;
  for (let j = Math.max(0, N - W); j <= Math.min(M, N + W); j++) {
    if (dp[N][j] !== undefined && dp[N][j] > max_score) {
      max_score = dp[N][j];
      best_j = j;
    }
  }

  let curr_i = N, curr_j = best_j;
  const mapping = {};
  while (curr_i > 0 || curr_j > 0) {
    const p = parent[curr_i]?.[curr_j];
    if (!p) break;
    if (p.action === "match") mapping[curr_i] = s1[curr_j][0];
    curr_i = p.prev_i;
    curr_j = p.prev_j;
  }
  return mapping;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(200, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method === "DELETE") {
    // Clear data pool
    const emptyPool = { snapshots: [], symbols: [], lastSync: null, syncCount: 0 };
    if (KV_URL && KV_TOKEN) await kvSet("market-data", emptyPool);
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(emptyPool, null, 2), "utf8"); } catch(e) {}
    res.writeHead(200, CORS_HEADERS);
    res.end(JSON.stringify({ ok: true, message: "Market data cleared" }));
    return;
  }

  try {
    const ts = Date.now();
    // 1. Fetch Sheet1 (Current Prices)
    const s1Url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Sheet1&t=${ts}`;
    const s1Resp = await fetchURL(s1Url);
    if (s1Resp.status !== 200) throw new Error(`Sheet1 returned HTTP ${s1Resp.status}`);
    const s1Rows = parseCSV(s1Resp.body);

    // 2. Fetch Sheet2 (Price History)
    const s2Url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Sheet2&t=${ts}`;
    const s2Resp = await fetchURL(s2Url);
    if (s2Resp.status !== 200) throw new Error(`Sheet2 returned HTTP ${s2Resp.status}`);
    const s2Rows = parseCSV(s2Resp.body);

    if (s2Rows.length < 2) throw new Error("No snapshots parsed from Sheet2");

    const header = s2Rows[0];
    const firstColHeader = clean(header[0]).toUpperCase();
    
    // Check if new format (first column is symbol name)
    const isNewFormat = firstColHeader === "SYMBOL" || isNaN(parseFloat(s2Rows[1][0]));
    
    let mapping = {};
    if (!isNewFormat) {
      // Run DP sequence alignment to map sheet2 rows to sheet1 symbols
      mapping = alignRows(s1Rows, s2Rows);
    }

    // Extract timestamps from columns
    const meta = [];
    const startCol = isNewFormat ? 1 : 0;
    
    // Process only the last MAX_SNAPSHOTS columns to keep payload small
    const colLimit = Math.max(startCol, header.length - MAX_SNAPSHOTS);
    for (let c = colLimit; c < header.length; c++) {
      const colTs = parseTimestamp(header[c]);
      if (colTs) meta.push({ col: c, label: clean(header[c]), ts: colTs });
    }

    // Initialize prices map
    const priceMap = {};
    meta.forEach(m => { priceMap[m.ts + "_" + m.col] = {}; });
    const symsSet = new Set();

    for (let r = 1; r < s2Rows.length; r++) {
      const row = s2Rows[r];
      let sym = "";
      if (isNewFormat) {
        sym = clean(row[0]).toUpperCase().replace(/\s+/g, "");
      } else {
        sym = mapping[r]; // mapped via DP
      }

      if (!sym || sym === "SYMBOL") continue;

      for (const m of meta) {
        const p = parsePrice(row[m.col]);
        if (p !== null) {
          priceMap[m.ts + "_" + m.col][sym] = p;
          symsSet.add(sym);
        }
      }
    }

    const newSnaps = meta
      .map(m => ({
        id: `snap_${m.ts}_${m.col}`,
        ts: m.ts,
        label: m.label,
        prices: priceMap[m.ts + "_" + m.col]
      }))
      .filter(s => Object.keys(s.prices).length > 0)
      .sort((a, b) => a.ts - b.ts);

    // Merge with existing pool
    let pool = null;
    if (KV_URL && KV_TOKEN) {
      pool = await kvGet("market-data");
    }
    if (!pool) {
      try {
        if (fs.existsSync(DATA_FILE)) {
          pool = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
        }
      } catch (e) {}
    }
    if (!pool) {
      pool = { snapshots: [], symbols: [], lastSync: null, syncCount: 0 };
    }

    const existingIds = new Set((pool.snapshots || []).map(s => s.id));
    const added = newSnaps.filter(s => !existingIds.has(s.id));

    // Validate new snapshots
    const validAdded = added.filter(snap => {
      if (!snap.id || !snap.ts || typeof snap.ts !== "number") return false;
      if (!snap.prices || typeof snap.prices !== "object") return false;
      for (const sym in snap.prices) {
        const p = snap.prices[sym];
        if (typeof p !== "number" || !isFinite(p) || p <= 0) return false;
      }
      return true;
    });

    pool.snapshots = [...(pool.snapshots || []), ...validAdded];

    // Maintain rolling window
    if (pool.snapshots.length > MAX_SNAPSHOTS) {
      pool.snapshots = pool.snapshots.slice(pool.snapshots.length - MAX_SNAPSHOTS);
    }

    // Deduplicate and sort
    const seen = new Set();
    pool.snapshots = pool.snapshots.filter(s => {
      const key = s.ts + "_" + s.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => a.ts - b.ts);

    // Rebuild symbol list from all retained snapshots
    const allSyms = new Set();
    pool.snapshots.forEach(s => Object.keys(s.prices).forEach(k => allSyms.add(k)));
    pool.symbols = [...allSyms].sort();
    
    pool.lastSync = Date.now();
    pool.syncCount = (pool.syncCount || 0) + 1;

    // Save
    let kvSaved = false;
    if (KV_URL && KV_TOKEN) {
      kvSaved = await kvSet("market-data", pool);
    }
    
    let fileSaved = false;
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(pool, null, 2), "utf8");
      fileSaved = true;
    } catch(e) {}

    res.writeHead(200, CORS_HEADERS);
    res.end(JSON.stringify({
      ok: true,
      snapshotsAdded: validAdded.length,
      totalSnapshots: pool.snapshots.length,
      totalSymbols: pool.symbols.length,
      lastSync: pool.lastSync,
      persisted: kvSaved || fileSaved
    }));
  } catch (err) {
    console.error("[Sync Error]:", err);
    res.writeHead(500, CORS_HEADERS);
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
};
