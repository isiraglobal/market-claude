// api/sync.js
// Fetches Google Sheet prices → merges into Vercel KV (chunked) or local files
//
// WHY CHUNKED?
// A single pool of 200 snapshots × 2400+ symbols is ~4MB.
// Vercel KV has a 1MB per-value cap — storing the whole pool in one key silently
// fails (the SET succeeds but GET returns nothing). We split into:
//   "market-index" → { snapshots: [{id, ts, label}], symbols: [...], lastSync, syncCount }
//   "market-snap:<id>" → { prices: { SYM: price, ... } }  (one key per snapshot)

const fs = require("fs");
const path = require("path");
const https = require("https");

const SHEET_ID = "1o6L7bHDrUozEPaLFsXPtls7Jey88lQm0789fq5T2GqA";
const DATA_FILE = path.join(__dirname, "../data.json");

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const MAX_SNAPSHOTS = 2000; // Maximum columns of history to keep

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "MarketAI-Sync/1.0" } }, (res) => {
      if (res.statusCode !== 200) {
        // Non-200: try curl fallback
        try {
          const { execSync } = require("child_process");
          const body = execSync(`curl -s -L "${url}"`, { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
          resolve({ status: 200, body });
        } catch (curlErr) {
          console.error("[fetchURL curl fallback failed]:", curlErr.message);
          resolve({ status: res.statusCode, body: "" });
        }
        return;
      }
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve({ status: 200, body }));
    }).on("error", (err) => {
      // Connection error: try curl fallback
      try {
        const { execSync } = require("child_process");
        const body = execSync(`curl -s -L "${url}"`, { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
        resolve({ status: 200, body });
      } catch (curlErr) {
        console.error("[fetchURL curl fallback on error]:", curlErr.message);
        reject(err);
      }
    });
  });
}

function requestREST(url, method, bodyStr = null) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: {
          Authorization: `Bearer ${KV_TOKEN}`,
          "Content-Type": "application/json"
        }
      };
      if (bodyStr) {
        options.headers["Content-Length"] = Buffer.byteLength(bodyStr, "utf8");
      }
      const req = https.request(options, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => responseBody += chunk);
        res.on("end", () => {
          try { resolve(JSON.parse(responseBody)); }
          catch (e) { resolve({ error: "Invalid JSON from KV", raw: responseBody }); }
        });
      });
      req.on("error", reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    } catch (err) { reject(err); }
  });
}

// ── KV helpers ────────────────────────────────────────────────────────────────

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const res = await requestREST(`${KV_URL}/get/${encodeURIComponent(key)}`, "GET");
    if (!res.result) return null;
    return JSON.parse(res.result);
  } catch (e) {
    console.error(`[KV GET error] key="${key}":`, e.message);
    return null;
  }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const bodyStr = JSON.stringify(JSON.stringify(value)); // double-stringify: KV stores strings
    const res = await requestREST(`${KV_URL}/set/${encodeURIComponent(key)}`, "POST", bodyStr);
    if (res.error) {
      console.error(`[KV SET error] key="${key}":`, res.error, res.raw || "");
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[KV SET error] key="${key}":`, e.message);
    return false;
  }
}

async function kvDel(key) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await requestREST(`${KV_URL}/del/${encodeURIComponent(key)}`, "POST", "");
  } catch (e) {
    console.error(`[KV DEL error] key="${key}":`, e.message);
  }
}

// ── Chunked market data storage ───────────────────────────────────────────────
// Index key: "market-index" → { snapshots:[{id,ts,label}], symbols:[...], lastSync, syncCount }
// Per-snap:  "market-snap:<id>" → { prices: {SYM: price} }

async function kvGetIndex() {
  return await kvGet("market-index");
}

async function kvGetSnap(id) {
  return await kvGet(`market-snap:${id}`);
}

async function kvSetIndex(index) {
  return await kvSet("market-index", index);
}

async function kvSetSnap(id, prices) {
  return await kvSet(`market-snap:${id}`, { prices });
}

async function kvDelSnap(id) {
  await kvDel(`market-snap:${id}`);
}

// Read the full pool from chunked KV (index + all snap keys in parallel)
async function kvGetFullPool() {
  const index = await kvGetIndex();
  if (!index || !index.snapshots || index.snapshots.length === 0) return null;

  // Fetch all snapshot prices in parallel (batches of 20 to avoid rate limits)
  const snapMetas = index.snapshots;
  const batchSize = 20;
  const snapshots = [];
  for (let i = 0; i < snapMetas.length; i += batchSize) {
    const batch = snapMetas.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(m => kvGetSnap(m.id)));
    batch.forEach((m, j) => {
      if (results[j] && results[j].prices) {
        snapshots.push({ id: m.id, ts: m.ts, label: m.label, prices: results[j].prices });
      }
    });
  }

  return {
    snapshots: snapshots.sort((a, b) => a.ts - b.ts),
    symbols: index.symbols || [],
    lastSync: index.lastSync || null,
    syncCount: index.syncCount || 0
  };
}

// Save the full pool to chunked KV (delete removed snaps, upsert new ones, update index)
async function kvSetFullPool(pool, addedSnaps, removedIds) {
  // 1. Delete KV keys for removed snapshots in parallel
  if (removedIds.length > 0) {
    await Promise.all(removedIds.map(id => kvDelSnap(id)));
  }

  // 2. Write new/updated snapshot price chunks in parallel (batches of 10)
  const batchSize = 10;
  for (let i = 0; i < addedSnaps.length; i += batchSize) {
    const batch = addedSnaps.slice(i, i + batchSize);
    await Promise.all(batch.map(s => kvSetSnap(s.id, s.prices)));
  }

  // 3. Write the index (small: just metadata, no prices)
  const index = {
    snapshots: pool.snapshots.map(s => ({ id: s.id, ts: s.ts, label: s.label })),
    symbols: pool.symbols,
    lastSync: pool.lastSync,
    syncCount: pool.syncCount
  };
  return await kvSetIndex(index);
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

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
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  return s;
}

function parseTimestamp(raw) {
  const s = clean(raw);
  if (!s || s === "SYMBOL") return null;
  if (/^\d{10,}$/.test(s)) {
    const ts = +s;
    return (ts >= 946684800000 && ts <= 4102444800000) ? ts : null;
  }
  // gviz Date(year, month0indexed, day [,h,m,s]) format
  const gviz = s.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/i);
  if (gviz) {
    const [, yr, mo, day, hh = 0, mm = 0, ss = 0] = gviz;
    const yr_num = +yr;
    if (yr_num < 2000 || yr_num > 2100) return null;
    const ts = new Date(yr_num, +mo, +day, +hh, +mm, +ss).getTime();
    return isNaN(ts) ? null : ts;
  }
  // dd/MM/yyyy [HH:mm[:ss]] or dd-MM-yyyy (written by Google Apps Script)
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (dmy) {
    const [, day, mon, yr, hh = "00", mm = "00", ss = "00"] = dmy;
    const yr_num = +yr;
    if (yr_num < 2000 || yr_num > 2100) return null;
    const ts = new Date(`${yr}-${mon.padStart(2,"0")}-${day.padStart(2,"0")}T${hh.padStart(2,"0")}:${mm.padStart(2,"0")}:${ss.padStart(2,"0")}`).getTime();
    return isNaN(ts) ? null : ts;
  }
  const ts = new Date(s).getTime();
  return (!isNaN(ts) && ts >= 946684800000 && ts <= 4102444800000) ? ts : null;
}

function parsePrice(raw) {
  if (!raw) return null;
  const s = clean(raw);
  if (!s || ["#N/A","N/A","#VALUE!","#REF!","#ERROR!","#NUM!","Loading..."].includes(s)) return null;
  let n = parseFloat(s);
  if (isNaN(n)) n = parseFloat(s.replace(/[^\d.-]/g, ""));
  return isFinite(n) && n > 0 ? n : null;
}

// ── Banded DP Sequence Alignment (old sheet format only) ─────────────────────

function alignRows(s1, s2) {
  const N = s2.length - 1;
  const M = s1.length - 1;
  const W = 30;
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
      if (i < N && j < M && Math.abs((i+1)-(j+1)) <= W) {
        const ns = dp[i][j] + getScore(i+1, j+1);
        if (dp[i+1][j+1] === undefined || ns > dp[i+1][j+1]) {
          dp[i+1][j+1] = ns; parent[i+1][j+1] = { prev_i:i, prev_j:j, action:"match" };
        }
      }
      if (i < N && Math.abs((i+1)-j) <= W) {
        const ns = dp[i][j] - 2;
        if (dp[i+1][j] === undefined || ns > dp[i+1][j]) {
          dp[i+1][j] = ns; parent[i+1][j] = { prev_i:i, prev_j:j, action:"skip_s2" };
        }
      }
      if (j < M && Math.abs(i-(j+1)) <= W) {
        const ns = dp[i][j] - 1;
        if (dp[i][j+1] === undefined || ns > dp[i][j+1]) {
          dp[i][j+1] = ns; parent[i][j+1] = { prev_i:i, prev_j:j, action:"skip_s1" };
        }
      }
    }
  }

  let best_j = M, max_score = -Infinity;
  for (let j = Math.max(0,N-W); j <= Math.min(M,N+W); j++) {
    if (dp[N][j] !== undefined && dp[N][j] > max_score) { max_score = dp[N][j]; best_j = j; }
  }
  let curr_i = N, curr_j = best_j;
  const mapping = {};
  while (curr_i > 0 || curr_j > 0) {
    const p = parent[curr_i]?.[curr_j];
    if (!p) break;
    if (p.action === "match") mapping[curr_i] = s1[curr_j][0];
    curr_i = p.prev_i; curr_j = p.prev_j;
  }
  return mapping;
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(200, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method === "DELETE") {
    const emptyPool = { snapshots: [], symbols: [], lastSync: null, syncCount: 0 };
    // Clear chunked KV: first read the index to find all snap keys
    if (KV_URL && KV_TOKEN) {
      const index = await kvGetIndex();
      if (index && index.snapshots) {
        await Promise.all(index.snapshots.map(m => kvDelSnap(m.id)));
      }
      await kvSet("market-index", emptyPool);
    }
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(emptyPool, null, 2), "utf8"); } catch(e) {}
    res.writeHead(200, CORS_HEADERS);
    res.end(JSON.stringify({ ok: true, message: "Market data cleared" }));
    return;
  }

  try {
    const ts = Date.now();
    let csvSymbols = req.body && req.body.csvSymbols;
    let csvNse = req.body && req.body.csvNse;

    if (!csvSymbols || !csvNse) {
      // Fetch SYMBOLS sheet (current prices from GOOGLEFINANCE)
      const s1Url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=SYMBOLS&t=${ts}`;
      const s1Resp = await fetchURL(s1Url);
      if (s1Resp.status !== 200) throw new Error(`SYMBOLS sheet returned HTTP ${s1Resp.status}`);
      csvSymbols = s1Resp.body;

      // Fetch NSE sheet (price history matrix)
      const s2Url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=NSE&t=${ts}`;
      const s2Resp = await fetchURL(s2Url);
      if (s2Resp.status !== 200) throw new Error(`NSE sheet returned HTTP ${s2Resp.status}`);
      csvNse = s2Resp.body;
    }

    const s1Rows = parseCSV(csvSymbols);
    const s2Rows = parseCSV(csvNse);

    if (s2Rows.length < 2) throw new Error("NSE sheet returned no data rows");

    const header = s2Rows[0];
    const firstColHeader = clean(header[0]).toUpperCase();

    // Detect new format: col 0 = "Symbol" string column
    const isNewFormat = firstColHeader.includes("SYMBOL") || isNaN(Number((s2Rows[1]?.[0] || "").trim()));

    let mapping = {};
    if (!isNewFormat) {
      mapping = alignRows(s1Rows, s2Rows);
    }

    // ── Get all columns from the sheet ──────────────────────
    const startCol = isNewFormat ? 1 : 0;

    // 1. Scan ALL columns and keep all valid timestamped columns
    const meta = [];
    for (let c = startCol; c < header.length; c++) {
      const colTs = parseTimestamp(header[c]);
      if (!colTs) continue;
      meta.push({ col: c, label: clean(header[c]), ts: colTs });
    }

    // 2. Sort by timestamp ascending, keep last MAX_SNAPSHOTS columns
    meta.sort((a, b) => a.ts - b.ts);
    if (meta.length > MAX_SNAPSHOTS) {
      meta.splice(0, meta.length - MAX_SNAPSHOTS);
    }

    if (meta.length === 0) throw new Error("No timestamp columns found in NSE sheet header");
    console.log(`[Sync] Columns in sheet: ${header.length - startCol}, using: ${meta.length} snapshot columns, ${s2Rows.length - 1} symbol rows`);

    // Build price map: ts_col → { SYM: price }
    const priceMap = {};
    meta.forEach(m => { priceMap[m.ts + "_" + m.col] = {}; });
    const symsSet = new Set();
    const allNseSymbols = new Set();

    for (let r = 1; r < s2Rows.length; r++) {
      const row = s2Rows[r];
      let sym = isNewFormat
        ? clean(row[0]).toUpperCase().replace(/\s+/g, "")
        : mapping[r];

      if (!sym || sym === "SYMBOL" || sym.startsWith("#")) continue;

      allNseSymbols.add(sym);

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

    // ── Load existing pool ─────────────────────────────────────────────────────
    let pool = null;

    if (KV_URL && KV_TOKEN) {
      // Try new chunked format first
      pool = await kvGetFullPool();
      // Migrate: if old single-key format exists, read it once and migrate
      if (!pool) {
        const oldPool = await kvGet("market-data");
        if (oldPool && oldPool.snapshots && oldPool.snapshots.length > 0) {
          console.log("[Sync] Migrating from old single-key KV format to chunked format...");
          pool = oldPool;
        }
      }
    }

    if (!pool) {
      try {
        if (fs.existsSync(DATA_FILE)) {
          pool = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
          console.log(`[Sync] Loaded pool from local file: ${pool.snapshots?.length || 0} snaps`);
        }
      } catch (e) {}
    }

    if (!pool) {
      pool = { snapshots: [], symbols: [], lastSync: null, syncCount: 0 };
    }

    // ── Merge new snapshots ────────────────────────────────────────────────────
    const existingIds = new Set((pool.snapshots || []).map(s => s.id));
    const toAdd = newSnaps.filter(s => {
      if (existingIds.has(s.id)) return false;
      if (!s.id || !s.ts || typeof s.ts !== "number") return false;
      if (!s.prices || typeof s.prices !== "object") return false;
      // Validate prices
      const priceVals = Object.values(s.prices);
      if (priceVals.length === 0) return false;
      for (const p of priceVals) {
        if (typeof p !== "number" || !isFinite(p) || p <= 0) return false;
      }
      return true;
    });

    pool.snapshots = [...(pool.snapshots || []), ...toAdd];

    // Deduplicate by timestamp (ts): keep only the latest entry if duplicate timestamps occur.
    // This handles cases where a column shifted index (different id) but has the same timestamp.
    const tsBest = {}; // ts_number → snapshot
    for (const s of pool.snapshots) {
      if (!tsBest[s.ts] || s.id > tsBest[s.ts].id) {
        tsBest[s.ts] = s;
      }
    }
    pool.snapshots = Object.values(tsBest).sort((a, b) => a.ts - b.ts);

    // Rolling window: evict oldest dates beyond MAX_SNAPSHOTS
    let removedIds = [];
    if (pool.snapshots.length > MAX_SNAPSHOTS) {
      const removed = pool.snapshots.splice(0, pool.snapshots.length - MAX_SNAPSHOTS);
      removedIds = removed.map(s => s.id);
    }

    // Rebuild symbols from the sheet and snapshots
    const allSyms = new Set(allNseSymbols);
    pool.snapshots.forEach(s => Object.keys(s.prices).forEach(k => allSyms.add(k)));
    pool.symbols = [...allSyms].filter(Boolean).sort();
    pool.lastSync = Date.now();
    pool.syncCount = (pool.syncCount || 0) + 1;

    console.log(`[Sync] Pool: ${pool.snapshots.length} daily snaps, ${pool.symbols.length} syms, +${toAdd.length} added, -${removedIds.length} evicted`);


    // ── Save ──────────────────────────────────────────────────────────────────
    let kvSaved = false;
    if (KV_URL && KV_TOKEN) {
      // Save in chunked format
      kvSaved = await kvSetFullPool(pool, toAdd, removedIds);
      // Delete the old single-key if it existed (cleanup after migration)
      await kvDel("market-data").catch(() => {});
    }

    // Always save to local file as dev/fallback (fails silently on Vercel read-only FS)
    let fileSaved = false;
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(pool, null, 2), "utf8");
      fileSaved = true;
    } catch (e) {}

    res.writeHead(200, CORS_HEADERS);
    res.end(JSON.stringify({
      ok: true,
      snapshotsAdded: toAdd.length,
      totalSnapshots: pool.snapshots.length,
      totalSymbols: pool.symbols.length,
      lastSync: pool.lastSync,
      kvSaved,
      fileSaved
    }));

  } catch (err) {
    console.error("[Sync Error]:", err.message, err.stack);
    res.writeHead(500, CORS_HEADERS);
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
};
