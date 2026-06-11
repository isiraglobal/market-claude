// api/data.js
// Serves the full data pool to the frontend (GET /api/data)
// Accepts POST /api/data to update user data (portfolio, watchlists, etc.)

const fs = require("fs");
const path = require("path");
const https = require("https");

const DATA_FILE = path.join(__dirname, "../data.json");
const USER_FILE = path.join(__dirname, "../userdata.json");

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Global in-memory cache for fallback when no persistence is available
let memoryMarketData = null;
let memoryUserData = null;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json"
};

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
          try {
            resolve(JSON.parse(responseBody));
          } catch (e) {
            resolve({ error: "Invalid JSON response from KV store", body: responseBody });
          }
        });
      });
      req.on("error", reject);
      if (body) {
        req.write(typeof body === "string" ? body : JSON.stringify(body));
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const res = await requestREST(`${KV_URL}/get/${key}`, "GET");
    return res.result ? JSON.parse(res.result) : null;
  } catch (e) {
    console.error(`[Vercel KV GET Error] key ${key}:`, e);
    return null;
  }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    await requestREST(`${KV_URL}/set/${key}`, "POST", JSON.stringify(value));
    return true;
  } catch (e) {
    console.error(`[Vercel KV SET Error] key ${key}:`, e);
    return false;
  }
}

function readLocalJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch (e) {
    console.error(`[Read Local Error] file ${file}:`, e);
  }
  return fallback;
}

function writeLocalJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error(`[Write Local Error] file ${file}:`, e);
    return false;
  }
}

module.exports = async (req, res) => {
  // Handle CORS Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200, CORS_HEADERS);
    res.end();
    return;
  }

  // GET Request
  if (req.method === "GET") {
    let market = null;
    let user = null;

    if (KV_URL && KV_TOKEN) {
      // 1. Try fetching from Vercel KV
      market = await kvGet("market-data");
      user = await kvGet("user-data");
    }

    // 2. Fallback to local files (works in dev or writable production environments)
    if (!market) {
      market = readLocalJSON(DATA_FILE, { snapshots: [], symbols: [], lastSync: null });
    }
    if (!user) {
      user = readLocalJSON(USER_FILE, { portfolio: [], watchlists: [], watchlistItems: [], alerts: [], screeners: [] });
    }

    // 3. Fallback to in-memory store
    if (!market && memoryMarketData) market = memoryMarketData;
    if (!user && memoryUserData) user = memoryUserData;

    res.writeHead(200, CORS_HEADERS);
    res.end(JSON.stringify({
      snapshots: market?.snapshots || [],
      symbols: market?.symbols || [],
      lastSync: market?.lastSync || null,
      syncCount: market?.syncCount || 0,
      portfolio: user?.portfolio || [],
      watchlists: user?.watchlists || [],
      watchlistItems: user?.watchlistItems || [],
      alerts: user?.alerts || [],
      screeners: user?.screeners || []
    }));
    return;
  }

  // POST Request
  if (req.method === "POST") {
    try {
      // Node.js serverless functions on Vercel automatically parse body to req.body
      const body = req.body || {};
      
      // Fetch current user data from KV or local
      let user = null;
      if (KV_URL && KV_TOKEN) {
        user = await kvGet("user-data");
      }
      if (!user) {
        user = readLocalJSON(USER_FILE, { portfolio: [], watchlists: [], watchlistItems: [], alerts: [], screeners: [] });
      }
      if (!user && memoryUserData) {
        user = memoryUserData;
      }
      if (!user) {
        user = { portfolio: [], watchlists: [], watchlistItems: [], alerts: [], screeners: [] };
      }

      const allowed = ["portfolio", "watchlists", "watchlistItems", "alerts", "screeners"];
      allowed.forEach(k => {
        if (body[k] !== undefined) {
          if (!Array.isArray(body[k])) {
            throw new Error(`${k} must be an array`);
          }
          body[k].forEach((item, idx) => {
            if (typeof item !== "object" || item === null) {
              throw new Error(`${k}[${idx}] must be an object`);
            }
          });
          user[k] = body[k];
        }
      });

      // Save user data
      let saved = false;
      if (KV_URL && KV_TOKEN) {
        saved = await kvSet("user-data", user);
      }
      
      // Always write to local file as secondary/development save
      const localSaved = writeLocalJSON(USER_FILE, user);
      
      // Update memory store
      memoryUserData = user;

      res.writeHead(200, CORS_HEADERS);
      res.end(JSON.stringify({ ok: true, saved: saved || localSaved }));
      return;
    } catch (e) {
      res.writeHead(400, CORS_HEADERS);
      res.end(JSON.stringify({ ok: false, error: e.message }));
      return;
    }
  }

  // Method Not Allowed
  res.writeHead(405, CORS_HEADERS);
  res.end(JSON.stringify({ error: "Method Not Allowed" }));
};
