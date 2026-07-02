// api/data.js
// GET  /api/data → serves market data (chunked KV) + user data
// POST /api/data → saves user data (portfolio, watchlists, alerts, screeners)
//
// Market data is stored as:
//   "market-index" → { snapshots:[{id,ts,label}], symbols:[...], lastSync, syncCount }
//   "market-snap:<id>" → { prices: { SYM: price } }   (one key per snapshot)
// User data stays in a single "user-data" key (small — just IDs + numbers).

const fs = require("fs");
const path = require("path");
const https = require("https");

const DATA_FILE = path.join(__dirname, "../data.json");
const USER_FILE = path.join(__dirname, "../userdata.json");

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// Local in-memory cache for user data (market data is always fresh from KV)
let cachedUserData = null;
let cachedUserMtime = 0;

async function fetchSnapshotsFromSupabase(limit = 30) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return new Promise((resolve) => {
    try {
      const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/snapshots?select=ts,label,prices&order=ts.desc&limit=${limit}`;
      const options = {
        method: "GET",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      };
      const req = https.request(url, options, (res) => {
        let body = "";
        res.on("data", chunk => body += chunk);
        res.on("end", () => {
          if (res.statusCode !== 200) {
            console.error(`[Supabase GET error] Code ${res.statusCode}:`, body);
            resolve(null);
            return;
          }
          try {
            const data = JSON.parse(body);
            resolve(data);
          } catch (e) {
            console.error('[Supabase GET parse error]:', e.message);
            resolve(null);
          }
        });
      });
      req.on("error", (e) => {
        console.error('[Supabase GET network error]:', e.message);
        resolve(null);
      });
      req.end();
    } catch (err) {
      console.error('[Supabase GET error]:', err.message);
      resolve(null);
    }
  });
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
};

// ── HTTP / KV helpers ─────────────────────────────────────────────────────────

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
    const bodyStr = JSON.stringify(JSON.stringify(value));
    const res = await requestREST(`${KV_URL}/set/${encodeURIComponent(key)}`, "POST", bodyStr);
    if (res.error) {
      console.error(`[KV SET error] key="${key}":`, res.error);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[KV SET error] key="${key}":`, e.message);
    return false;
  }
}

// ── Market data: chunked KV reader ───────────────────────────────────────────

async function getMarketData() {
  if (!KV_URL || !KV_TOKEN) return null;

  // 1. Get the index (small, fast)
  const index = await kvGet("market-index");
  if (!index || !index.snapshots || index.snapshots.length === 0) {
    console.warn("[Data] market-index empty or missing in KV");
    return null;
  }

  // 2. Fetch all snapshot chunks in parallel (batches of 20 to avoid rate limits)
  const snapMetas = index.snapshots;
  const batchSize = 20;
  const snapshots = [];

  for (let i = 0; i < snapMetas.length; i += batchSize) {
    const batch = snapMetas.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(m => kvGet(`market-snap:${m.id}`))
    );
    batch.forEach((m, j) => {
      const snap = results[j];
      if (snap && snap.prices && Object.keys(snap.prices).length > 0) {
        snapshots.push({ id: m.id, ts: m.ts, label: m.label, prices: snap.prices });
      }
    });
  }

  if (snapshots.length === 0) {
    console.warn("[Data] market-index had entries but no snap keys resolved");
    return null;
  }

  return {
    snapshots: snapshots.sort((a, b) => a.ts - b.ts),
    symbols: index.symbols || [],
    lastSync: index.lastSync || null,
    syncCount: index.syncCount || 0
  };
}

// ── Local file fallback (dev / Vercel KV unavailable) ────────────────────────

function readLocalJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`[Read Local Error] ${file}:`, e.message);
  }
  return fallback;
}

function writeLocalJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (e) {
    // Expected on Vercel (read-only FS) — suppress noise
    return false;
  }
}

// ── Request handler ───────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(200, CORS_HEADERS);
    res.end();
    return;
  }

  // ── GET ──────────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    let market = null;
    let user = null;

    // 1. Try Supabase first (loads last 30 snapshots, very fast)
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        const snaps = await fetchSnapshotsFromSupabase(30);
        if (snaps && snaps.length > 0) {
          const sortedSnaps = snaps.sort((a, b) => a.ts - b.ts);
          const symbolsSet = new Set();
          for (const s of sortedSnaps) {
            if (s.prices) {
              for (const sym in s.prices) symbolsSet.add(sym);
            }
          }
          market = {
            snapshots: sortedSnaps,
            symbols: Array.from(symbolsSet).sort(),
            lastSync: sortedSnaps.length > 0 ? sortedSnaps[sortedSnaps.length - 1].ts : null,
            syncCount: 1
          };
          console.log(`[Supabase] Loaded ${market.snapshots.length} snapshots`);
        }
      } catch (err) {
        console.error('[Supabase GET failed, falling back]:', err.message);
      }
    }

    // 2. Try KV for market + user data
    if (!market && KV_URL && KV_TOKEN) {
      [market, user] = await Promise.all([getMarketData(), kvGet("user-data")]);
    }

    // 2. Fallback to local data.json (works in dev, not on Vercel)
    if (!market) {
      market = readLocalJSON(DATA_FILE, null);
      if (market && market.snapshots && market.snapshots.length > 0) {
        console.log(`[Data] Serving from local file: ${market.snapshots.length} snaps`);
      } else {
        market = { snapshots: [], symbols: [], lastSync: null, syncCount: 0 };
        console.warn("[Data] No market data available — KV empty, no local file");
      }
    }

    // Fallback to local userdata.json (dev only; Vercel FS is read-only)
    if (!user) {
      try {
        if (fs.existsSync(USER_FILE)) {
          const stat = fs.statSync(USER_FILE);
          if (stat.mtimeMs !== cachedUserMtime || !cachedUserData) {
            cachedUserData = JSON.parse(fs.readFileSync(USER_FILE, "utf8"));
            cachedUserMtime = stat.mtimeMs;
          }
          user = cachedUserData;
        }
      } catch (e) {}
      if (!user) user = { portfolio: [], watchlists: [], watchlistItems: [], alerts: [], screeners: [] };
    }

    res.writeHead(200, CORS_HEADERS);
    res.end(JSON.stringify({
      snapshots: market.snapshots || [],
      symbols: market.symbols || [],
      lastSync: market.lastSync || null,
      syncCount: market.syncCount || 0,
      portfolio: user.portfolio || [],
      watchlists: user.watchlists || [],
      watchlistItems: user.watchlistItems || [],
      alerts: user.alerts || [],
      screeners: user.screeners || []
    }));
    return;
  }

  // ── POST ──────────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    try {
      const body = req.body || {};

      let user = null;
      if (KV_URL && KV_TOKEN) user = await kvGet("user-data");
      if (!user) user = readLocalJSON(USER_FILE, null);
      if (!user) user = { portfolio: [], watchlists: [], watchlistItems: [], alerts: [], screeners: [] };

      const allowed = ["portfolio", "watchlists", "watchlistItems", "alerts", "screeners"];
      allowed.forEach(k => {
        if (body[k] !== undefined) {
          if (!Array.isArray(body[k])) throw new Error(`${k} must be an array`);
          body[k].forEach((item, idx) => {
            if (typeof item !== "object" || item === null) throw new Error(`${k}[${idx}] must be an object`);
          });
          user[k] = body[k];
        }
      });

      let kvSaved = false;
      if (KV_URL && KV_TOKEN) kvSaved = await kvSet("user-data", user);

      const localSaved = writeLocalJSON(USER_FILE, user);
      if (localSaved) {
        try { cachedUserData = user; cachedUserMtime = fs.statSync(USER_FILE).mtimeMs; } catch(e) {}
      }

      res.writeHead(200, CORS_HEADERS);
      res.end(JSON.stringify({ ok: true, saved: kvSaved || localSaved }));
      return;
    } catch (e) {
      res.writeHead(400, CORS_HEADERS);
      res.end(JSON.stringify({ ok: false, error: e.message }));
      return;
    }
  }

  res.writeHead(405, CORS_HEADERS);
  res.end(JSON.stringify({ error: "Method Not Allowed" }));
};
