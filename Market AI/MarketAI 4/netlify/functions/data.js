// netlify/functions/data.js
// Serves the full data pool to the frontend (GET /api/data)
// Also accepts POST /api/data to update non-market user data (portfolio, watchlists, alerts)

const fs = require("fs");
const path = require("path");

const DATA_FILE  = path.join(__dirname, "../../data.json");
const USER_FILE  = path.join(__dirname, "../../userdata.json");

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

function readJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch(e) {}
  return fallback;
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); }

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

  if (event.httpMethod === "GET") {
    const market = readJSON(DATA_FILE, { snapshots: [], symbols: [], lastSync: null });
    const user   = readJSON(USER_FILE, { portfolio: [], watchlists: [], watchlistItems: [], alerts: [], screeners: [] });
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ...market, ...user })
    };
  }

  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      const user = readJSON(USER_FILE, { portfolio: [], watchlists: [], watchlistItems: [], alerts: [], screeners: [] });
      const allowed = ["portfolio","watchlists","watchlistItems","alerts","screeners"];
      
      // Sanitize and validate each field
      allowed.forEach(k => {
        if (body[k] !== undefined) {
          if (!Array.isArray(body[k])) {
            throw new Error(`${k} must be an array`);
          }
          // Validate array elements
          body[k].forEach((item, idx) => {
            if (typeof item !== 'object' || item === null) {
              throw new Error(`${k}[${idx}] must be an object`);
            }
          });
          user[k] = body[k];
        }
      });
      
      writeJSON(USER_FILE, user);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    } catch(e) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
    }
  }

  return { statusCode: 405, headers: CORS, body: "Method Not Allowed" };
};
