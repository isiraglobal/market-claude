/**
 * Cloudflare Worker - MarketAI
 * Fetches Google Sheet every 5 minutes, stores in KV
 */

const SHEET_ID = "10Wha7-e2_51oaK8MaJfvC6RacmHptXuKvtHMQBIvVXY";
const SHEET_TAB = "Sheet2";
const MAX_SNAPSHOTS = 200;
const DATA_KEY = "market-data";

function parseCSV(text) {
  const rows = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = "", inQ = false;
    
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"'; i++;
        } else {
          inQ = !inQ;
        }
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
  return (v || "").replace(/^"+|"+$/g, "").trim();
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
  const s = clean(raw);
  if (!s || ["#N/A", "#VALUE!", "#REF!"].includes(s)) return null;
  const n = parseFloat(s.replace(/[^\d.-]/g, ""));
  return isFinite(n) && n > 0 ? n : null;
}

function parseSheet(csvText) {
  const rows = parseCSV(csvText);
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
    const sym = clean(row[0]).toUpperCase().replace(/\s+/g, "");
    
    if (!sym || sym === "SYMBOL") continue;
    
    for (const m of meta) {
      const p = parsePrice(row[m.col]);
      if (p !== null) {
        priceMap[m.ts + "_" + m.col][sym] = p;
        syms.add(sym);
      }
    }
  }
  
  const snapshots = meta
    .map(m => ({
      id: `snap_${m.ts}_${m.col}`,
      ts: m.ts,
      label: m.label,
      prices: priceMap[m.ts + "_" + m.col]
    }))
    .filter(s => Object.keys(s.prices).length > 0)
    .sort((a, b) => a.ts - b.ts);
  
  return { snapshots, symbols: [...syms].sort() };
}

async function syncData(env) {
  try {
    const ts = Date.now();
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_TAB)}&t=${ts}`;
    
    const resp = await fetch(url, { headers: { "User-Agent": "MarketAI/1.0" } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    
    const body = await resp.text();
    if (body.toLowerCase().startsWith("<!doctype")) throw new Error("Sheet not public");
    
    const { snapshots: newSnaps, symbols: newSyms } = parseSheet(body);
    if (newSnaps.length === 0) throw new Error("No snapshots");
    
    let pool = { snapshots: [], symbols: [], lastSync: null, syncCount: 0 };
    const stored = await env.DATA.get(DATA_KEY);
    if (stored) pool = JSON.parse(stored);
    
    const existingIds = new Set((pool.snapshots || []).map(s => s.id));
    const added = newSnaps.filter(s => !existingIds.has(s.id));
    
    const validAdded = added.filter(snap => {
      if (!snap.id || !snap.ts || typeof snap.ts !== 'number') return false;
      if (!snap.prices || typeof snap.prices !== 'object') return false;
      for (const sym in snap.prices) {
        const p = snap.prices[sym];
        if (typeof p !== 'number' || !isFinite(p) || p <= 0) return false;
      }
      return true;
    });
    
    pool.snapshots = [...(pool.snapshots || []), ...validAdded];
    
    if (pool.snapshots.length > MAX_SNAPSHOTS) {
      pool.snapshots = pool.snapshots.slice(pool.snapshots.length - MAX_SNAPSHOTS);
    }
    
    const seen = new Set();
    pool.snapshots = pool.snapshots
      .filter(s => {
        const key = s.ts + '_' + s.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.ts - b.ts);
    
    const allSyms = new Set();
    pool.snapshots.forEach(s => Object.keys(s.prices).forEach(k => allSyms.add(k)));
    pool.symbols = [...allSyms].sort();
    
    pool.lastSync = Date.now();
    pool.syncCount = (pool.syncCount || 0) + 1;
    
    await env.DATA.put(DATA_KEY, JSON.stringify(pool));
    
    return { ok: true, snapshotsAdded: validAdded.length, totalSnapshots: pool.snapshots.length, totalSymbols: pool.symbols.length, lastSync: pool.lastSync };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleRequest(request, env) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
  
  if (request.method === "OPTIONS") {
    return new Response("", { headers: cors });
  }
  
  const url = new URL(request.url);
  
  if (url.pathname === "/api/data" && request.method === "GET") {
    try {
      const stored = await env.DATA.get(DATA_KEY);
      const data = stored ? JSON.parse(stored) : { snapshots: [], symbols: [] };
      const userStored = await env.DATA.get("user-data");
      const userData = userStored ? JSON.parse(userStored) : { portfolio: [], watchlists: [], watchlistItems: [], alerts: [], screeners: [] };
      return new Response(JSON.stringify({ ...data, ...userData }), { headers: cors });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
    }
  }
  
  if (url.pathname === "/api/data" && request.method === "POST") {
    try {
      const body = await request.json();
      const userData = {
        portfolio: body.portfolio || [],
        watchlists: body.watchlists || [],
        watchlistItems: body.watchlistItems || [],
        alerts: body.alerts || [],
        screeners: body.screeners || []
      };
      await env.DATA.put("user-data", JSON.stringify(userData));
      return new Response(JSON.stringify({ ok: true }), { headers: cors });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: cors });
    }
  }
  
  if (url.pathname === "/api/sync" && request.method === "POST") {
    const result = await syncData(env);
    return new Response(JSON.stringify(result), { status: result.ok ? 200 : 500, headers: cors });
  }
  
  return new Response("Not Found", { status: 404, headers: cors });
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
  
  async scheduled(event, env) {
    const result = await syncData(env);
    console.log("[cron]", new Date().toISOString(), result);
  }
};
