// Early theme initialization to prevent light flash
(function() {
  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
})();

// ── API base (works both locally via dev server and on Vercel) ─────────────
const API = '';

// Google Sheets source (must match api/sync.js SHEET_ID and tab names)
const SHEET_CONFIG = {
  id: '1o6L7bHDrUozEPaLFsXPtls7Jey88lQm0789fq5T2GqA',
  symbolsTab: 'SYMBOLS',
  nseTab: 'NSE',
};

// ── App State ────────────────────────────────────────────────────────────────
const S = {
  snapshots: [], symbols: [], lastSync: null,
  portfolio: [], watchlists: [], watchlistItems: [], alerts: [], screeners: [],
  activePage: 'dashboard', activeStock: null, sbTab: 'all',
  workspaces: [
    { id: 'ws1', name: 'Morning Scan', active: true },
    { id: 'ws2', name: 'Intraday', active: false },
    { id: 'ws3', name: 'Swing', active: false },
  ],
  syncing: false, loaded: false,
};

// ── Calculation Cache ────────────────────────────────────────────────────────
const Cache = {
  histories: {},
  stats: {},
  latestPrice: {},
  prevPrice: {},
  change: {},
  spark: {},
  topGainers: [],
  topLosers: [],
  autoPicks: [],
  hammers: [],
  demandZones: [],
  allPatterns: null,
  summary: {}
};

function precomputeCache() {
  Cache.histories = {};
  Cache.stats = {};
  Cache.latestPrice = {};
  Cache.prevPrice = {};
  Cache.change = {};
  Cache.spark = {};
  Cache.topGainers = [];
  Cache.topLosers = [];
  Cache.autoPicks = null;
  Cache.hammers = null;
  Cache.demandZones = null;
  Cache.allPatterns = null;
  Cache.summary = { total: 0, advances: 0, declines: 0, unchanged: 0 };

  const snaps = S.snapshots;
  const snapLen = snaps.length;
  for (let i = 0; i < snapLen; i++) {
    const snap = snaps[i];
    if (!snap || typeof snap.ts !== 'number' || !snap.prices) continue;
    const ts = snap.ts, label = snap.label, rawPrices = snap.prices;
    for (const sym in rawPrices) {
      const raw = rawPrices[sym];
      let price, ohlc;
      if (typeof raw === 'number' && raw > 0) {
        price = raw;
      } else if (raw && typeof raw === 'object' && typeof raw.c === 'number' && raw.c > 0) {
        price = raw.c; ohlc = raw;
      } else continue;
      let hist = Cache.histories[sym];
      if (!hist) hist = Cache.histories[sym] = [];
      const hLen = hist.length;
      if (hLen > 0 && hist[hLen - 1].ts === ts) {
        const last = hist[hLen - 1];
        last.label = label; last.price = price;
        if (ohlc) last.ohlc = ohlc;
      } else {
        hist.push({ ts, label, price, ...(ohlc ? { ohlc } : {}) });
      }
    }
  }

  const symbols = S.symbols;
  const symLen = symbols.length;
  const gainers = [];
  const losers = [];
  let adv = 0, dec = 0, unc = 0;

  for (let si = 0; si < symLen; si++) {
    const sym = symbols[si];
    const history = Cache.histories[sym];
    if (!history || history.length === 0) {
      Cache.latestPrice[sym] = null; Cache.prevPrice[sym] = null;
      Cache.change[sym] = null; Cache.stats[sym] = null;
      unc++; continue;
    }

    const len = history.length;
    const prices = new Array(len);
    for (let i = 0; i < len; i++) prices[i] = history[i].price;

    const latest = prices[len - 1];
    const prev = len >= 2 ? prices[len - 2] : null;
    Cache.latestPrice[sym] = latest;
    Cache.prevPrice[sym] = prev;

    let chg = null;
    if (latest !== null && prev !== null && prev > 0) {
      const abs = latest - prev;
      const pct = abs / prev * 100;
      chg = isFinite(pct) ? { abs, pct } : null;
    }
    Cache.change[sym] = chg;

    let hi = -Infinity, lo = Infinity, sum = 0;
    for (let i = 0; i < len; i++) {
      const p = prices[i];
      if (p > hi) hi = p;
      if (p < lo) lo = p;
      sum += p;
    }
    const avg = sum / len;
    const first = prices[0];

    let retSum = 0, retCount = 0;
    for (let i = 1; i < len; i++) {
      const ret = (prices[i] - prices[i - 1]) / prices[i - 1];
      if (isFinite(ret)) { retSum += ret; retCount++; }
    }
    const mean = retCount ? retSum / retCount : 0;
    let varSum = 0;
    for (let i = 1; i < len; i++) {
      const ret = (prices[i] - prices[i - 1]) / prices[i - 1];
      if (isFinite(ret)) { const d = ret - mean; varSum += d * d; }
    }
    const vol = Math.sqrt(retCount ? varSum / retCount : 0) * 100;
    const pctReturn = first > 0 ? (latest - first) / first * 100 : 0;

    Cache.stats[sym] = {
      hi, lo, avg, first, last: latest, count: len,
      pct: isFinite(pctReturn) ? pctReturn : 0,
      vol: isFinite(vol) ? vol : 0,
      prices, series: history
    };

    if (!chg) unc++;
    else if (chg.pct > 0.01) { adv++; gainers.push({ sym, c: chg, st: Cache.stats[sym] }); }
    else if (chg.pct < -0.01) { dec++; losers.push({ sym, c: chg, st: Cache.stats[sym] }); }
    else unc++;
  }

  gainers.sort((a, b) => b.c.pct - a.c.pct);
  losers.sort((a, b) => a.c.pct - b.c.pct);
  Cache.topGainers = gainers;
  Cache.topLosers = losers;
  Cache.summary = { total: symLen, advances: adv, declines: dec, unchanged: unc };

  Cache.autoPicks = null;
  Cache.hammers = null;
  Cache.demandZones = null;
}

// ── Core computations ────────────────────────────────────────────────────────
function latestPrice(sym) {
  return Cache.latestPrice[sym] !== undefined ? Cache.latestPrice[sym] : null;
}
function prevPrice(sym) {
  return Cache.prevPrice[sym] !== undefined ? Cache.prevPrice[sym] : null;
}
function change(sym) {
  return Cache.change[sym] !== undefined ? Cache.change[sym] : null;
}
function series(sym, period = 'all') {
  const history = Cache.histories[sym] || [];
  if (period === 'all') return history;
  if (history.length === 0) return [];
  const last = history[history.length - 1].ts;
  const cut = { d3: 3 * 864e5, w1: 7 * 864e5, m1: 30 * 864e5, m3: 90 * 864e5 }[period];
  if (cut) { const f = history.filter(s => s.ts >= last - cut); if (f.length >= 2) return f; }
  return history;
}
function stats(sym, period = 'all') {
  if (period === 'all') {
    return Cache.stats[sym] !== undefined ? Cache.stats[sym] : null;
  }
  const sr = series(sym, period);
  const prLen = sr.length;
  if (!prLen) return null;
  const pr = new Array(prLen);
  for (let i = 0; i < prLen; i++) pr[i] = sr[i].price;
  let hi = -Infinity, lo = Infinity, sum = 0;
  for (let i = 0; i < prLen; i++) { const p = pr[i]; if (p > hi) hi = p; if (p < lo) lo = p; sum += p; }
  const avg = sum / prLen;
  const first = pr[0], last = pr[prLen - 1];
  let retSum = 0, retCount = 0;
  for (let i = 1; i < prLen; i++) { const ret = (pr[i] - pr[i - 1]) / pr[i - 1]; if (isFinite(ret)) { retSum += ret; retCount++; } }
  const mean = retCount ? retSum / retCount : 0;
  let varSum = 0;
  for (let i = 1; i < prLen; i++) { const ret = (pr[i] - pr[i - 1]) / pr[i - 1]; if (isFinite(ret)) { const d = ret - mean; varSum += d * d; } }
  const vol = Math.sqrt(retCount ? varSum / retCount : 0) * 100;
  const pctReturn = first > 0 ? (last - first) / first * 100 : 0;
  return { hi, lo, avg, first, last, count: prLen, pct: isFinite(pctReturn) ? pctReturn : 0, vol: isFinite(vol) ? vol : 0, prices: pr, series: sr };
}
function topGainers(n = 10) {
  return Cache.topGainers.slice(0, n);
}
function topLosers(n = 10) {
  return Cache.topLosers.slice(0, n);
}
function summary() {
  return Cache.summary;
}

function autoPicks(n = 6) {
  if (!Cache.autoPicks) computeAutoPicks();
  return Cache.autoPicks.slice(0, n);
}

function calcRSI(prices, n = 14) {
  const len = prices.length;
  if (len <= n) return 50;
  // Use at most the last 60 prices to warm up and compute RSI, saving time
  const startIdx = Math.max(0, len - 60);
  let gains = 0, losses = 0;
  for (let i = startIdx + 1; i <= startIdx + n; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgG = gains / n, avgL = losses / n;
  for (let i = startIdx + n + 1; i < len; i++) {
    const diff = prices[i] - prices[i - 1];
    let g = 0, l = 0; if (diff > 0) g = diff; else l = -diff;
    avgG = (avgG * (n - 1) + g) / n;
    avgL = (avgL * (n - 1) + l) / n;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - (100 / (1 + rs));
}

function hammerSignals() {
  if (!Cache.hammers) computeHammers();
  return Cache.hammers;
}

function demandZones() {
  if (!Cache.demandZones) computeDemandZones();
  return Cache.demandZones;
}

function getAllPatterns() {
  if (!Cache.allPatterns) computeAllPatterns();
  return Cache.allPatterns;
}

function computeAutoPicks() {
  const list = [];
  for (const sym of S.symbols) {
    const st = stats(sym);
    if (!st || st.count < 5) continue;
    const c = change(sym);
    const rsi = calcRSI(st.prices);

    let score = 50;
    const rets = st.pct;
    score += rets * 0.4;
    if (rsi > 70) score -= (rsi - 70) * 0.5;
    else if (rsi < 30) score += (30 - rsi) * 0.6;
    else score += (rsi - 50) * 0.25;

    if (c) score += c.pct * 1.5;
    score -= st.vol * 0.15;

    const rounded = Math.max(0, Math.min(100, Math.round(score)));

    let reason = "Stable trend and moderate volatility.";
    if (rsi < 30) reason = "Strong oversold recovery signal (RSI < 30).";
    else if (rsi > 70) reason = "Extreme momentum, caution suggested.";
    else if (c && c.pct > 3) reason = "Strong intraday breakout volume.";
    else if (rets > 10) reason = "Sustained multi-day bullish trend.";

    list.push({ sym, score: rounded, reason, c, rsi });
  }
  Cache.autoPicks = list.sort((a, b) => b.score - a.score);
}

function computeHammers() {
  const out = [];
  const snaps = S.snapshots;
  const snapLen = snaps.length;
  if (snapLen < 3) {
    Cache.hammers = [];
    return;
  }

  // Scan snapshots backwards from latest to oldest, up to 250 snapshots back
  const limitIdx = Math.max(2, snapLen - 250);
  for (let i = snapLen - 1; i >= limitIdx; i--) {
    const snap = snaps[i];
    if (!snap || !snap.prices) continue;

    const snapPrev = snaps[i - 1];
    const snapPrev2 = snaps[i - 2];
    if (!snapPrev || !snapPrev.prices || !snapPrev2 || !snapPrev2.prices) continue;

    for (const sym in snap.prices) {
      const raw = snap.prices[sym];
      const rawPrev = snapPrev.prices[sym];
      const rawPrev2 = snapPrev2.prices[sym];
      if (raw == null || rawPrev == null || rawPrev2 == null) continue;

      const p2 = typeof raw === 'number' ? raw : raw.c;
      const p1 = typeof rawPrev === 'number' ? rawPrev : rawPrev.c;
      const p0 = typeof rawPrev2 === 'number' ? rawPrev2 : rawPrev2.c;
      if (!p0 || !p1 || !p2 || p0 <= 0 || p1 <= 0 || p2 <= 0) continue;

      // Downward trend before signal
      if (p1 < p0 * 0.995) {
        const ohlc = typeof raw === 'object' ? raw : null;
        let open = p1, high = p2, low = p2, close = p2;
        if (ohlc) {
          open = ohlc.o || open;
          high = ohlc.h || high;
          low = ohlc.l || low;
          close = ohlc.c || close;
        } else {
          open = p1;
          close = p2;
          high = Math.max(open, close) * 1.002;
          low = Math.min(open, close) * 0.985;
        }

        const body = Math.abs(close - open);
        const range = high - low || 1;
        const lowerShadow = Math.min(open, close) - low;
        const upperShadow = high - Math.max(open, close);

        if (lowerShadow > body * 1.8 && upperShadow < body * 0.6 && range > body * 2) {
          const score = Math.round(Math.min(100, (lowerShadow / (body || 1)) * 30 + (range / (open || 1)) * 400));
          if (score >= 40) {
            out.push({
              sym, ts: snap.ts, label: snap.label,
              entry: close, score, volSpike: score >= 65
            });
          }
        }
      }
    }

    if (out.length >= 100) break;
  }
  Cache.hammers = out;
}

function computeAllPatterns() {
  const out = [];
  const snaps = S.snapshots;
  const snapLen = snaps.length;
  if (snapLen < 3) {
    Cache.allPatterns = [];
    return;
  }

  // Scan backwards, up to 250 snapshots
  const limitIdx = Math.max(2, snapLen - 250);
  for (let i = snapLen - 1; i >= limitIdx; i--) {
    const snap = snaps[i];
    if (!snap || !snap.prices) continue;

    const snapPrev = snaps[i - 1];
    const snapPrev2 = snaps[i - 2];
    if (!snapPrev || !snapPrev.prices || !snapPrev2 || !snapPrev2.prices) continue;

    const snapPrev3 = i >= 3 ? snaps[i - 3] : null;

    for (const sym in snap.prices) {
      const raw = snap.prices[sym];
      const rawPrev = snapPrev.prices[sym];
      const rawPrev2 = snapPrev2.prices[sym];
      if (raw == null || rawPrev == null || rawPrev2 == null) continue;

      const cur = typeof raw === 'number' ? raw : raw.c;
      const b = typeof rawPrev === 'number' ? rawPrev : rawPrev.c;
      const a = typeof rawPrev2 === 'number' ? rawPrev2 : rawPrev2.c;
      if (!a || !b || !cur || a <= 0 || b <= 0 || cur <= 0) continue;

      const body = Math.abs(cur - b);
      const rng = Math.max(a, b, cur) - Math.min(a, b, cur) || 1;

      // Doji: small body relative to range, but ensure range is not just the artificial "|| 1" range from flat price
      const realRng = Math.max(a, b, cur) - Math.min(a, b, cur);
      if (realRng > 0 && body / rng < 0.1 && a > b * 0.99 && a < b * 1.01) {
        out.push({ sym, type: 'doji', ts: snap.ts, label: snap.label, score: 50, volSpike: false });
      }

      // Hammer: prior high > dip, recovery above dip
      if (a > b && cur > b && (cur - b) / (a - b || 1) > 0.5) {
        const score = Math.min(100, Math.round(((cur - b) / (a - b || 1)) * 70));
        if (score >= 40) {
          out.push({ sym, type: 'hammer', ts: snap.ts, label: snap.label, score, volSpike: score >= 60 });
        }
      }

      // Engulfing: large move opposite to prior move
      if (Math.abs(cur - b) > Math.abs(b - a) * 1.4 && (cur - b) * (b - a) < 0) {
        const absSize = (cur - b) / (b - a || 1);
        const score = Math.min(100, Math.round(Math.abs(absSize) * 65));
        if (score >= 50) {
          out.push({ sym, type: 'engulfing', ts: snap.ts, label: snap.label, score, volSpike: score >= 70 });
        }
      }

      // Morning Star
      if (snapPrev3 && snapPrev3.prices) {
        const rawPrev3 = snapPrev3.prices[sym];
        if (rawPrev3 != null) {
          const pa = typeof rawPrev3 === 'number' ? rawPrev3 : rawPrev3.c;
          if (pa && pa > 0) {
            const pb = a;
            const pc = b;
            const pd = cur;
            if (pa > pb && pc > pb && pd > pa * 0.98 && pd > pc && Math.abs(pb - pa) / pa < 0.03) {
              out.push({ sym, type: 'morning_star', ts: snap.ts, label: snap.label, score: 75, volSpike: true });
            }
          }
        }
      }
    }

    if (out.length >= 100) break;
  }
  Cache.allPatterns = out;
}

function computeDemandZones() {
  const zones = [];
  const MAX_BASES = 4;
  const snaps = S.snapshots;
  const snapLen = snaps.length;
  if (snapLen < 5) {
    Cache.demandZones = [];
    return;
  }

  // Scan backwards, up to 250 snapshots
  const limitIdx = Math.max(2, snapLen - 250);
  for (let i = snapLen - 2; i >= limitIdx; i--) {
    const snap = snaps[i];
    if (!snap || !snap.prices) continue;

    const snapPrev = snaps[i - 1];
    const snapPrev2 = snaps[i - 2];
    const snapNext = snaps[i + 1];
    if (!snapPrev || !snapPrev.prices || !snapPrev2 || !snapPrev2.prices || !snapNext || !snapNext.prices) continue;

    for (const sym in snap.prices) {
      const raw = snap.prices[sym];
      const rawPrev = snapPrev.prices[sym];
      const rawPrev2 = snapPrev2.prices[sym];
      const rawNext = snapNext.prices[sym];
      if (raw == null || rawPrev == null || rawPrev2 == null || rawNext == null) continue;

      const c2 = typeof raw === 'number' ? raw : raw.c;
      const c1 = typeof rawPrev === 'number' ? rawPrev : rawPrev.c;
      const c0 = typeof rawPrev2 === 'number' ? rawPrev2 : rawPrev2.c;
      const c3 = typeof rawNext === 'number' ? rawNext : rawNext.c;
      if (!c0 || !c1 || !c2 || !c3 || c0 <= 0 || c1 <= 0 || c2 <= 0 || c3 <= 0) continue;

      const r1 = c1 - c0;
      const r2 = c3 - c2;

      const body2 = Math.abs(c2 - c1);
      const range2 = c2 * 0.015;

      if (r1 > c1 * 0.012 && r2 > c3 * 0.012 && body2 < range2) {
        let nb = 1;
        let proximal = c2;
        let distal = c2 * 0.99;

        for (let b = 1; b < MAX_BASES; b++) {
          const nextSnap = snaps[i + b];
          if (nextSnap && nextSnap.prices) {
            const rawB = nextSnap.prices[sym];
            if (rawB != null) {
              const pB = typeof rawB === 'number' ? rawB : rawB.c;
              if (pB && Math.abs(pB - proximal) < range2) {
                nb++;
                proximal = Math.max(proximal, pB);
                distal = Math.min(distal, pB * 0.99);
              } else break;
            } else break;
          } else break;
        }

        const ltp = Cache.latestPrice[sym];
        const tested = ltp !== null && ltp < proximal;
        const notTested = ltp !== null && ltp > proximal * 1.02;

        zones.push({
          sym, ts: snap.ts, label: snap.label,
          proximal: +proximal.toFixed(2), distal: +distal.toFixed(2),
          rally1Close: +c1.toFixed(2), rally2Close: +c3.toFixed(2),
          numBases: nb, tested, notTested,
          distPct: ltp !== null ? +((ltp - proximal) / proximal * 100).toFixed(2) : null
        });
      }
    }

    if (zones.length >= 50) break;
  }

  Cache.demandZones = zones.sort((a, b) => {
    if (a.notTested !== b.notTested) return a.notTested ? -1 : 1;
    return b.ts - a.ts;
  });
}

// ── Formatting ───────────────────────────────────────────────────────────────
const fp = p => (p == null || isNaN(p)) ? '—' : 'Rs ' + ((+p).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fc = (c, short = false) => !c ? '—' : `${c.pct >= 0 ? '+' : ''}${short ? c.pct.toFixed(2) + '%' : c.abs.toFixed(2) + ' (' + c.pct.toFixed(2) + '%)'}`;
const fago = ts => { const d = Date.now() - ts; if (d < 60000) return 'just now'; if (d < 3600000) return Math.floor(d / 60000) + 'm ago'; if (d < 86400e3) return Math.floor(d / 3600000) + 'h ago'; return Math.floor(d / 86400e3) + 'd ago'; };
const fdt = ts => ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fds = ts => ts ? new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const cc = c => !c ? 'nu' : c.pct > 0 ? 'up' : 'dn';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

function spark(sym, w = 52, h = 22) {
  const cacheKey = `${sym}_${w}_${h}`;
  if (Cache.spark && Cache.spark[cacheKey]) return Cache.spark[cacheKey];

  const st = Cache.stats[sym];
  if (!st || st.count < 2) return `<svg width="${w}" height="${h}"></svg>`;
  const pr = st.prices;
  const mn = st.lo, mx = st.hi, rng = mx - mn || 1;
  const pts = pr.map((p, i) => `${(i / (pr.length - 1)) * (w - 2) + 1},${h - ((p - mn) / rng) * (h - 4) - 2}`).join(' ');
  const c = Cache.change[sym];
  const col = c ? (c.pct >= 0 ? '#00f5b4' : '#ff4d6d') : 'rgba(255, 255, 255, 0.15)';
  const svg = `<svg width="${w}" height="${h}" class="sparksvg"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;

  if (!Cache.spark) Cache.spark = {};
  Cache.spark[cacheKey] = svg;
  return svg;
}

// Canvas chart
const DPR = Math.min(window.devicePixelRatio || 1, 2);
function drawChart(canvas, sr, sym) {
  if (!canvas) return;
  const outer = canvas.parentElement;
  const W = outer ? outer.clientWidth : 600, H = outer ? outer.clientHeight : 220;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d'); ctx.scale(DPR, DPR);
  const pr = sr.map(s => s.price).filter(p => typeof p === 'number' && isFinite(p) && p > 0);
  if (pr.length < 2) { ctx.fillStyle = '#606880'; ctx.font = '11px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Insufficient data', W / 2, H / 2); return; }
  const mn = Math.min(...pr), mx = Math.max(...pr), rng = mx - mn || mx * 0.01 || 1;
  const pad = { t: 16, b: 28, l: 60, r: 12 };
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
  const xp = i => pad.l + (i / (pr.length - 1)) * cw;
  const yp = v => pad.t + (1 - (v - mn) / rng) * ch;
  
  // grid
  ctx.strokeStyle = '#1e2030'; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (i / 4) * ch; const val = mx - (i / 4) * rng;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillStyle = '#606880'; ctx.font = '9px Inter, sans-serif'; ctx.textAlign = 'right';
    ctx.fillText((val >= 1000 ? val.toFixed(0) : val.toFixed(2)), pad.l - 4, y + 3);
  }
  ctx.setLineDash([]);
  
  // x labels
  ctx.fillStyle = '#606880'; ctx.font = '8px Inter, sans-serif'; ctx.textAlign = 'center';
  const step = Math.max(1, Math.ceil(sr.length / Math.floor(cw / 50)));
  for (let i = 0; i < sr.length; i += step) {
    if (sr[i]?.ts) ctx.fillText(new Date(sr[i].ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), xp(i), H - 6);
  }
  
  // gradient
  const isUp = pr[pr.length - 1] >= pr[0];
  const col = isUp ? '#ff2e93' : '#ff4d6d';
  const lineGrad = ctx.createLinearGradient(pad.l, 0, W - pad.r, 0);
  if (isUp) {
    lineGrad.addColorStop(0, '#ff2e93');
    lineGrad.addColorStop(1, '#ff7ebb');
  } else {
    lineGrad.addColorStop(0, '#ff4d6d');
    lineGrad.addColorStop(1, '#ff003c');
  }
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ch);
  grad.addColorStop(0, isUp ? 'rgba(255, 46, 147, 0.25)' : 'rgba(255, 77, 109, 0.25)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath(); ctx.moveTo(xp(0), yp(pr[0]));
  for (let i = 1; i < pr.length; i++) ctx.lineTo(xp(i), yp(pr[i]));
  ctx.lineTo(xp(pr.length - 1), pad.t + ch); ctx.lineTo(pad.l, pad.t + ch); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  
  // line
  ctx.beginPath(); ctx.moveTo(xp(0), yp(pr[0]));
  for (let i = 1; i < pr.length; i++) ctx.lineTo(xp(i), yp(pr[i]));
  ctx.strokeStyle = lineGrad; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
  ctx.shadowColor = col; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
  
  // dot
  const lx = xp(pr.length - 1), ly = yp(pr[pr.length - 1]);
  ctx.beginPath(); ctx.arc(lx, ly, 5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
  ctx.beginPath(); ctx.arc(lx, ly, 2, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
  
  // tooltip data
  canvas._data = { sr, pr, xp, yp, col };
}
function addChartTooltip(canvas, tipEl) {
  if (!canvas || !tipEl) return;
  canvas.style.cursor = 'crosshair';
  canvas.onmousemove = e => {
    const d = canvas._data; if (!d) return;
    const rect = canvas.getBoundingClientRect(); const mx = e.clientX - rect.left;
    let best = 0, bd = Infinity;
    d.pr.forEach((_, i) => { const dist = Math.abs(d.xp(i) - mx); if (dist < bd) { bd = dist; best = i; } });
    if (bd > 50) { tipEl.style.display = 'none'; return; }
    const p = d.pr[best], prev = best > 0 ? d.pr[best - 1] : null;
    const pct = prev ? ((p - prev) / prev * 100).toFixed(2) : null;
    tipEl.style.display = 'block';
    tipEl.style.left = Math.min(d.xp(best) + 12, canvas.offsetWidth - 130) + 'px';
    tipEl.style.top = Math.max(0, d.yp(p) - 50) + 'px';
    tipEl.innerHTML = `<div style="font-size:9px;color:var(--t3);margin-bottom:3px">${d.sr[best]?.label || fdt(d.sr[best]?.ts)}</div>
    <div style="font-family:var(--display);font-size:14px;font-weight:700;color:${d.col}">${fp(p)}</div>
    ${pct ? `<div style="font-size:10px;color:${+pct >= 0 ? 'var(--green)' : 'var(--red)'}">${+pct >= 0 ? '+' : ''}${pct}%</div>` : ''}`;
  };
  canvas.onmouseleave = () => { tipEl.style.display = 'none'; };
}

// Distribution bars
function distBar(el, prices) {
  if (!el || !prices || prices.length < 3) { if (el) el.innerHTML = '<span style="color:var(--t3);font-size:10px">Not enough data</span>'; return; }
  const mn = Math.min(...prices), mx = Math.max(...prices), rng = mx - mn || 1;
  const B = 12, counts = new Array(B).fill(0);
  prices.forEach(p => { const b = Math.min(B - 1, Math.floor((p - mn) / rng * B)); counts[b]++; });
  const mc = Math.max(...counts) || 1;
  el.innerHTML = '<div style="display:flex;align-items:flex-end;gap:2px;height:50px">' +
    counts.map((c, i) => `<div style="flex:1;height:${Math.max(3, Math.round(c / mc * 46))}px;background:hsl(${160 + i * 4},65%,48%);border-radius:2px 2px 0 0" title="${c}"></div>`).join('') + '</div>';
}

// Strength bar
function sbar(score) {
  const col = score >= 67 ? 'var(--green)' : score >= 34 ? 'var(--yellow)' : 'var(--red)';
  return `<div class="sbar"><div class="sbar-track"><div class="sbar-fill" style="width:${score}%;background:${col}"></div></div><span style="font-size:9px;color:${col};font-weight:700;width:22px">${score}</span></div>`;
}

// Helper functions for client-side parsing of Google Sheets data
function cleanStr(v) {
  if (!v) return "";
  let s = String(v).trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function parseSheetTimestamp(raw) {
  const s = cleanStr(raw);
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
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (dmy) {
    const [, day, mon, yr, hh = "00", mm = "00", ss = "00"] = dmy;
    const yr_num = +yr;
    if (yr_num < 2000 || yr_num > 2100) return null;
    const ts = new Date(`${yr}-${mon.padStart(2, "0")}-${day.padStart(2, "0")}T${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:${ss.padStart(2, "0")}`).getTime();
    return isNaN(ts) ? null : ts;
  }
  const d = new Date(s);
  const ts = d.getTime();
  if (!isNaN(ts) && ts >= 946684800000 && ts <= 4102444800000) return ts;
  return null;
}

function parseSheetPrice(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return isFinite(raw) && raw > 0 ? raw : null;
  let s = cleanStr(raw);
  if (!s || ["#N/A", "N/A", "#VALUE!", "#REF!", "#ERROR!", "#NUM!", "Loading...", ""].includes(s)) return null;
  let n = parseFloat(s);
  if (isNaN(n)) n = parseFloat(s.replace(/[^\d.-]/g, ""));
  return isFinite(n) && n > 0 ? n : null;
}

function dedupeSnapshotsByTs(snaps) {
  const tsBest = {};
  for (const s of snaps || []) {
    if (!s || typeof s.ts !== 'number' || !s.prices || typeof s.prices !== 'object') continue;
    if (!tsBest[s.ts] || String(s.id || '') > String(tsBest[s.ts].id || '')) {
      tsBest[s.ts] = s;
    }
  }
  return Object.values(tsBest).sort((a, b) => a.ts - b.ts);
}

function saveLocalCache() {
  const base = {
    symbols: S.symbols,
    lastSync: S.lastSync,
    portfolio: S.portfolio,
    watchlists: S.watchlists,
    watchlistItems: S.watchlistItems,
    alerts: S.alerts,
    screeners: S.screeners,
  };
  for (const n of [40, 25, 15, 5]) {
    try {
      localStorage.setItem('marketai_cache', JSON.stringify({
        ...base,
        snapshots: S.snapshots.slice(-n),
      }));
      return;
    } catch (e) {}
  }
  console.warn('Failed to save to localStorage');
}

function fetchFromGoogleSheetsRealtime() {
  return new Promise((resolve, reject) => {
    const sheetId = SHEET_CONFIG.id;

    function fetchJSONP(sheetName, timeoutMs = 20000) {
      return new Promise((res, rej) => {
        let settled = false;
        const callbackName = 'gsc_' + sheetName.replace(/\W/g, '') + '_' + Math.round(Math.random() * 10000000);
        const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=responseHandler:${callbackName}&sheet=${encodeURIComponent(sheetName)}&t=${Date.now()}`;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          rej(new Error(`Timeout loading sheet "${sheetName}" after ${timeoutMs / 1000}s`));
        }, timeoutMs);

        window[callbackName] = function(data) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          if (!data || data.status === 'error') {
            const err = data?.errors?.[0];
            rej(new Error(err?.detailed_message || err?.message || `Google Sheets query failed for "${sheetName}"`));
            return;
          }
          res(data);
        };

        const script = document.createElement('script');
        script.src = url;
        script.id = callbackName;
        script.onerror = function() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          rej(new Error(`Network error loading sheet "${sheetName}"`));
        };

        function cleanup() {
          try { const el = document.getElementById(callbackName); if (el) el.remove(); } catch (e) {}
          try { delete window[callbackName]; } catch (e) {}
        }

        document.body.appendChild(script);
      });
    }

    function gvizColTimestamp(col) {
      if (!col) return null;
      if (col.v instanceof Date) {
        const ts = col.v.getTime();
        if (!isNaN(ts) && ts > 946684800000 && ts < 4102444800000) return ts;
      }
      if (col.v != null && typeof col.v === 'string') {
        const ts = parseSheetTimestamp(col.v);
        if (ts) return ts;
      }
      if (col.label) {
        const ts = parseSheetTimestamp(col.label);
        if (ts) return ts;
      }
      if (col.id) {
        const ts = parseSheetTimestamp(col.id);
        if (ts) return ts;
      }
      return null;
    }

    function gvizColLabel(col) {
      if (col.label && col.label.trim()) return col.label.trim();
      if (col.v instanceof Date) {
        try {
          return col.v.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        } catch (e) { return col.v.toISOString().slice(0, 16); }
      }
      if (col.id && col.id.trim()) return col.id.trim();
      return '';
    }

    function gvizCellPrice(cell) {
      if (!cell) return null;
      if (typeof cell.v === 'number') return isFinite(cell.v) && cell.v > 0 ? cell.v : null;
      if (cell.v != null) {
        const parsed = parseSheetPrice(cell.v);
        if (parsed !== null) return parsed;
      }
      if (cell.f) return parseSheetPrice(cell.f);
      return null;
    }

    Promise.all([
      fetchJSONP(SHEET_CONFIG.symbolsTab).catch(err => {
        console.warn('[MarketAI] SYMBOLS sheet fetch failed:', err.message);
        return null;
      }),
      fetchJSONP(SHEET_CONFIG.nseTab)
    ])
    .then(([symbolsData, nseData]) => {
      try {
        if (!nseData || !nseData.table) throw new Error("NSE sheet returned no table data from Google");

        const table = nseData.table;
        const cols = table.cols || [];
        const rows = table.rows || [];

        if (rows.length < 1) throw new Error("NSE sheet has no rows");
        if (cols.length < 2) throw new Error("NSE sheet has no timestamp columns");

        const firstColLabel = (cols[0]?.label || '').toUpperCase();
        const firstColType  = (cols[0]?.type  || '').toLowerCase();
        const firstColIsSymbol = firstColLabel.includes('SYMBOL') || firstColType === 'string' ||
          (rows.length > 0 && rows[0].c?.[0]?.v && typeof rows[0].c[0].v === 'string' && isNaN(parseFloat(rows[0].c[0].v)));

        const startCol = firstColIsSymbol ? 1 : 0;
        const MAX_SNAPS = 2000;

        let meta = [];
        const seenTs = new Set();
        for (let c = startCol; c < cols.length; c++) {
          const col = cols[c];
          const ts = gvizColTimestamp(col);
          if (!ts) continue;
          if (seenTs.has(ts)) continue;
          seenTs.add(ts);
          meta.push({ col: c, label: gvizColLabel(col) || col.label || '', ts });
        }

        meta.sort((a, b) => a.ts - b.ts);
        if (meta.length > MAX_SNAPS) {
          meta.splice(0, meta.length - MAX_SNAPS);
        }

        let dataStartRow = 0;
        if (meta.length === 0 && rows.length > 0) {
          console.warn('[MarketAI] No timestamps in cols — trying row[0] as header fallback...');
          const headerRow = rows[0]?.c || [];
          const fbMeta = [];
          const fbSeenTs = new Set();
          for (let c = startCol; c < headerRow.length; c++) {
            const cell = headerRow[c];
            const raw = cell?.f || cell?.v;
            if (!raw) continue;
            const ts = parseSheetTimestamp(String(raw));
            if (!ts) continue;
            if (fbSeenTs.has(ts)) continue;
            fbSeenTs.add(ts);
            fbMeta.push({ col: c, label: String(cell?.f || cell?.v || ''), ts });
          }
          fbMeta.sort((a, b) => a.ts - b.ts);
          if (fbMeta.length > MAX_SNAPS) {
            fbMeta.splice(0, fbMeta.length - MAX_SNAPS);
          }
          fbMeta.forEach(m => meta.push(m));
          if (meta.length > 0) dataStartRow = 1;
        }

        if (meta.length === 0) {
          throw new Error("NSE sheet: no timestamp columns found");
        }

        const priceMap = {};
        meta.forEach(m => { priceMap[m.ts + '_' + m.col] = {}; });
        const symsSet = new Set();

        for (let r = dataStartRow; r < rows.length; r++) {
          const row = rows[r];
          if (!row || !row.c || row.c.length === 0) continue;

          const symCell = row.c[0];
          const rawSym = cleanStr(symCell?.v || symCell?.f || '').toUpperCase().replace(/\s+/g, '');

          if (!rawSym || rawSym === 'SYMBOL' || rawSym.startsWith('SYMBOL') ||
              rawSym === '#N/A' || rawSym === '#ERROR!' || rawSym === '#VALUE!') continue;

          symsSet.add(rawSym);

          for (const m of meta) {
            const cell = row.c[m.col];
            const p = gvizCellPrice(cell);
            if (p !== null) {
              priceMap[m.ts + '_' + m.col][rawSym] = p;
            }
          }
        }

        const validSnaps = meta
          .map(m => ({
            id: `snap_${m.ts}_${m.col}`,
            ts: m.ts,
            label: m.label,
            prices: priceMap[m.ts + '_' + m.col]
          }))
          .filter(s => Object.keys(s.prices).length > 0)
          .sort((a, b) => a.ts - b.ts);

        if (validSnaps.length === 0) {
          throw new Error("NSE sheet parsed but no valid price data found");
        }

        resolve({
          snapshots: dedupeSnapshotsByTs(validSnaps),
          symbols: [...symsSet].sort(),
          lastSync: Date.now(),
          syncCount: 1,
          portfolio: S.portfolio || [],
          watchlists: S.watchlists || [],
          watchlistItems: S.watchlistItems || [],
          alerts: S.alerts || [],
          screeners: S.screeners || []
        });
      } catch (e) {
        reject(e);
      }
    })
    .catch(err => {
      reject(err);
    });
  });
}

// ── Data layer ───────────────────────────────────────────────────────────────
async function fetchData() {
  try {
    const r = await fetch(`${API}/api/data`);
    if (r.ok) {
      const data = await r.json();
      if (data && data.snapshots && data.snapshots.length > 0) {
        return data;
      }
    }
  } catch (err) {
    console.warn('API fetch failed, trying local storage cache...', err);
  }

  try {
    const cached = JSON.parse(localStorage.getItem('marketai_cache') || '{}');
    if (cached.snapshots && cached.snapshots.length > 0) {
      return cached;
    }
  } catch (e) {}

  return await fetchFromGoogleSheetsRealtime();
}
async function saveUserData() {
  try {
    const cached = JSON.parse(localStorage.getItem('marketai_cache') || '{}');
    cached.portfolio = S.portfolio;
    cached.watchlists = S.watchlists;
    cached.watchlistItems = S.watchlistItems;
    cached.alerts = S.alerts;
    cached.screeners = S.screeners;
    localStorage.setItem('marketai_cache', JSON.stringify(cached));
  } catch (e) {}

  await fetch(`${API}/api/data`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ portfolio: S.portfolio, watchlists: S.watchlists, watchlistItems: S.watchlistItems, alerts: S.alerts, screeners: S.screeners })
  });
}

async function doSync(silent = false) {
  if (S.syncing) return;
  S.syncing = true;
  const btn = document.getElementById('syncBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing...'; }
  setSyncState('spin', 'Syncing...');
  setLoad(30);
  try {
    let d;
    try {
      const r = await fetch(`${API}/api/sync`, { method: 'POST' });
      const j = await r.json();
      setLoad(70);
      if (!j.ok) throw new Error(j.error || 'Sync failed');

      if (j.snapshots && j.snapshots.length > 0) {
        d = j;
        d.portfolio = S.portfolio || [];
        d.watchlists = S.watchlists || [];
        d.watchlistItems = S.watchlistItems || [];
        d.alerts = S.alerts || [];
        d.screeners = S.screeners || [];
      } else {
        d = await fetchData();
      }
    } catch (apiErr) {
      console.warn('Server sync failed, falling back to direct browser sync from Google Sheets:', apiErr);
      setLoad(50);
      d = await fetchFromGoogleSheetsRealtime();
    }
    mergeData(d);
    setLoad(100);
    setSyncState('ok', `Synced ${fago(S.lastSync)} · ${S.snapshots.length} snaps`);
    if (!silent) toast(`Synced ${S.snapshots.length} snapshots · ${S.symbols.length} symbols`, 'ok');
    renderAll();
  } catch (e) {
    setSyncState('err', 'Sync failed');
    if (!silent) toast(e.message, 'err');
  } finally {
    S.syncing = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Sync'; }
    setTimeout(() => setLoad(0), 600);
  }
}

function mergeData(d) {
  if (d.snapshots) S.snapshots = dedupeSnapshotsByTs(d.snapshots);
  if (d.symbols) S.symbols = d.symbols;
  if (d.lastSync) S.lastSync = d.lastSync;
  if (d.portfolio) S.portfolio = d.portfolio;
  if (d.watchlists) S.watchlists = d.watchlists;
  if (d.watchlistItems) S.watchlistItems = d.watchlistItems;
  if (d.alerts) S.alerts = d.alerts;
  if (d.screeners) S.screeners = d.screeners;
  precomputeCache();
  saveLocalCache();
}

// ── Groq AI ──────────────────────────────────────────────────────────────────
async function askGroq(prompt, context = '') {
  const messages = [
    { role: 'system', content: `You are MarketAI, a professional NSE stock market analyst. Be concise, data-driven, and use numbers. Context: ${context}` },
    { role: 'user', content: prompt }
  ];
  const r = await fetch(`${API}/api/groq`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages, max_tokens: 400 }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Groq unavailable');
  return j.text;
}

// ── UI Helpers ────────────────────────────────────────────────────────────────
function setLoad(pct) { const el = document.getElementById('loadbar'); if (el) el.style.width = pct + '%'; }
function setSyncState(type, lbl) {
  const d = document.getElementById('sdot'); const l = document.getElementById('slbl');
  if (d) d.className = 'sync-dot' + (type ? ' ' + type : '');
  if (l) l.textContent = lbl;
}
let toastT;
function toast(msg, type = 'ok') {
  const wrap = document.getElementById('toasts'); if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span style="color:${type === 'ok' ? 'var(--green)' : 'var(--red)'}">&#x25CF;</span> ${msg}`;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 4000);
}
function showModal(title, body, footer = '') {
  document.getElementById('mbox').innerHTML = `
    <div class="modal-hdr"><div class="modal-title">${title}</div><button class="modal-close" onclick="closeModal()">&#x2715;</button></div>
    <div>${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ''}`;
  document.getElementById('mbox').style.display = 'block';
  document.getElementById('mbg').style.display = 'block';
}
function closeModal() {
  document.getElementById('mbox').style.display = 'none';
  document.getElementById('mbg').style.display = 'none';
}

// Ticker
function renderTicker() {
  const el = document.getElementById('ticker');
  const inner = document.getElementById('tickerInner');
  const validSyms = S.symbols.filter(s => { const st = stats(s); return st && st.count >= 1; });
  if (!validSyms.length) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const items = validSyms.slice(0, 60).map(sym => {
    const p = latestPrice(sym), c = change(sym), cls = cc(c);
    const arrow = c ? (c.pct >= 0 ? '+' : '-') : '';
    return `<div class="ti"><span class="ti-sym">${sym}</span><span class="${cls}">${fp(p)}</span><span class="${cls}" style="font-size:9px">${c ? arrow + Math.abs(c.pct).toFixed(2) + '%' : ''}</span></div>`;
  }).join('');
  inner.innerHTML = items + items;
}

// Sidebar
let sbTab = 'all';
function setSbTab(t, el) {
  sbTab = t;
  document.querySelectorAll('.sb-tab').forEach(e => e.classList.remove('active'));
  if (el) el.classList.add('active');
  renderSidebar();
}
function renderSidebar() {
  const q = (document.getElementById('sbSearch')?.value || '').toUpperCase();
  let syms = [...S.symbols].filter(s => { const st = stats(s); return st && st.count >= 1; });
  if (q) syms = syms.filter(s => s.includes(q));
  if (sbTab === 'gain') syms = syms.filter(s => { const c = change(s); return c && c.pct > 0.01; });
  if (sbTab === 'loss') syms = syms.filter(s => { const c = change(s); return c && c.pct < -0.01; });
  if (sbTab === 'gain') syms.sort((a, b) => (change(b)?.pct || 0) - (change(a)?.pct || 0));
  if (sbTab === 'loss') syms.sort((a, b) => (change(a)?.pct || 0) - (change(b)?.pct || 0));
  const cnt = document.getElementById('symCount');
  if (cnt) cnt.textContent = S.symbols.length;
  const el = document.getElementById('sbList'); if (!el) return;
  if (!syms.length) { el.innerHTML = `<div style="padding:20px;color:var(--t3);font-size:11px;text-align:center">${S.symbols.length ? 'No matches' : 'Sync data first'}</div>`; return; }
  el.innerHTML = syms.slice(0, 300).map(sym => {
    const p = latestPrice(sym), c = change(sym), cls = cc(c);
    return `<div class="si${S.activeStock === sym ? ' active' : ''}" onclick="openStock('${sym}')">
      ${spark(sym, 44, 18)}
      <div class="si-info">
        <div class="si-sym">${sym}</div>
        <div class="si-chg ${cls}">${c ? fc(c, true) : '—'}</div>
      </div>
      <div class="si-price ${cls}">${fp(p)}</div>
    </div>`;
  }).join('');
}

function openStock(sym) {
  S.activeStock = sym;
  nav('stockDetail', { sym, exchange: 'nse' });
}

// ── Navigation Indicator Physics (Apple Liquid style) ──────────────────────
function updateNavIndicator(pg) {
  const activeBtn = document.querySelector(`.nav-sidebar .nav-icon-btn[data-pg="${pg}"]`);
  const indicator = document.getElementById('nav-indicator');
  if (!activeBtn || !indicator) return;
  
  indicator.style.display = 'block';
  
  const rect = activeBtn.getBoundingClientRect();
  const parentRect = activeBtn.parentElement.getBoundingClientRect();
  const targetTop = rect.top - parentRect.top;
  
  const prevTop = parseFloat(indicator.dataset.top);
  if (!isNaN(prevTop) && prevTop !== targetTop) {
    const diff = Math.abs(targetTop - prevTop);
    const stretch = Math.min(25, diff * 0.35);
    
    indicator.style.height = `${46 + stretch}px`;
    if (targetTop > prevTop) {
      indicator.style.transform = `translateY(${targetTop - stretch}px)`;
    } else {
      indicator.style.transform = `translateY(${targetTop}px)`;
    }
    
    setTimeout(() => {
      indicator.style.height = '46px';
      indicator.style.transform = `translateY(${targetTop}px)`;
    }, 220);
  } else {
    indicator.style.transform = `translateY(${targetTop}px)`;
    indicator.style.height = '46px';
  }
  
  indicator.dataset.top = targetTop;
}

window.toggleSidebar = function() {
  const body = document.querySelector('.body');
  const icon = document.getElementById('sidebarToggleIcon');
  if (body) {
    const isCollapsed = body.classList.toggle('sidebar-collapsed');
    localStorage.setItem('sidebar-collapsed', isCollapsed ? 'true' : 'false');
    if (icon) {
      icon.style.transform = isCollapsed ? 'rotate(180deg)' : 'rotate(0deg)';
    }
  }
};

let logoClicks = 0;
let logoTimer;
window.handleLogoClick = function() {
  logoClicks++;
  clearTimeout(logoTimer);
  logoTimer = setTimeout(() => { logoClicks = 0; }, 1500);
  if (logoClicks >= 5) {
    logoClicks = 0;
    nav('settings');
    toast('Admin Panel Unlocked', 'ok');
  } else {
    nav('dashboard');
  }
};

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    if (newTheme === 'dark') {
      themeToggle.classList.add('on');
    } else {
      themeToggle.classList.remove('on');
    }
  }
}

// ── Interactive Liquid Background Canvas ─────────────────────────────────────
function initLiquidBg() {
  const canvas = document.getElementById('liquid-bg');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  let width = canvas.width = window.innerWidth / 4;
  let height = canvas.height = window.innerHeight / 4;
  
  window.addEventListener('resize', () => {
    width = canvas.width = window.innerWidth / 4;
    height = canvas.height = window.innerHeight / 4;
    if (S.activePage) updateNavIndicator(S.activePage);
  });
  
  const blobs = [
    { x: width * 0.2, y: height * 0.3, r: 120, vx: 0.08, vy: 0.11, getCol: () => document.documentElement.getAttribute('data-theme') === 'light' ? 'rgba(255, 255, 255, 0.45)' : 'rgba(10, 15, 30, 0.5)' },
    { x: width * 0.8, y: height * 0.7, r: 155, vx: -0.06, vy: -0.09, getCol: () => document.documentElement.getAttribute('data-theme') === 'light' ? 'rgba(255, 180, 200, 0.35)' : 'rgba(0, 150, 255, 0.15)' },
    { x: width * 0.5, y: height * 0.1, r: 105, vx: 0.1, vy: -0.07, getCol: () => document.documentElement.getAttribute('data-theme') === 'light' ? 'rgba(240, 210, 255, 0.4)' : 'rgba(142, 36, 170, 0.15)' },
    { x: width * 0.3, y: height * 0.9, r: 135, vx: -0.05, vy: 0.12, getCol: () => document.documentElement.getAttribute('data-theme') === 'light' ? 'rgba(255, 220, 230, 0.45)' : 'rgba(0, 220, 255, 0.12)' }
  ];
  
  const rain = [];
  const maxRain = 35;
  for (let i = 0; i < maxRain; i++) {
    rain.push({
      x: Math.random() * width,
      y: Math.random() * height,
      len: Math.random() * 12 + 6,
      speed: Math.random() * 2 + 3,
      opacity: Math.random() * 0.15 + 0.05
    });
  }
  
  let mouse = { x: -1000, y: -1000 };
  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX / 4;
    mouse.y = e.clientY / 4;
  });
  
  let ripples = [];
  window.addEventListener('click', (e) => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    ripples.push({
      x: e.clientX / 4,
      y: e.clientY / 4,
      r: 4,
      maxR: 80,
      opacity: 0.9,
      col: isLight
        ? (Math.random() > 0.5 ? 'rgba(217, 0, 108, 0.25)' : 'rgba(142, 36, 170, 0.25)')
        : (Math.random() > 0.5 ? 'rgba(0, 210, 255, 0.25)' : 'rgba(191, 85, 236, 0.25)')
    });
  });
  
  function animate() {
    ctx.clearRect(0, 0, width, height);
    
    ctx.strokeStyle = document.documentElement.getAttribute('data-theme') === 'light' ? 'rgba(217, 0, 108, 0.08)' : 'rgba(0, 210, 255, 0.1)';
    ctx.lineWidth = 0.6;
    ctx.globalCompositeOperation = 'source-over';
    rain.forEach(r => {
      ctx.beginPath();
      ctx.moveTo(r.x, r.y);
      ctx.lineTo(r.x + 0.4, r.y + r.len);
      ctx.stroke();
      
      r.y += r.speed;
      r.x += 0.2;
      if (r.y > height) {
        r.y = -r.len;
        r.x = Math.random() * width;
      }
    });
    
    ripples.forEach((rip, rIdx) => {
      rip.r += 2.2;
      rip.opacity -= 0.025;
      if (rip.opacity <= 0 || rip.r >= rip.maxR) {
        ripples.splice(rIdx, 1);
        return;
      }
      
      blobs.forEach(b => {
        const dx = b.x - rip.x;
        const dy = b.y - rip.y;
        const dist = Math.hypot(dx, dy);
        if (dist < rip.r + 50 && dist > 0) {
          const force = (rip.r + 50 - dist) * 0.1;
          b.x += (dx / dist) * force;
          b.y += (dy / dist) * force;
        }
      });
      
      const grad = ctx.createRadialGradient(rip.x, rip.y, 0, rip.x, rip.y, rip.r);
      grad.addColorStop(0, rip.col);
      grad.addColorStop(0.3, rip.col);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      
      ctx.beginPath();
      ctx.arc(rip.x, rip.y, rip.r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.globalAlpha = rip.opacity;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fill();
      ctx.globalAlpha = 1;
    });
    
    blobs.forEach(b => {
      b.x += b.vx;
      b.y += b.vy;
      
      if (b.x - b.r < -100 || b.x + b.r > width + 100) b.vx *= -1;
      if (b.y - b.r < -100 || b.y + b.r > height + 100) b.vy *= -1;
      
      const dx = b.x - mouse.x;
      const dy = b.y - mouse.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 130) {
        const force = (130 - dist) * 0.02;
        b.x += (dx / dist) * force;
        b.y += (dy / dist) * force;
      }
      
      const col = b.getCol();
      const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      grad.addColorStop(0, col);
      grad.addColorStop(0.15, col);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fill();
    });
    
    ctx.globalCompositeOperation = 'source-over';
    requestAnimationFrame(animate);
  }
  animate();
}

function generateMockData() {
  const syms = ['RELIANCE', 'TCS', 'INFOSYS', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'BHARTIARTL', 'ITC', 'LT', 'HINDUNILVR', 'KOTAKBANK', 'WIPRO'];
  const basePrices = {
    RELIANCE: 2450.50,
    TCS: 3350.20,
    INFOSYS: 1420.80,
    HDFCBANK: 1610.15,
    ICICIBANK: 920.40,
    SBIN: 580.60,
    BHARTIARTL: 840.10,
    ITC: 430.75,
    LT: 2850.00,
    HINDUNILVR: 2520.30,
    KOTAKBANK: 1840.90,
    WIPRO: 395.25
  };
  
  const snapshots = [];
  const startTs = Date.now() - 20 * 24 * 3600 * 1000;
  
  for (let i = 0; i < 20; i++) {
    const ts = startTs + i * 24 * 3600 * 1000;
    const date = new Date(ts);
    const label = date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const prices = {};
    
    syms.forEach(sym => {
      const base = basePrices[sym];
      let changePercent = (Math.sin(i * 0.6 + sym.charCodeAt(0)) * 1.6) + (Math.cos(i * 0.9) * 0.9);
      if (sym === 'SBIN' && i > 12) changePercent += 1.8;
      if (sym === 'RELIANCE') changePercent += 0.6;
      if (sym === 'TCS' && i === 18) changePercent -= 3.5;
      if (sym === 'TCS' && i === 19) changePercent += 4.5;
      
      const price = base * (1 + (changePercent * i * 0.006));
      prices[sym] = parseFloat(price.toFixed(2));
    });
    
    snapshots.push({ ts, label, prices });
  }
  
  const portfolio = [
    { id: 'pf-mock1', sym: 'RELIANCE', qty: 50, avgBuy: 2400.00, date: new Date(startTs).toISOString().slice(0, 10) },
    { id: 'pf-mock2', sym: 'INFOSYS', qty: 120, avgBuy: 1450.00, date: new Date(startTs + 2 * 24 * 3600 * 1000).toISOString().slice(0, 10) }
  ];
  
  const watchlists = [
    { id: 'wl-mock1', name: 'Nifty Heavyweights', desc: 'Core market leaders', createdAt: new Date().toISOString() }
  ];
  
  const watchlistItems = [
    { id: 'wli-mock1', wlId: 'wl-mock1', sym: 'RELIANCE', addedAt: new Date().toISOString() },
    { id: 'wli-mock2', wlId: 'wl-mock1', sym: 'TCS', addedAt: new Date().toISOString() },
    { id: 'wli-mock3', wlId: 'wl-mock1', sym: 'HDFCBANK', addedAt: new Date().toISOString() }
  ];
  
  const alerts = [
    { id: 'al-mock1', sym: 'RELIANCE', cond: 'above', target: 2600.00, active: true, createdAt: new Date().toISOString() }
  ];
  
  return {
    snapshots,
    symbols: syms,
    lastSync: Date.now(),
    portfolio,
    watchlists,
    watchlistItems,
    alerts,
    screeners: []
  };
}

// ── Modals / Dialogs global handlers ─────────────────────────────────────────
window.addToPortfolio = function(sym) {
  const p = latestPrice(sym) || 0;
  showModal('Add to Portfolio', `
    <div class="form-grp"><label class="form-lbl">Symbol</label>
      <input class="form-inp" id="pfSym" value="${sym}" ${sym ? 'readonly' : ''} placeholder="e.g. RELIANCE"></div>
    <div class="form-row">
      <div class="form-grp"><label class="form-lbl">Qty</label><input class="form-inp" id="pfQty" type="number" min="1" value="1" oninput="pfCalc()"></div>
      <div class="form-grp"><label class="form-lbl">Avg Buy (Rs)</label><input class="form-inp" id="pfPrice" type="number" step="0.01" value="${p.toFixed(2)}" oninput="pfCalc()"></div>
    </div>
    <div class="form-grp"><label class="form-lbl">Date</label><input class="form-inp" id="pfDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
    <div style="background:var(--s3);border:1px solid var(--b1);border-radius:var(--r6);padding:10px 12px;font-size:11px;display:flex;justify-content:space-between">
      <span style="color:var(--t3)">Total Invested</span><span id="pfTotal" style="font-weight:700">${fp(p)}</span>
    </div>`,
    `<button class="btn btn-ghost btn-sm" onclick="closeModal()">Cancel</button><button class="btn btn-primary btn-sm" onclick="doAddPos()">Add</button>`);
};
window.addPosMdl = () => window.addToPortfolio('');
window.pfCalc = () => { const q = +document.getElementById('pfQty')?.value || 0; const p = +document.getElementById('pfPrice')?.value || 0; const el = document.getElementById('pfTotal'); if (el) el.textContent = fp(q * p); };
window.doAddPos = async () => {
  const sym = (document.getElementById('pfSym')?.value || '').trim().toUpperCase();
  const qty = +document.getElementById('pfQty')?.value; const price = +document.getElementById('pfPrice')?.value;
  const date = document.getElementById('pfDate')?.value;
  if (!sym || !qty || !price) return toast('Fill all required fields', 'err');
  S.portfolio.push({ id: 'pf' + uid(), sym, qty, avgBuy: price, date, createdAt: new Date().toISOString() });
  await saveUserData(); closeModal(); toast(`${sym} added to portfolio`);
  if (S.activePage === 'portfolio') nav('portfolio');
};

window.addToWatchlist = sym => showModal('Add to Watchlist', `
  <div class="form-grp"><label class="form-lbl">Symbol</label><input class="form-inp" id="wliSym" value="${sym || ''}" placeholder="e.g. RELIANCE" list="wliSymList">
    <datalist id="wliSymList">${S.symbols.slice(0, 200).map(s => `<option value="${s}">`).join('')}</datalist></div>
  <div class="form-grp"><label class="form-lbl">Watchlist</label>
    <select class="form-inp" id="wliWL">${S.watchlists.map(w => `<option value="${w.id}">${w.name}</option>`).join('') || '<option disabled>No watchlists — create one first</option>'}</select></div>`,
  `<button class="btn btn-ghost btn-sm" onclick="closeModal()">Cancel</button><button class="btn btn-primary btn-sm" onclick="doAddWLItem()">Add</button>`);
window.addToWLMdl = wlId => { window.addToWatchlist(''); setTimeout(() => { const el = document.getElementById('wliWL'); if (el) el.value = wlId; }, 0); };
window.doAddWLItem = async () => {
  const sym = (document.getElementById('wliSym')?.value || '').trim().toUpperCase();
  const wlId = document.getElementById('wliWL')?.value;
  if (!sym) return toast('Enter a symbol', 'err'); if (!wlId) return toast('Select a watchlist', 'err');
  S.watchlistItems.push({ id: 'wli' + uid(), wlId, sym, addedAt: new Date().toISOString() });
  await saveUserData(); closeModal(); toast(`${sym} added`);
  if (S.activePage === 'watchlists') nav('watchlists', { wlId });
};

window.createAlertMdl = () => showModal('Create Alert', `
  <div class="form-grp"><label class="form-lbl">Symbol</label>
    <input class="form-inp" id="alSym" placeholder="e.g. RELIANCE" list="alSymList">
    <datalist id="alSymList">${S.symbols.slice(0, 200).map(s => `<option value="${s}">`).join('')}</datalist></div>
  <div class="form-row">
    <div class="form-grp"><label class="form-lbl">Condition</label>
      <select class="form-inp" id="alCond"><option value="above">Price goes above</option><option value="below">Price goes below</option></select></div>
    <div class="form-grp"><label class="form-lbl">Target Price (Rs)</label>
      <input class="form-inp" id="alTarget" type="number" step="0.01" placeholder="0.00"></div>
  </div>`,
  `<button class="btn btn-ghost btn-sm" onclick="closeModal()">Cancel</button><button class="btn btn-primary btn-sm" onclick="doCreateAlert()">Create</button>`);
window.doCreateAlert = async () => {
  const sym = (document.getElementById('alSym')?.value || '').trim().toUpperCase();
  const target = parseFloat(document.getElementById('alTarget')?.value);
  if (!sym) return toast('Enter a symbol', 'err'); if (isNaN(target) || target <= 0) return toast('Enter valid price', 'err');
  S.alerts.push({ id: 'al' + uid(), sym, cond: document.getElementById('alCond')?.value || 'above', target, active: true, createdAt: new Date().toISOString() });
  await saveUserData(); closeModal(); toast(`Alert set for ${sym}`); if (S.activePage === 'alerts') nav('alerts');
};

// ── Workspace / Dashboard helpers ───────────────────────────────────────────
window.refreshAIBriefing = async function() {
  const el = document.getElementById('aiBriefing'); if (!el) return;
  const sum = summary(); const gainers = topGainers(3); const losers = topLosers(3);
  el.innerHTML = '<div class="ai-spinner"><div class="spin-ring"></div>Analyzing market data...</div>';
  try {
    const ctx = `NSE market: ${sum.total} stocks, ${sum.advances} advancing, ${sum.declines} declining. Top gainers: ${gainers.map(g => g.sym + ' ' + fc(g.c, true)).join(', ')}. Top losers: ${losers.map(l => l.sym + ' ' + fc(l.c, true)).join(', ')}. Snapshots: ${S.snapshots.length}.`;
    const text = await askGroq('Give a 3-sentence professional market briefing with key insights and what traders should watch today.', ctx);
    el.innerHTML = text || 'No AI analysis available.';
  } catch (e) { el.innerHTML = 'AI briefing unavailable. Set GROQ_API_KEY in Vercel environment variables.'; }
};

function glCard(title, list) {
  if (!list.length) return `<div class="card"><div class="card-hdr"><div class="card-title">${title}</div></div><div class="empty"><div class="empty-sub">No data — sync first</div></div></div>`;
  return `<div class="card">
    <div class="card-hdr"><div class="card-title">${title}</div><span style="font-size:10px;color:var(--t3)">${list.length} stocks</span></div>
    ${list.map(sym => {
      const c = change(sym); const cls = cc(c); return `<div class="gl-row" onclick="openStock('${sym}')">
      ${spark(sym, 44, 18)}
      <div style="flex:1;min-width:0"><div style="font-family:var(--display);font-size:11px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sym}</div></div>
      <div style="text-align:right;flex-shrink:0"><div class="${cls}" style="font-family:var(--display);font-size:11px;font-weight:700">${fp(latestPrice(sym))}</div>
      <div class="${cls}" style="font-size:9px">${c ? fc(c, true) : ''}</div></div>
    </div>`;
    }).join('')}
  </div>`;
}

window.setWS = function(id, el) {
  S.workspaces.forEach(w => w.active = w.id === id);
  document.querySelectorAll('.ws-tab').forEach(e => e.classList.remove('active'));
  if (el) el.classList.add('active');
};
window.addWSModal = function() {
  showModal('New Workspace', `
    <div class="form-grp"><label class="form-lbl">Name</label><input class="form-inp" id="wsName" placeholder="e.g. Pre-Market Scan"></div>`,
    `<button class="btn btn-ghost btn-sm" onclick="closeModal()">Cancel</button>
     <button class="btn btn-primary btn-sm" onclick="doAddWS()">Create</button>`);
};
window.doAddWS = function() {
  const n = document.getElementById('wsName')?.value?.trim(); if (!n) return;
  S.workspaces.push({ id: 'ws' + uid(), name: n, active: false });
  closeModal(); nav('dashboard');
};

// ── Router / Nav ─────────────────────────────────────────────────────────────
const pagePathMap = {
  dashboard: '/dashboard',
  stocks: '/stocks',
  patterns: '/patterns',
  demandzones: '/demandzones',
  screener: '/screener',
  portfolio: '/portfolio',
  watchlists: '/watchlists',
  alerts: '/alerts',
  settings: '/settings',
  more: '/more'
};

const Pages = {
  async dashboard(el, params) {
    const mod = await import('/js/pages/dashboard.js');
    mod.render(el, params);
  },
  async more(el, params) {
    const mod = await import('/js/pages/more.js');
    mod.render(el, params);
  },
  async stocks(el, params) {
    const mod = await import('/js/pages/stocks.js');
    mod.render(el, params);
  },
  async stockDetail(el, params) {
    const mod = await import('/js/pages/stockDetail.js');
    mod.render(el, params);
  },
  async patterns(el, params) {
    const mod = await import('/js/pages/patterns.js');
    mod.render(el, params);
  },
  async demandzones(el, params) {
    const mod = await import('/js/pages/demandzones.js');
    mod.render(el, params);
  },
  async screener(el, params) {
    const mod = await import('/js/pages/screener.js');
    mod.render(el, params);
  },
  async portfolio(el, params) {
    const mod = await import('/js/pages/portfolio.js');
    mod.render(el, params);
  },
  async watchlists(el, params) {
    const mod = await import('/js/pages/watchlists.js');
    mod.render(el, params);
  },
  async alerts(el, params) {
    const mod = await import('/js/pages/alerts.js');
    mod.render(el, params);
  },
  async settings(el, params) {
    const mod = await import('/js/pages/settings.js');
    mod.render(el, params);
  }
};

function nav(pg, params = {}) {
  S.activePage = pg;
  S.routeParams = params;

  let expectedPath = '/';
  if (pg === 'stockDetail') {
    const exchange = params.exchange || 'nse';
    const sym = params.sym || S.activeStock;
    expectedPath = `/${exchange}/stocks/${sym}`;
  } else if (pagePathMap[pg]) {
    expectedPath = pagePathMap[pg];
  }

  if (window.location.pathname !== expectedPath) {
    history.pushState(null, '', expectedPath);
  }

  document.querySelectorAll('.navlink').forEach(el => el.classList.toggle('active', el.dataset.pg === pg));
  if (typeof updateNavIndicator === 'function') updateNavIndicator(pg);

  const activeTab = ['dashboard', 'stocks', 'screener', 'portfolio'].includes(pg) ? pg : 'more';
  document.querySelectorAll('.m-nav-item').forEach(el => el.classList.toggle('active', el.dataset.pg === activeTab));

  const bodyEl = document.querySelector('.body');
  if (bodyEl) {
    bodyEl.classList.remove('show-sidebar-on-mobile');
    if (window.innerWidth <= 900 && !bodyEl.classList.contains('sidebar-collapsed')) {
      bodyEl.classList.add('sidebar-collapsed');
      localStorage.setItem('sidebar-collapsed', 'true');
      const icon = document.getElementById('sidebarToggleIcon');
      if (icon) icon.style.transform = 'rotate(180deg)';
    }
  }

  const area = document.getElementById('pageArea');
  if (!area) return;
  area.style.display = 'flex'; area.style.flexDirection = 'column'; area.style.height = '100%'; area.style.overflow = 'hidden';
  area.innerHTML = '';
  area.style.animation = 'none'; void area.offsetWidth; area.style.animation = 'fadeUp .2s ease';
  
  const fn = Pages[pg];
  if (fn) {
    fn(area, params).catch(err => {
      console.error('Failed to load page script:', err);
      area.innerHTML = `<div class="empty"><div class="empty-title">Error loading page</div><div class="empty-sub">${err.message}</div></div>`;
    });
  } else {
    area.innerHTML = `<div class="empty"><div class="empty-title">Page not found: ${pg}</div></div>`;
  }
  renderSidebar();
}

function renderAll() { renderTicker(); renderSidebar(); nav(S.activePage, S.routeParams || {}); }

function handleRoute() {
  const path = window.location.pathname;
  if (path === '/' || path === '/dashboard') {
    nav('dashboard');
  } else if (path === '/stocks') {
    nav('stocks');
  } else if (path === '/patterns') {
    nav('patterns');
  } else if (path === '/demandzones') {
    nav('demandzones');
  } else if (path === '/screener') {
    nav('screener');
  } else if (path === '/portfolio') {
    nav('portfolio');
  } else if (path === '/watchlists') {
    nav('watchlists');
  } else if (path === '/alerts') {
    nav('alerts');
  } else if (path === '/settings') {
    nav('settings');
  } else if (path === '/more') {
    nav('more');
  } else {
    const stockMatch = path.match(/^\/([^/]+)\/stocks\/([^/]+)$/i);
    if (stockMatch) {
      const exchange = stockMatch[1];
      const symbol = decodeURIComponent(stockMatch[2]);
      nav('stockDetail', { exchange, sym: symbol });
    } else {
      nav('dashboard');
    }
  }
}

window.addEventListener('popstate', handleRoute);

// ── BOOT ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.navlink[data-pg]').forEach(el => {
  el.addEventListener('click', () => nav(el.dataset.pg));
});

document.querySelectorAll('.m-nav-item[data-pg]').forEach(el => {
  el.addEventListener('click', () => nav(el.dataset.pg));
});

// Close sidebar drawer when clicking on the main content area on mobile
const mainEl = document.querySelector('.main');
if (mainEl) {
  mainEl.addEventListener('click', () => {
    if (window.innerWidth <= 900) {
      const body = document.querySelector('.body');
      if (body && !body.classList.contains('sidebar-collapsed')) {
        body.classList.add('sidebar-collapsed');
        localStorage.setItem('sidebar-collapsed', 'true');
        const icon = document.getElementById('sidebarToggleIcon');
        if (icon) icon.style.transform = 'rotate(180deg)';
      }
    }
  }, { passive: true });
}

// Auto alert check every minute
setInterval(() => {
  S.alerts.filter(a => a.active).forEach(a => {
    const cur = latestPrice(a.sym); if (!cur) return;
    const trig = (a.cond === 'above' && cur >= a.target) || (a.cond === 'below' && cur <= a.target);
    if (trig && !a._notified) { a._notified = true; toast(`Alert: ${a.sym} is ${a.cond} Rs ${a.target.toFixed(2)} (now ${fp(cur)})`); }
    if (!trig) a._notified = false;
  });
}, 60000);

(async () => {
  setLoad(20);
  if (typeof initLiquidBg === 'function') initLiquidBg();

  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    if (currentTheme === 'dark') {
      themeToggle.classList.add('on');
    } else {
      themeToggle.classList.remove('on');
    }
  }

  const isMobile = window.innerWidth <= 900;
  const sidebarCollapsed = isMobile || localStorage.getItem('sidebar-collapsed') === 'true';
  if (sidebarCollapsed) {
    const body = document.querySelector('.body');
    if (body) body.classList.add('sidebar-collapsed');
    const icon = document.getElementById('sidebarToggleIcon');
    if (icon) icon.style.transform = 'rotate(180deg)';
  }

  let hasCache = false;
  try {
    const cached = localStorage.getItem('marketai_cache');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.symbols && parsed.symbols.length > 0) {
        mergeData(parsed);
        hasCache = true;
        setLoad(40);
        if (S.lastSync) setSyncState('ok', `Cached · ${S.snapshots.length} snaps · ${fago(S.lastSync)}`);
        renderTicker();
        renderSidebar();
        handleRoute();
      }
    }
  } catch (e) {
    console.warn('Error loading cache:', e);
  }

  try {
    let d = null;
    try {
      const apiResp = await fetch(`${API}/api/data`);
      if (apiResp.ok) {
        const apiData = await apiResp.json();
        if (apiData && apiData.snapshots && apiData.snapshots.length > 0) {
          d = apiData;
        } else {
          console.warn('[MarketAI] /api/data returned empty snapshots — fetching from Google Sheets directly...');
          setSyncState('spin', 'Loading from Google Sheets...');
        }
      }
    } catch (apiErr) {
      console.warn('[MarketAI] /api/data failed:', apiErr.message);
    }

    if (!d) {
      try {
        d = await fetchFromGoogleSheetsRealtime();
      } catch (sheetsErr) {
        console.warn('[MarketAI] Google Sheets direct fetch failed:', sheetsErr.message);
      }
    }

    if (d && d.snapshots && d.snapshots.length > 0) {
      mergeData(d);
      setLoad(80);
      if (S.lastSync) setSyncState('ok', `Loaded · ${S.snapshots.length} snaps · ${fago(S.lastSync)}`);
      renderTicker();
      renderSidebar();

      if (!hasCache) {
        handleRoute();
      } else {
        renderAll();
      }
      setLoad(100);
      setTimeout(() => setLoad(0), 600);

      const stale = !S.lastSync || Date.now() - S.lastSync > 10 * 60 * 1000;
      if (stale) {
        setTimeout(() => doSync(S.snapshots.length > 0), 1200);
      }
    } else {
      throw new Error('No market data available from any source');
    }
  } catch (e) {
    console.error('Error fetching fresh data:', e);
    if (!hasCache) {
      const mockData = generateMockData();
      mergeData(mockData);
      setSyncState('ok', `Demo Mode · Offline Fallback`);
      renderTicker();
      renderSidebar();
      handleRoute();
      toast('Demo mode: tap Sync to load live data', 'ok');
    } else {
      setSyncState('ok', `Offline/Cached · ${fago(S.lastSync)}`);
      toast('Fresh data fetch failed — using cached data. ' + e.message, 'err');
    }
    setLoad(0);
  }
})();
