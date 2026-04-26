// ===============================================================================
//  MarketAI — Cloudflare Worker
//  Receives price snapshots from Google Apps Script and serves them via REST API.
//
//  D1 Schema (run once in Cloudflare dashboard → D1 → your DB → Console):
//
//    CREATE TABLE IF NOT EXISTS prices (
//      id        INTEGER PRIMARY KEY AUTOINCREMENT,
//      timestamp TEXT    NOT NULL,
//      market    TEXT    NOT NULL,
//      symbol    TEXT    NOT NULL,
//      price     REAL    NOT NULL
//    );
//
//    CREATE INDEX IF NOT EXISTS idx_market        ON prices (market);
//    CREATE INDEX IF NOT EXISTS idx_symbol        ON prices (symbol);
//    CREATE INDEX IF NOT EXISTS idx_timestamp     ON prices (timestamp);
//    CREATE INDEX IF NOT EXISTS idx_market_symbol ON prices (market, symbol);
//
//  wrangler.toml bindings required:
//    [[d1_databases]]
//    binding = "DB"
//    database_name = "marketai"
//    database_id   = "YOUR_DB_ID_HERE"
//
//  Endpoints:
//    POST /store                   — ingest price snapshot from Apps Script
//    GET  /latest                  — latest price per symbol (all or filtered)
//    GET  /history?symbol=&market= — full price history, optional filters
//    GET  /markets                 — list of distinct markets in DB
//    GET  /symbols?market=         — list of symbols, optionally filtered by market
//    GET  /ohlc?symbol=&market=&interval=5m — OHLC candles (1m/5m/15m/1h/1d)
//    GET  /health                  — liveness check
// ===============================================================================

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',           // allow dashboards / browsers
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

// Parse ?param= safely — returns null if absent or blank
function qp(url, key) {
  const v = url.searchParams.get(key);
  return v && v.trim() ? v.trim() : null;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS pre-flight
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    try {
      // ── POST /store ────────────────────────────────────────────────────────
      if (method === 'POST' && url.pathname === '/store') {
        return await handleStore(request, env);
      }

      // ── GET routes ─────────────────────────────────────────────────────────
      if (method === 'GET') {
        switch (url.pathname) {
          case '/latest':  return await handleLatest(url, env);
          case '/history': return await handleHistory(url, env);
          case '/markets': return await handleMarkets(env);
          case '/symbols': return await handleSymbols(url, env);
          case '/ohlc':    return await handleOHLC(url, env);
          case '/health':  return await handleHealth(env);
        }
      }

      return err('Not found', 404);

    } catch (e) {
      console.error('[MarketAI Worker] Unhandled error:', e.message, e.stack);
      return err(`Internal server error: ${e.message}`, 500);
    }
  },
};

// ===============================================================================
//  POST /store
//  Body: { timestamp: "yyyy-MM-dd HH:mm:ss", data: [{ symbol, market, price }] }
//  Skips rows with missing/invalid fields silently.
// ===============================================================================
async function handleStore(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return err('Request body must be valid JSON.');
  }

  const { timestamp, data } = body;

  if (!timestamp || typeof timestamp !== 'string') {
    return err('Missing or invalid "timestamp" field.');
  }
  if (!Array.isArray(data) || data.length === 0) {
    return err('Missing or empty "data" array.');
  }

  const stmt  = env.DB.prepare(
    'INSERT INTO prices (timestamp, market, symbol, price) VALUES (?, ?, ?, ?)'
  );
  const batch = [];
  const skipped = [];

  for (const item of data) {
    const { symbol, market, price } = item;

    // Validate each field — skip silently with a log entry
    if (!symbol || typeof symbol !== 'string' || !symbol.trim()) {
      skipped.push({ reason: 'blank symbol', item });
      continue;
    }
    if (!market || typeof market !== 'string' || !market.trim()) {
      skipped.push({ reason: 'blank market', item });
      continue;
    }
    const numPrice = Number(price);
    if (price === null || price === undefined || price === '' || isNaN(numPrice)) {
      skipped.push({ reason: 'invalid price', item });
      continue;
    }

    batch.push(stmt.bind(timestamp.trim(), market.trim(), symbol.trim(), numPrice));
  }

  if (batch.length === 0) {
    return json({ status: 'ok', inserted: 0, skipped: skipped.length, note: 'Nothing valid to insert.' });
  }

  await env.DB.batch(batch);

  if (skipped.length > 0) {
    console.warn(`[/store] Skipped ${skipped.length} rows:`, JSON.stringify(skipped));
  }

  return json({ status: 'ok', inserted: batch.length, skipped: skipped.length });
}

// ===============================================================================
//  GET /latest?market=NSE&symbol=RELIANCE
//  Returns the most recent price row per (market, symbol) pair.
//  Both query params are optional filters.
// ===============================================================================
async function handleLatest(url, env) {
  const market = qp(url, 'market');
  const symbol = qp(url, 'symbol');

  // Build WHERE clause dynamically
  const conditions = [];
  const params     = [];

  if (market) { conditions.push('market = ?'); params.push(market); }
  if (symbol) { conditions.push('symbol = ?'); params.push(symbol); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Subquery gets the MAX id per (market, symbol) pair within the optional filter
  const sql = `
    SELECT p.id, p.timestamp, p.market, p.symbol, p.price
    FROM prices p
    INNER JOIN (
      SELECT market, symbol, MAX(id) AS max_id
      FROM prices
      ${where}
      GROUP BY market, symbol
    ) latest ON p.market = latest.market AND p.symbol = latest.symbol AND p.id = latest.max_id
    ORDER BY p.market, p.symbol
  `;

  const result = await env.DB.prepare(sql).bind(...params).all();
  return json({ count: result.results.length, data: result.results });
}

// ===============================================================================
//  GET /history?symbol=RELIANCE&market=NSE&from=2025-04-01&to=2025-04-24&limit=500
//  All params optional. Default limit 1000, max 5000.
// ===============================================================================
async function handleHistory(url, env) {
  const symbol = qp(url, 'symbol');
  const market = qp(url, 'market');
  const from   = qp(url, 'from');
  const to     = qp(url, 'to');
  const limit  = Math.min(parseInt(qp(url, 'limit') || '1000', 10), 5000);

  const conditions = [];
  const params     = [];

  if (symbol) { conditions.push('symbol = ?'); params.push(symbol); }
  if (market) { conditions.push('market = ?'); params.push(market); }
  if (from)   { conditions.push('timestamp >= ?'); params.push(from); }
  if (to)     { conditions.push('timestamp <= ?'); params.push(to + ' 23:59:59'); }

  const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql    = `SELECT * FROM prices ${where} ORDER BY timestamp DESC LIMIT ?`;

  params.push(limit);

  const result = await env.DB.prepare(sql).bind(...params).all();
  return json({ count: result.results.length, data: result.results });
}

// ===============================================================================
//  GET /markets
//  Returns the distinct list of markets stored in the DB.
// ===============================================================================
async function handleMarkets(env) {
  const result = await env.DB.prepare(
    'SELECT DISTINCT market FROM prices ORDER BY market'
  ).all();
  return json({ markets: result.results.map(r => r.market) });
}

// ===============================================================================
//  GET /symbols?market=NSE
//  Returns distinct symbols, optionally filtered by market.
// ===============================================================================
async function handleSymbols(url, env) {
  const market = qp(url, 'market');
  const sql    = market
    ? 'SELECT DISTINCT symbol FROM prices WHERE market = ? ORDER BY symbol'
    : 'SELECT DISTINCT market, symbol FROM prices ORDER BY market, symbol';
  const params = market ? [market] : [];

  const result = await env.DB.prepare(sql).bind(...params).all();
  return json({ count: result.results.length, data: result.results });
}

// ===============================================================================
//  GET /ohlc?symbol=RELIANCE&market=NSE&interval=5m&from=2025-04-24&to=2025-04-24
//  Computes OHLC candles from raw tick data.
//  Supported intervals: 1m, 5m, 15m, 30m, 1h, 1d
// ===============================================================================
async function handleOHLC(url, env) {
  const symbol   = qp(url, 'symbol');
  const market   = qp(url, 'market');
  const interval = qp(url, 'interval') || '5m';
  const from     = qp(url, 'from');
  const to       = qp(url, 'to');

  if (!symbol) return err('"symbol" query param is required for /ohlc');
  if (!market) return err('"market" query param is required for /ohlc');

  // Map interval string → seconds, for SQLite strftime bucketing
  const intervalMap = {
    '1m':  60,
    '5m':  300,
    '15m': 900,
    '30m': 1800,
    '1h':  3600,
    '1d':  86400,
  };
  const seconds = intervalMap[interval];
  if (!seconds) return err(`Unsupported interval "${interval}". Use: ${Object.keys(intervalMap).join(', ')}`);

  const conditions = ['symbol = ?', 'market = ?'];
  const params     = [symbol, market];

  if (from) { conditions.push('timestamp >= ?'); params.push(from); }
  if (to)   { conditions.push('timestamp <= ?'); params.push(to + ' 23:59:59'); }

  const where = `WHERE ${conditions.join(' AND ')}`;

  // SQLite: bucket by flooring the unix timestamp to the interval
  const sql = `
    SELECT
      datetime(
        (strftime('%s', timestamp) / ${seconds}) * ${seconds},
        'unixepoch'
      ) AS candle_time,
      MIN(price) AS low,
      MAX(price) AS high,
      FIRST_VALUE(price) OVER (
        PARTITION BY (strftime('%s', timestamp) / ${seconds})
        ORDER BY timestamp ASC
      ) AS open,
      LAST_VALUE(price)  OVER (
        PARTITION BY (strftime('%s', timestamp) / ${seconds})
        ORDER BY timestamp ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
      ) AS close,
      COUNT(*) AS ticks
    FROM prices
    ${where}
    GROUP BY candle_time
    ORDER BY candle_time ASC
  `;

  // Note: FIRST_VALUE / LAST_VALUE window functions aren't supported in all D1 versions.
  // Fallback: fetch raw rows and compute OHLC in JS (more compatible).
  let result;
  try {
    result = await env.DB.prepare(sql).bind(...params).all();
    return json({ symbol, market, interval, count: result.results.length, candles: result.results });
  } catch (_) {
    // Fallback: JS-side OHLC computation
    return await handleOHLCFallback(env, symbol, market, seconds, params, where);
  }
}

async function handleOHLCFallback(env, symbol, market, seconds, params, where) {
  const sql    = `SELECT timestamp, price FROM prices ${where} ORDER BY timestamp ASC`;
  const result = await env.DB.prepare(sql).bind(...params).all();
  const rows   = result.results;

  if (rows.length === 0) return json({ count: 0, candles: [] });

  const candles = {};
  for (const row of rows) {
    const ts     = Math.floor(new Date(row.timestamp).getTime() / 1000);
    const bucket = Math.floor(ts / seconds) * seconds;
    const key    = new Date(bucket * 1000).toISOString().slice(0, 19).replace('T', ' ');

    if (!candles[key]) {
      candles[key] = { candle_time: key, open: row.price, high: row.price, low: row.price, close: row.price, ticks: 1 };
    } else {
      const c = candles[key];
      c.high  = Math.max(c.high, row.price);
      c.low   = Math.min(c.low,  row.price);
      c.close = row.price;
      c.ticks++;
    }
  }

  const sorted = Object.values(candles).sort((a, b) => a.candle_time.localeCompare(b.candle_time));
  return json({ symbol, market, count: sorted.length, candles: sorted });
}

// ===============================================================================
//  GET /health
//  Quick liveness + DB connectivity check
// ===============================================================================
async function handleHealth(env) {
  try {
    const result = await env.DB.prepare('SELECT COUNT(*) AS total FROM prices').first();
    return json({ status: 'ok', total_rows: result.total, ts: new Date().toISOString() });
  } catch (e) {
    return json({ status: 'error', message: e.message }, 503);
  }
}
