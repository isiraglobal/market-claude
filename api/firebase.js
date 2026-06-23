// api/firebase.js
// Vercel serverless function — Firebase Firestore proxy & status endpoint
//
// POST /api/firebase
//   Body: { action: "batch-write", writes: [...], secret: "..." }
//   → Batch-writes documents to Firestore (called from Google Apps Script if needed)
//
// GET  /api/firebase?action=status
//   → Returns Firestore index & sync status
//
// GET  /api/firebase?action=history&symbol=RELIANCE&days=30
//   → Returns historical data for a symbol from Firestore
//
// ENV VARS (set in Vercel dashboard):
//   FIREBASE_PROJECT_ID   → your-project-id
//   FIREBASE_API_KEY      → your-web-api-key
//   FIREBASE_WRITE_SECRET → a random secret to authenticate Apps Script POSTs

const https = require('https');

const FIREBASE_PROJECT_ID   = process.env.FIREBASE_PROJECT_ID   || '';
const FIREBASE_API_KEY      = process.env.FIREBASE_API_KEY      || '';
const FIREBASE_WRITE_SECRET = process.env.FIREBASE_WRITE_SECRET || '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type':                 'application/json',
  'Cache-Control':                'no-store, no-cache',
};

// ── Firestore REST helpers ────────────────────────────────────────────────────

function firestoreRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const baseUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/default/documents`;
    const fullUrl = `${baseUrl}/${path}${FIREBASE_API_KEY ? `?key=${FIREBASE_API_KEY}` : ''}`;
    const parsed  = new URL(fullUrl);

    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + parsed.search,
      method,
      headers:  { 'Content-Type': 'application/json' },
    };
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr, 'utf8');

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: { raw: data } }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Convert Firestore field value to plain JS
function fromFirestoreValue(val) {
  if (val === undefined || val === null) return null;
  if (val.nullValue  !== undefined) return null;
  if (val.booleanValue !== undefined) return val.booleanValue;
  if (val.integerValue  !== undefined) return Number(val.integerValue);
  if (val.doubleValue   !== undefined) return Number(val.doubleValue);
  if (val.stringValue   !== undefined) return val.stringValue;
  if (val.timestampValue !== undefined) return new Date(val.timestampValue).getTime();
  if (val.arrayValue?.values) return val.arrayValue.values.map(fromFirestoreValue);
  if (val.mapValue?.fields)   return fromFirestoreDoc({ fields: val.mapValue.fields });
  return null;
}

function fromFirestoreDoc(doc) {
  if (!doc || !doc.fields) return null;
  const result = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    result[k] = fromFirestoreValue(v);
  }
  return result;
}

// Convert plain JS value to Firestore field format
function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean')          return { booleanValue: val };
  if (typeof val === 'number')           return Number.isInteger(val)
    ? { integerValue: String(val) }
    : { doubleValue: val };
  if (typeof val === 'string')           return { stringValue: val };
  if (Array.isArray(val))                return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === 'object')           return { mapValue: { fields: toFirestoreFields(val) } };
  return { stringValue: String(val) };
}

function toFirestoreFields(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) result[k] = toFirestoreValue(v);
  return result;
}

// ── Firestore operations ──────────────────────────────────────────────────────

async function getDocument(path) {
  if (!FIREBASE_PROJECT_ID) return null;
  const res = await firestoreRequest('GET', path);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`Firestore GET ${path} → ${res.status}`);
  return fromFirestoreDoc(res.body);
}

async function listDocuments(collectionPath, pageSize = 300) {
  if (!FIREBASE_PROJECT_ID) return [];
  const res = await firestoreRequest('GET', `${collectionPath}?pageSize=${pageSize}`);
  if (res.status !== 200) throw new Error(`Firestore LIST ${collectionPath} → ${res.status}`);
  const docs = res.body.documents || [];
  return docs.map(d => ({ id: d.name.split('/').pop(), ...fromFirestoreDoc(d) }));
}

async function batchWrite(writes) {
  if (!FIREBASE_PROJECT_ID) return false;
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/default/documents:batchWrite?key=${FIREBASE_API_KEY}`;
  const res = await new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({ writes });
    const parsed  = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port:     443,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(bodyStr, 'utf8'),
      },
    };
    const req = https.request(options, r => {
      let data = '';
      r.on('data', c => (data += c));
      r.on('end', () => resolve({ status: r.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
  return res.status >= 200 && res.status < 300;
}

// ── Request handler ───────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS_HEADERS);
    res.end();
    return;
  }

  const configured = !!(FIREBASE_PROJECT_ID && FIREBASE_API_KEY);

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const action = req.query?.action || 'status';

    // GET /api/firebase?action=status
    if (action === 'status') {
      let masterDoc = null;
      let metadata  = null;

      if (configured) {
        try { masterDoc = await getDocument('stockIndex/master'); } catch(e) {}

        const today = new Date().toISOString().slice(0, 10);
        try { metadata = await getDocument(`intradaySnapshots/${today}/metadata`); } catch(e) {}
      }

      res.writeHead(200, CORS_HEADERS);
      res.end(JSON.stringify({
        configured,
        projectId:     FIREBASE_PROJECT_ID || null,
        symbolCount:   masterDoc?.count ?? 0,
        lastUpdated:   masterDoc?.lastUpdated ?? null,
        lastDate:      masterDoc?.lastDate ?? null,
        todaySnapshots: metadata?.snapshotCount ?? 0,
        todaySymbols:   metadata?.symbolCount   ?? 0,
      }));
      return;
    }

    // GET /api/firebase?action=history&symbol=RELIANCE&days=30
    if (action === 'history') {
      const symbol = (req.query?.symbol || '').toUpperCase().trim();
      const days   = Math.min(parseInt(req.query?.days || '30', 10), 365);

      if (!symbol) {
        res.writeHead(400, CORS_HEADERS);
        res.end(JSON.stringify({ error: 'symbol parameter required' }));
        return;
      }

      if (!configured) {
        res.writeHead(503, CORS_HEADERS);
        res.end(JSON.stringify({ error: 'Firebase not configured' }));
        return;
      }

      try {
        const history = [];
        const now     = new Date();

        for (let d = days - 1; d >= 0; d--) {
          const date = new Date(now);
          date.setDate(now.getDate() - d);
          const dateStr = date.toISOString().slice(0, 10);

          try {
            const doc = await getDocument(`historicalData/${dateStr}/stocks/${symbol}`);
            if (doc) history.push(doc);
          } catch (e) { /* day might not exist */ }
        }

        res.writeHead(200, CORS_HEADERS);
        res.end(JSON.stringify({ symbol, days, history }));
      } catch (err) {
        res.writeHead(500, CORS_HEADERS);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // GET /api/firebase?action=latest
    if (action === 'latest') {
      if (!configured) {
        res.writeHead(503, CORS_HEADERS);
        res.end(JSON.stringify({ error: 'Firebase not configured' }));
        return;
      }
      try {
        const today   = new Date().toISOString().slice(0, 10);
        const stocks  = await listDocuments(`historicalData/${today}/stocks`);
        res.writeHead(200, CORS_HEADERS);
        res.end(JSON.stringify({ date: today, count: stocks.length, stocks }));
      } catch (err) {
        res.writeHead(500, CORS_HEADERS);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(400, CORS_HEADERS);
    res.end(JSON.stringify({ error: 'Unknown action. Use: status, history, latest' }));
    return;
  }

  // ── POST (batch write from Apps Script or direct) ─────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};

    // Validate write secret if configured
    if (FIREBASE_WRITE_SECRET && body.secret !== FIREBASE_WRITE_SECRET) {
      res.writeHead(401, CORS_HEADERS);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (!configured) {
      res.writeHead(503, CORS_HEADERS);
      res.end(JSON.stringify({ error: 'Firebase not configured on server' }));
      return;
    }

    const action = body.action || '';

    // POST batch-write: receives pre-built writes array
    if (action === 'batch-write') {
      const writes = body.writes;
      if (!Array.isArray(writes) || writes.length === 0) {
        res.writeHead(400, CORS_HEADERS);
        res.end(JSON.stringify({ error: 'writes array required' }));
        return;
      }

      try {
        const BATCH_SIZE  = 400;
        let   batchesSent = 0;
        for (let i = 0; i < writes.length; i += BATCH_SIZE) {
          const slice = writes.slice(i, i + BATCH_SIZE);
          await batchWrite(slice);
          batchesSent++;
        }
        res.writeHead(200, CORS_HEADERS);
        res.end(JSON.stringify({ ok: true, batches: batchesSent, writes: writes.length }));
      } catch (err) {
        res.writeHead(500, CORS_HEADERS);
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST stock-data: receives { date, symbols: [{symbol, open, high, low, close, minuteBars}] }
    if (action === 'stock-data') {
      const { date, symbols: symbolData } = body;
      if (!date || !Array.isArray(symbolData)) {
        res.writeHead(400, CORS_HEADERS);
        res.end(JSON.stringify({ error: 'date and symbols array required' }));
        return;
      }

      try {
        const writes    = [];
        const base      = `projects/${FIREBASE_PROJECT_ID}/databases/default/documents`;

        for (const sd of symbolData) {
          const { symbol, open, high, low, close, minuteBars = [] } = sd;
          if (!symbol || !close) continue;

          // Daily historical document
          writes.push({
            update: {
              name:   `${base}/historicalData/${date}/stocks/${symbol}`,
              fields: toFirestoreFields({ symbol, date, open, high, low, close, minuteBars, snapshotCount: minuteBars.length, syncedAt: Date.now() }),
            },
          });

          // Latest price document
          writes.push({
            update: {
              name:   `${base}/stocks/${symbol}`,
              fields: toFirestoreFields({ symbol, lastPrice: close, lastUpdated: Date.now(), todayDate: date, todayOpen: open, todayHigh: high, todayLow: low, todayClose: close }),
            },
          });
        }

        // Index document
        writes.push({
          update: {
            name:   `${base}/intradaySnapshots/${date}/metadata`,
            fields: toFirestoreFields({ date, symbolCount: symbolData.length, syncedAt: Date.now() }),
          },
        });

        // Batch write in chunks of 400
        const BATCH_SIZE = 400;
        let   batches    = 0;
        for (let i = 0; i < writes.length; i += BATCH_SIZE) {
          await batchWrite(writes.slice(i, i + BATCH_SIZE));
          batches++;
        }

        res.writeHead(200, CORS_HEADERS);
        res.end(JSON.stringify({ ok: true, symbols: symbolData.length, writes: writes.length, batches }));
      } catch (err) {
        res.writeHead(500, CORS_HEADERS);
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    res.writeHead(400, CORS_HEADERS);
    res.end(JSON.stringify({ error: `Unknown action: ${action}` }));
    return;
  }

  res.writeHead(405, CORS_HEADERS);
  res.end(JSON.stringify({ error: 'Method Not Allowed' }));
};
