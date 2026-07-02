// api/stock-history.js
// GET /api/stock-history?sym=SYMBOL -> returns price history for a single symbol
//
// If Supabase is configured, it queries the stock_prices table directly.
// If not configured, it falls back to extracting it from the local data.json file.

const https = require("https");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
};

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(200, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405, CORS_HEADERS);
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return;
  }

  const { sym } = req.query || {};
  if (!sym) {
    res.writeHead(400, CORS_HEADERS);
    res.end(JSON.stringify({ error: "Missing symbol (sym) parameter" }));
    return;
  }

  const stockSym = sym.trim().toUpperCase();

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    // Fallback: extract from local data.json (for offline/dev environments)
    try {
      const fs = require("fs");
      const path = require("path");
      const DATA_FILE = path.join(__dirname, "../data.json");
      if (fs.existsSync(DATA_FILE)) {
        const localData = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
        const snapshots = localData.snapshots || [];
        const result = [];
        for (const s of snapshots) {
          if (s.prices && s.prices[stockSym] !== undefined) {
            const raw = s.prices[stockSym];
            let price, ohlc;
            if (typeof raw === 'number') {
              price = raw;
            } else if (raw && typeof raw === 'object' && typeof raw.c === 'number') {
              price = raw.c;
              ohlc = raw;
            }
            if (price) {
              result.push({ ts: s.ts, label: s.label, price, ...(ohlc ? { ohlc } : {}) });
            }
          }
        }
        res.writeHead(200, CORS_HEADERS);
        res.end(JSON.stringify(result));
        return;
      }
    } catch (fallbackErr) {
      console.error("Local stock-history fallback failed:", fallbackErr.message);
    }

    res.writeHead(500, CORS_HEADERS);
    res.end(JSON.stringify({ error: "Supabase not configured and no local data fallback found" }));
    return;
  }

  try {
    // Query Supabase directly on the relational stock_prices table
    const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/stock_prices?select=ts,label,close,open,high,low&sym=eq.${encodeURIComponent(stockSym)}&order=ts.asc`;
    const options = {
      method: "GET",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    };

    const request = https.request(url, options, (apiRes) => {
      let body = "";
      apiRes.on("data", chunk => body += chunk);
      apiRes.on("end", () => {
        if (apiRes.statusCode !== 200) {
          res.writeHead(apiRes.statusCode, CORS_HEADERS);
          res.end(JSON.stringify({ error: `Supabase returned status code ${apiRes.statusCode}`, raw: body }));
          return;
        }

        try {
          const rawData = JSON.parse(body);
          const history = [];
          for (let i = 0; i < rawData.length; i++) {
            const row = rawData[i];
            if (row && row.close !== null && row.close !== undefined) {
              const close = parseFloat(row.close);
              const hasOHLC = row.open !== null && row.high !== null && row.low !== null;
              
              const item = {
                ts: parseInt(row.ts, 10),
                label: row.label,
                price: close
              };

              if (hasOHLC) {
                item.ohlc = {
                  c: close,
                  o: parseFloat(row.open),
                  h: parseFloat(row.high),
                  l: parseFloat(row.low)
                };
              }

              history.push(item);
            }
          }
          res.writeHead(200, CORS_HEADERS);
          res.end(JSON.stringify(history));
        } catch (parseErr) {
          res.writeHead(500, CORS_HEADERS);
          res.end(JSON.stringify({ error: "Failed to parse Supabase response", detail: parseErr.message }));
        }
      });
    });

    request.on("error", (networkErr) => {
      res.writeHead(500, CORS_HEADERS);
      res.end(JSON.stringify({ error: "Network error calling Supabase", detail: networkErr.message }));
    });

    request.end();
  } catch (err) {
    res.writeHead(500, CORS_HEADERS);
    res.end(JSON.stringify({ error: "Server error fetching stock history", detail: err.message }));
  }
};
