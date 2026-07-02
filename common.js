(function() {
  try {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
  } catch(e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();

// ── API base ─────────────────────────────────────────────────────────────
const API = '';
const GITHUB_RAW = 'https://raw.githubusercontent.com/isiraglobal/market-claude/main';
const SHEET_CONFIG = {
  id: '1o6L7bHDrUozEPaLFsXPtls7Jey88lQm0789fq5T2GqA',
  symbolsTab: 'SYMBOLS',
  nseTab: 'NSE',
};

// ── App State ────────────────────────────────────────────────────────────
const S = {
  snapshots:[], symbols:[], lastSync:null,
  portfolio:[], watchlists:[], watchlistItems:[], alerts:[], screeners:[],
  activePage:'dashboard', activeStock:null, sbTab:'all',
  workspaces:[
    {id:'ws1',name:'Morning Scan',active:true},
    {id:'ws2',name:'Intraday',active:false},
    {id:'ws3',name:'Swing',active:false},
  ],
  syncing:false, loaded:false,
};

// ── Cache ─────────────────────────────────────────────────────────────────
const Cache = {
  histories: {}, stats: {}, latestPrice: {}, prevPrice: {}, change: {},
  spark: {}, topGainers: [], topLosers: [], autoPicks: [], hammers: [], demandZones: [], summary: {}
};

function precomputeCache() {
  Cache.histories = {}; Cache.stats = {}; Cache.latestPrice = {}; Cache.prevPrice = {}; Cache.change = {};
  Cache.topGainers = []; Cache.topLosers = [];
  Cache.autoPicks = null; Cache.hammers = null; Cache.demandZones = null;
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
  const gainers = []; const losers = [];
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
    Cache.latestPrice[sym] = latest; Cache.prevPrice[sym] = prev;
    let chg = null;
    if (latest !== null && prev !== null && prev > 0) {
      const abs = latest - prev;
      const pct = abs / prev * 100;
      chg = isFinite(pct) ? { abs, pct } : null;
    }
    Cache.change[sym] = chg;
    let hi = -Infinity, lo = Infinity, sum = 0;
    for (let i = 0; i < len; i++) { const p = prices[i]; if (p > hi) hi = p; if (p < lo) lo = p; sum += p; }
    const avg = sum / len;
    const first = prices[0];
    let retSum = 0, retCount = 0;
    for (let i = 1; i < len; i++) { const ret = (prices[i] - prices[i - 1]) / prices[i - 1]; if (isFinite(ret)) { retSum += ret; retCount++; } }
    const mean = retCount ? retSum / retCount : 0;
    let varSum = 0;
    for (let i = 1; i < len; i++) { const ret = (prices[i] - prices[i - 1]) / prices[i - 1]; if (isFinite(ret)) { const d = ret - mean; varSum += d * d; } }
    const vol = Math.sqrt(retCount ? varSum / retCount : 0) * 100;
    const pctReturn = first > 0 ? (latest - first) / first * 100 : 0;
    Cache.stats[sym] = { hi, lo, avg, first, last: latest, count: len, pct: isFinite(pctReturn) ? pctReturn : 0, vol: isFinite(vol) ? vol : 0, prices, series: history };
    if (!chg) unc++;
    else if (chg.pct > 0.01) { adv++; gainers.push({ sym, c: chg, st: Cache.stats[sym] }); }
    else if (chg.pct < -0.01) { dec++; losers.push({ sym, c: chg, st: Cache.stats[sym] }); }
    else unc++;
  }
  gainers.sort((a, b) => b.c.pct - a.c.pct);
  losers.sort((a, b) => a.c.pct - b.c.pct);
  Cache.topGainers = gainers; Cache.topLosers = losers;
  Cache.summary = { total: symLen, advances: adv, declines: dec, unchanged: unc };
  Cache.autoPicks = null; Cache.hammers = null; Cache.demandZones = null;
}

function latestPrice(sym){ return Cache.latestPrice[sym] !== undefined ? Cache.latestPrice[sym] : null; }
function prevPrice(sym){ return Cache.prevPrice[sym] !== undefined ? Cache.prevPrice[sym] : null; }
function change(sym){ return Cache.change[sym] !== undefined ? Cache.change[sym] : null; }
function series(sym, period = 'all'){
  const history = Cache.histories[sym] || [];
  if (period === 'all') return history;
  if (history.length === 0) return [];
  const last = history[history.length - 1].ts;
  const cut = { d3: 3 * 864e5, w1: 7 * 864e5, m1: 30 * 864e5, m3: 90 * 864e5 }[period];
  if (cut) { const f = history.filter(s => s.ts >= last - cut); if (f.length >= 2) return f; }
  return history;
}
function stats(sym, period = 'all'){
  if (period === 'all') return Cache.stats[sym] !== undefined ? Cache.stats[sym] : null;
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
function topGainers(n = 10){ return Cache.topGainers.slice(0, n); }
function topLosers(n = 10){ return Cache.topLosers.slice(0, n); }
function summary(){ return Cache.summary; }
function autoPicks(n = 6){ if (Cache.autoPicks === null) computeAutoPicks(); return Cache.autoPicks.slice(0, n); }
function calcRSI(prices, n = 14){
  const len = prices.length; if (len < n + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = len - n; i < len; i++) { const d = prices[i] - prices[i - 1]; if (d > 0) gains += d; else losses += (-d); }
  gains /= n; losses /= n; if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}
function hammerSignals(){ if (Cache.hammers === null) computeHammers(); return Cache.hammers; }
function demandZones(){ if (Cache.demandZones === null) computeDemandZones(); return Cache.demandZones; }

function computeAutoPicks() {
  const picks = [];
  const symbols = S.symbols;
  for (let si = 0; si < symbols.length; si++) {
    const sym = symbols[si];
    const st = Cache.stats[sym];
    if (!st || st.count < 3 || st.prices.length < 2) continue;
    const c = Cache.change[sym];
    if (!c) continue;
    let score = 0, reasons = [];
    const avg = st.avg, last = st.last;
    if (last > avg) { score += 25; reasons.push('Above avg'); } else if (last < avg) { score -= 10; }
    const rsi = calcRSI(st.prices);
    if (rsi < 35) { score += 20; reasons.push('RSI oversold'); } else if (rsi < 50 && last > avg) { score += 10; reasons.push('RSI rising'); } else if (rsi > 70) { score -= 15; }
    if (st.pct > 5) { score += 20; reasons.push('+' + st.pct.toFixed(1) + '%'); } else if (st.pct > 2) { score += 10; } else if (st.pct < -5) { score -= 20; }
    if (st.vol >= 0 && st.vol < 2 && last > avg) { score += 10; reasons.push('Low vol'); }
    const fromLo = st.lo > 0 ? ((last - st.lo) / st.lo * 100) : 0;
    if (fromLo >= 0 && fromLo < 5) { score += 10; reasons.push('Near low'); } else if (fromLo > 80) { score -= 10; }
    if (score >= 35) picks.push({ sym, score: Math.min(100, Math.max(0, score)), reason: reasons.slice(0, 2).join(' · '), c });
  }
  Cache.autoPicks = picks.sort((a, b) => b.score - a.score);
}

function computeHammers() {
  const hammersList = [];
  const symbols = S.symbols;
  for (let si = 0; si < symbols.length; si++) {
    const sym = symbols[si];
    const history = Cache.histories[sym] || [];
    const len = history.length;
    if (len < 15) continue;
    const priceArr = new Float64Array(len);
    for (let i = 0; i < len; i++) priceArr[i] = history[i].price;
    const isDown = new Uint8Array(len - 1);
    for (let i = 0; i < len - 1; i++) isDown[i] = priceArr[i] > priceArr[i + 1] ? 1 : 0;
    let runningDownSum = 0;
    for (let i = 0; i < 14; i++) runningDownSum += isDown[i];
    for (let hammerIdx = 14; hammerIdx < len - 1; hammerIdx++) {
      if (runningDownSum >= 12) {
        const prevPrice = priceArr[hammerIdx - 1], hammerPrice = priceArr[hammerIdx], nextPrice = priceArr[hammerIdx + 1];
        const item = history[hammerIdx];
        let open, close, high, low;
        if (item.ohlc) {
          open = item.ohlc.o;
          close = item.ohlc.c;
          high = item.ohlc.h;
          low = item.ohlc.l;
        } else {
          open = prevPrice;
          close = hammerPrice;
          high = prevPrice > hammerPrice ? prevPrice : hammerPrice;
          low = prevPrice < hammerPrice ? prevPrice : hammerPrice;
        }
        const body = Math.abs(close - open) || (hammerPrice * 0.001);
        const upperShadow = high - (open > close ? open : close);
        const lowerShadow = (open < close ? open : close) - low;
        if (upperShadow < body && lowerShadow > body && lowerShadow > (body * 0.5)) {
          if (nextPrice > hammerPrice) {
            const shadowRatio = lowerShadow / (upperShadow || 1);
            const bodySmallness = Math.max(0, 1 - ((body / hammerPrice) * 100 / 2));
            const strength = Math.min(100, Math.round((shadowRatio * 40) + (bodySmallness * 60)));
            let score = 50;
            score += (strength * 0.3);
            if ((nextPrice - hammerPrice) / hammerPrice > 0.005) score += 15;
            if (lowerShadow / high > 0.2) score += 10;
            score = Math.min(100, Math.round(score));
            if (score >= 50) {
              hammersList.push({ sym, ts: history[hammerIdx].ts, label: history[hammerIdx].label, price: hammerPrice, entry: prevPrice, nextPrice, score, strength, reason: '15d downtrend, green confirmation' });
            }
          }
        }
      }
      runningDownSum = runningDownSum - isDown[hammerIdx - 14] + isDown[hammerIdx];
    }
  }
  Cache.hammers = hammersList.sort((a, b) => b.score - a.score);
}

function computeDemandZones() {
  const zones = []; const MAX_BASES = 4; const BASE_PCT = 0.5;
  const symbols = S.symbols;
  for (let si = 0; si < symbols.length; si++) {
    const sym = symbols[si];
    const history = Cache.histories[sym] || [];
    if (history.length < 5) continue;
    const candles = [];
    for (let i = 0; i < history.length; i++) {
      const cur = history[i], prev = i > 0 ? history[i - 1] : null;
      let o, c, h, l, hasOHLC = false;
      if (cur.ohlc) { o = cur.ohlc.o; c = cur.ohlc.c; h = cur.ohlc.h; l = cur.ohlc.l; hasOHLC = true; }
      else if (prev) { o = prev.price; c = cur.price; h = o > c ? o : c; l = o < c ? o : c; }
      else { candles.push(null); continue; }
      if (!isFinite(o) || !isFinite(c) || !isFinite(h) || !isFinite(l) || o <= 0 || c <= 0 || h <= 0 || l <= 0) { candles.push(null); continue; }
      const body = Math.abs(c - o), range = h - l || 0.001, bodyRatio = body / range, ret = (c - o) / o * 100, isGreen = c >= o;
      candles.push({ o, c, h, l, body, range, bodyRatio, ret, isGreen, hasOHLC, ts: cur.ts, label: cur.label });
    }
    const clen = candles.length; if (clen < 5) continue;
    let found = false;
    for (let i = clen - 3; i >= 0 && !found; i--) {
      const c1 = candles[i]; if (!c1) continue;
      const c1IsRally = c1.hasOHLC ? (c1.isGreen && c1.bodyRatio >= 0.5) : c1.isGreen;
      if (!c1IsRally) continue;
      let nb = 0;
      for (let j = i + 1; j < Math.min(i + 1 + MAX_BASES, clen); j++) {
        const b = candles[j]; if (!b) { nb = 0; break; }
        const isBase = b.hasOHLC ? (b.bodyRatio < 0.5) : (Math.abs(b.ret) <= BASE_PCT);
        if (isBase) nb++; else break;
      }
      if (nb === 0) continue;
      const r2Idx = i + 1 + nb; if (r2Idx >= clen) continue;
      const c2 = candles[r2Idx]; if (!c2) continue;
      const c2IsRally = c2.hasOHLC ? (c2.isGreen && c2.bodyRatio >= 0.5) : c2.isGreen;
      if (!c2IsRally) continue; if (c2.c <= c1.c) continue;
      found = true;
      let proximal = -Infinity, distal = Infinity;
      for (let k = i + 1; k < r2Idx; k++) { const bc = candles[k]; if (!bc) continue; const bodyTop = bc.o > bc.c ? bc.o : bc.c; if (bodyTop > proximal) proximal = bodyTop; if (bc.l < distal) distal = bc.l; }
      let tested = false;
      for (let k = r2Idx + 1; k < clen; k++) { const cc = candles[k]; if (cc && cc.l <= proximal) { tested = true; break; } }
      const ltp = Cache.latestPrice[sym];
      const notTested = ltp !== null && ltp > proximal * 1.02;
      zones.push({ sym, ts: c2.ts, label: c2.label, proximal: +proximal.toFixed(2), distal: +distal.toFixed(2), rally1Close: +c1.c.toFixed(2), rally2Close: +c2.c.toFixed(2), numBases: nb, tested, notTested, distPct: ltp !== null ? +((ltp - proximal) / proximal * 100).toFixed(2) : null });
    }
  }
  Cache.demandZones = zones.sort((a, b) => { if (a.notTested !== b.notTested) return a.notTested ? -1 : 1; return b.ts - a.ts; });
}

const fp = p => (p == null || isNaN(p)) ? '—' : 'Rs ' + ((+p).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fc = (c, short = false) => !c ? '—' : `${c.pct >= 0 ? '+' : ''}${short ? c.pct.toFixed(2) + '%' : c.abs.toFixed(2) + ' (' + c.pct.toFixed(2) + '%)'}`;
const fago = ts => { const d = Date.now() - ts; if (d < 60000) return 'just now'; if (d < 3600000) return Math.floor(d / 60000) + 'm ago'; if (d < 86400e3) return Math.floor(d / 3600000) + 'h ago'; return Math.floor(d / 86400e3) + 'd ago'; };
const fdt = ts => ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fds = ts => ts ? new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const cc = c => !c ? 'nu' : c.pct > 0 ? 'up' : 'dn';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

function spark(sym, w = 52, h = 22) {
  const st = Cache.stats[sym];
  if (!st || st.count < 2) return `<svg width="${w}" height="${h}"></svg>`;
  const pr = st.prices;
  const mn = st.lo, mx = st.hi, rng = mx - mn || 1;
  const pts = pr.map((p, i) => `${(i / (pr.length - 1)) * (w - 2) + 1},${h - ((p - mn) / rng) * (h - 4) - 2}`).join(' ');
  const c = Cache.change[sym];
  const col = c ? (c.pct >= 0 ? '#00f5b4' : '#ff4d6d') : 'rgba(255, 255, 255, 0.15)';
  return `<svg width="${w}" height="${h}" class="sparksvg"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
}

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
  ctx.strokeStyle = '#1e2030'; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (i / 4) * ch; const val = mx - (i / 4) * rng;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillStyle = '#606880'; ctx.font = '9px Inter, sans-serif'; ctx.textAlign = 'right';
    ctx.fillText((val >= 1000 ? val.toFixed(0) : val.toFixed(2)), pad.l - 4, y + 3);
  }
  ctx.setLineDash([]);
  ctx.fillStyle = '#606880'; ctx.font = '8px Inter, sans-serif'; ctx.textAlign = 'center';
  const step = Math.max(1, Math.ceil(sr.length / Math.floor(cw / 50)));
  for (let i = 0; i < sr.length; i += step) { if (sr[i]?.ts) ctx.fillText(new Date(sr[i].ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), xp(i), H - 6); }
  const isUp = pr[pr.length - 1] >= pr[0];
  const col = isUp ? '#00e5a0' : '#ff3366';
  const lineGrad = ctx.createLinearGradient(pad.l, 0, W - pad.r, 0);
  if (isUp) { lineGrad.addColorStop(0, '#00e5a0'); lineGrad.addColorStop(1, '#00cc80'); }
  else { lineGrad.addColorStop(0, '#ff3366'); lineGrad.addColorStop(1, '#cc0040'); }
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ch);
  grad.addColorStop(0, isUp ? 'rgba(0, 229, 160, 0.25)' : 'rgba(255, 51, 102, 0.25)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath(); ctx.moveTo(xp(0), yp(pr[0]));
  for (let i = 1; i < pr.length; i++) ctx.lineTo(xp(i), yp(pr[i]));
  ctx.lineTo(xp(pr.length - 1), pad.t + ch); ctx.lineTo(pad.l, pad.t + ch); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath(); ctx.moveTo(xp(0), yp(pr[0]));
  for (let i = 1; i < pr.length; i++) ctx.lineTo(xp(i), yp(pr[i]));
  ctx.strokeStyle = lineGrad; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
  ctx.shadowColor = col; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
  const lx = xp(pr.length - 1), ly = yp(pr[pr.length - 1]);
  ctx.beginPath(); ctx.arc(lx, ly, 5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
  ctx.beginPath(); ctx.arc(lx, ly, 2, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
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
    tipEl.innerHTML = `<div style="font-size:9px;color:var(--t3);margin-bottom:3px">${d.sr[best]?.label || fdt(d.sr[best]?.ts)}</div><div style="font-family:var(--display);font-size:14px;font-weight:700;color:${d.col}">${fp(p)}</div>${pct ? `<div style="font-size:10px;color:${+pct >= 0 ? 'var(--green)' : 'var(--red)'}">${+pct >= 0 ? '+' : ''}${pct}%</div>` : ''}`;
  };
  canvas.onmouseleave = () => { tipEl.style.display = 'none'; };
}
function distBar(el, prices) {
  if (!el || !prices || prices.length < 3) { if (el) el.innerHTML = '<span style="color:var(--t3);font-size:10px">Not enough data</span>'; return; }
  let mn = prices[0], mx = prices[0]; for (let i = 1; i < prices.length; i++) { if (prices[i] < mn) mn = prices[i]; if (prices[i] > mx) mx = prices[i]; }
  const rng = mx - mn || 1, B = 12, counts = new Array(B).fill(0);
  prices.forEach(p => { const b = Math.min(B - 1, Math.floor((p - mn) / rng * B)); counts[b]++; });
  const mc = Math.max(...counts) || 1;
  el.innerHTML = '<div style="display:flex;align-items:flex-end;gap:2px;height:50px">' + counts.map((c, i) => `<div style="flex:1;height:${Math.max(3, Math.round(c / mc * 46))}px;background:hsl(${160 + i * 4},65%,48%);border-radius:2px 2px 0 0" title="${c}"></div>`).join('') + '</div>';
}
function sbar(score) {
  const col = score >= 67 ? 'var(--green)' : score >= 34 ? 'var(--yellow)' : 'var(--red)';
  return `<div class="sbar"><div class="sbar-track"><div class="sbar-fill" style="width:${score}%;background:${col}"></div></div><span style="font-size:9px;color:${col};font-weight:700;width:22px">${score}</span></div>`;
}

function cleanStr(v) { if (!v) return ""; let s = String(v).trim(); if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim(); return s; }
function parseSheetTimestamp(raw) {
  const s = cleanStr(raw); if (!s || s === "SYMBOL") return null;
  if (/^\d{10,}$/.test(s)) { const ts = +s; if (ts >= 946684800000 && ts <= 4102444800000) return ts; return null; }
  const gviz = s.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/i);
  if (gviz) { const [, yr, mo, day, hh = 0, mm = 0, ss = 0] = gviz; const yr_num = +yr; if (yr_num < 2000 || yr_num > 2100) return null; const ts = new Date(yr_num, +mo, +day, +hh, +mm, +ss).getTime(); return isNaN(ts) ? null : ts; }
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (dmy) { const [, day, mon, yr, hh = "00", mm = "00", ss = "00"] = dmy; const yr_num = +yr; if (yr_num < 2000 || yr_num > 2100) return null; const ts = new Date(`${yr}-${mon.padStart(2, "0")}-${day.padStart(2, "0")}T${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:${ss.padStart(2, "0")}`).getTime(); return isNaN(ts) ? null : ts; }
  const d = new Date(s); const ts = d.getTime(); if (!isNaN(ts) && ts >= 946684800000 && ts <= 4102444800000) return ts; return null;
}
function parseSheetPrice(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return isFinite(raw) && raw > 0 ? raw : null;
  let s = cleanStr(raw); if (!s || ["#N/A", "N/A", "#VALUE!", "#REF!", "#ERROR!", "#NUM!", "Loading...", ""].includes(s)) return null;
  
  if (s.includes(',')) {
    const parts = s.split(',');
    if (parts.length === 4) {
      const c = parseFloat(parts[0]);
      const o = parseFloat(parts[1]);
      const h = parseFloat(parts[2]);
      const l = parseFloat(parts[3]);
      if (isFinite(c) && c > 0 && isFinite(o) && o > 0 && isFinite(h) && h > 0 && isFinite(l) && l > 0) {
        return { c, o, h, l };
      }
    }
  }

  let n = parseFloat(s); if (isNaN(n)) n = parseFloat(s.replace(/[^\d.-]/g, ""));
  return isFinite(n) && n > 0 ? n : null;
}

function dedupeSnapshotsByTs(snaps) {
  const tsBest = {};
  for (const s of snaps || []) { if (!s || typeof s.ts !== 'number' || !s.prices || typeof s.prices !== 'object') continue; if (!tsBest[s.ts] || String(s.id || '') > String(tsBest[s.ts].id || '')) tsBest[s.ts] = s; }
  return Object.values(tsBest).sort((a, b) => a.ts - b.ts);
}
function saveLocalCache() {
  const base = { symbols: S.symbols, lastSync: S.lastSync, portfolio: S.portfolio, watchlists: S.watchlists, watchlistItems: S.watchlistItems, alerts: S.alerts, screeners: S.screeners };
  for (const n of [500, 200, 80, 40, 25, 15, 5]) { try { localStorage.setItem('marketai_cache', JSON.stringify({ ...base, snapshots: S.snapshots.slice(-n) })); return; } catch (e) {} }
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
        const timer = setTimeout(() => { if (settled) return; settled = true; cleanup(); rej(new Error(`Timeout loading sheet "${sheetName}" after ${timeoutMs / 1000}s`)); }, timeoutMs);
        window[callbackName] = function(data) { if (settled) return; settled = true; clearTimeout(timer); cleanup(); if (!data || data.status === 'error') { const err = data?.errors?.[0]; rej(new Error(err?.detailed_message || err?.message || `Google Sheets query failed for "${sheetName}"`)); return; } res(data); };
        const script = document.createElement('script'); script.src = url; script.id = callbackName;
        script.onerror = function() { if (settled) return; settled = true; clearTimeout(timer); cleanup(); rej(new Error(`Network error loading sheet "${sheetName}"`)); };
        function cleanup() { try { const el = document.getElementById(callbackName); if (el) el.remove(); } catch (e) {} try { delete window[callbackName]; } catch (e) {} }
        document.body.appendChild(script);
      });
    }
    function gvizColTimestamp(col) {
      if (!col) return null;
      if (col.v instanceof Date) { const ts = col.v.getTime(); if (!isNaN(ts) && ts > 946684800000 && ts < 4102444800000) return ts; }
      if (col.v != null && typeof col.v === 'string') { const ts = parseSheetTimestamp(col.v); if (ts) return ts; }
      if (col.label) { const ts = parseSheetTimestamp(col.label); if (ts) return ts; }
      if (col.id) { const ts = parseSheetTimestamp(col.id); if (ts) return ts; }
      return null;
    }
    function gvizColLabel(col) {
      if (col.label && col.label.trim()) return col.label.trim();
      if (col.v instanceof Date) { try { return col.v.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return col.v.toISOString().slice(0, 16); } }
      if (col.id && col.id.trim()) return col.id.trim(); return '';
    }
    function gvizCellPrice(cell) {
      if (!cell) return null;
      if (typeof cell.v === 'number') return isFinite(cell.v) && cell.v > 0 ? cell.v : null;
      if (cell.v != null) { const parsed = parseSheetPrice(cell.v); if (parsed !== null) return parsed; }
      if (cell.f) return parseSheetPrice(cell.f); return null;
    }
    Promise.all([fetchJSONP(SHEET_CONFIG.symbolsTab).catch(err => { console.warn('[MarketAI] SYMBOLS sheet fetch failed:', err.message); return null; }), fetchJSONP(SHEET_CONFIG.nseTab)]).then(([symbolsData, nseData]) => {
      try {
        if (!nseData || !nseData.table) throw new Error("NSE sheet returned no table data from Google");
        const table = nseData.table; const cols = table.cols || []; const rows = table.rows || [];
        if (rows.length < 1) throw new Error("NSE sheet has no rows");
        if (cols.length < 2) throw new Error("NSE sheet has no timestamp columns");
        const firstColLabel = (cols[0]?.label || '').toUpperCase();
        const firstColType = (cols[0]?.type || '').toLowerCase();
        const firstColIsSymbol = firstColLabel.includes('SYMBOL') || firstColType === 'string' || (rows.length > 0 && rows[0].c?.[0]?.v && typeof rows[0].c[0].v === 'string' && isNaN(parseFloat(rows[0].c[0].v)));
        const startCol = firstColIsSymbol ? 1 : 0;
        const MAX_SNAPS = 2000;
        let meta = [];
        const seenTs = new Set();
        for (let c = startCol; c < cols.length; c++) { const col = cols[c]; const ts = gvizColTimestamp(col); if (!ts) continue; if (seenTs.has(ts)) continue; seenTs.add(ts); meta.push({ col: c, label: gvizColLabel(col) || col.label || '', ts }); }
        meta.sort((a, b) => a.ts - b.ts);
        if (meta.length > MAX_SNAPS) meta.splice(0, meta.length - MAX_SNAPS);
        let dataStartRow = 0;
        if (meta.length === 0 && rows.length > 0) {
          console.warn('[MarketAI] No timestamps in cols — trying row[0] as header fallback...');
          const headerRow = rows[0]?.c || [];
          const fbMeta = []; const fbSeenTs = new Set();
          for (let c = startCol; c < headerRow.length; c++) { const cell = headerRow[c]; const raw = cell?.f || cell?.v; if (!raw) continue; const ts = parseSheetTimestamp(String(raw)); if (!ts) continue; if (fbSeenTs.has(ts)) continue; fbSeenTs.add(ts); fbMeta.push({ col: c, label: String(cell?.f || cell?.v || ''), ts }); }
          fbMeta.sort((a, b) => a.ts - b.ts);
          if (fbMeta.length > MAX_SNAPS) fbMeta.splice(0, fbMeta.length - MAX_SNAPS);
          fbMeta.forEach(m => meta.push(m));
          if (meta.length > 0) dataStartRow = 1;
        }
        if (meta.length === 0) throw new Error("NSE sheet: no timestamp columns found — make sure the sheet has price columns with date headers (format: dd/MM/yyyy HH:mm)");
        const priceMap = {}; meta.forEach(m => { priceMap[m.ts + '_' + m.col] = {}; }); const symsSet = new Set();
        for (let r = dataStartRow; r < rows.length; r++) {
          const row = rows[r]; if (!row || !row.c || row.c.length === 0) continue;
          const symCell = row.c[0]; const rawSym = cleanStr(symCell?.v || symCell?.f || '').toUpperCase().replace(/\s+/g, '');
          if (!rawSym || rawSym === 'SYMBOL' || rawSym.startsWith('SYMBOL') || rawSym === '#N/A' || rawSym === '#ERROR!' || rawSym === '#VALUE!') continue;
          symsSet.add(rawSym);
          for (const m of meta) { const cell = row.c[m.col]; const p = gvizCellPrice(cell); if (p !== null) priceMap[m.ts + '_' + m.col][rawSym] = p; }
        }
        const validSnaps = meta.map(m => ({ id: `snap_${m.ts}_${m.col}`, ts: m.ts, label: m.label, prices: priceMap[m.ts + '_' + m.col] })).filter(s => Object.keys(s.prices).length > 0).sort((a, b) => a.ts - b.ts);
        if (validSnaps.length === 0) throw new Error("NSE sheet parsed successfully but no valid price data found");
        console.log(`[MarketAI] Direct sheet fetch: ${validSnaps.length} snapshots, ${symsSet.size} symbols`);
        resolve({ snapshots: dedupeSnapshotsByTs(validSnaps), symbols: [...symsSet].sort(), lastSync: Date.now(), syncCount: 1, portfolio: S.portfolio || [], watchlists: S.watchlists || [], watchlistItems: S.watchlistItems || [], alerts: S.alerts || [], screeners: S.screeners || [] });
      } catch (e) { console.error('[MarketAI] fetchFromGoogleSheetsRealtime error:', e.message); reject(e); }
    }).catch(err => { console.error('[MarketAI] JSONP fetch failed:', err.message); reject(err); });
  });
}

async function fetchFromGitHub() {
  try {
    const r = await fetch(`${GITHUB_RAW}/data.json`, { cache: 'no-cache' });
    if (r.ok) {
      const data = await r.json();
      if (data && data.snapshots && data.snapshots.length > 0) { console.log(`[GitHub] Loaded ${data.snapshots.length} snaps, ${data.symbols.length} syms`); data._source = 'github'; return data; }
      console.warn('GitHub data.json empty');
    }
  } catch (e) { console.warn('GitHub fetch failed:', e); }
  return null;
}

async function fetchData() {
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (!isLocal) {
    const ghData = await fetchFromGitHub(); if (ghData) return ghData;
  }
  try { const r = await fetch(`${API}/api/data`); if (r.ok) { const data = await r.json(); if (data && data.snapshots && data.snapshots.length > 0) return data; } }
  catch (err) { console.warn('API fetch failed', err); }
  if (isLocal) {
    try { const r = await fetch('/data.json', { cache: 'no-cache' }); if (r.ok) { const data = await r.json(); if (data && data.snapshots && data.snapshots.length > 0 && data.snapshots[0].prices) { console.log(`[Local] Loaded ${data.snapshots.length} snaps with prices`); return data; } } } catch (e) { console.warn('Local data.json fetch failed:', e); }
    const ghData = await fetchFromGitHub(); if (ghData) return ghData;
  }
  try { const cached = JSON.parse(localStorage.getItem('marketai_cache') || '{}'); if (cached.snapshots && cached.snapshots.length > 0) return cached; } catch (e) {}
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('fetchData: Google Sheets timeout')), 8000));
  return await Promise.race([fetchFromGoogleSheetsRealtime(), timeout]);
}
window.fetchStockHistory = async function(sym) {
  try {
    const r = await fetch(`${API}/api/stock-history?sym=${encodeURIComponent(sym)}`);
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data)) {
        Cache.histories[sym] = data;
        const pr = data.map(s => s.price);
        let hi = -Infinity, lo = Infinity, sum = 0;
        for (let i = 0; i < pr.length; i++) {
          const p = pr[i]; if (p > hi) hi = p; if (p < lo) lo = p; sum += p;
        }
        const avg = pr.length ? sum / pr.length : 0;
        const first = pr[0], last = pr[pr.length - 1];
        let retSum = 0, retCount = 0;
        for (let i = 1; i < pr.length; i++) {
          const ret = (pr[i] - pr[i - 1]) / pr[i - 1];
          if (isFinite(ret)) { retSum += ret; retCount++; }
        }
        const mean = retCount ? retSum / retCount : 0;
        let varSum = 0;
        for (let i = 1; i < pr.length; i++) {
          const ret = (pr[i] - pr[i - 1]) / pr[i - 1];
          if (isFinite(ret)) { const d = ret - mean; varSum += d * d; }
        }
        const vol = Math.sqrt(retCount ? varSum / retCount : 0) * 100;
        const pctReturn = first > 0 ? (last - first) / first * 100 : 0;
        Cache.stats[sym] = { hi, lo, avg, first, last, count: data.length, pct: isFinite(pctReturn) ? pctReturn : 0, vol: isFinite(vol) ? vol : 0, prices: pr, series: data };
        return true;
      }
    }
  } catch (e) { console.error('[MarketAI] fetchStockHistory error:', e); }
  return false;
};
async function saveUserData() {
  try { const cached = JSON.parse(localStorage.getItem('marketai_cache') || '{}'); cached.portfolio = S.portfolio; cached.watchlists = S.watchlists; cached.watchlistItems = S.watchlistItems; cached.alerts = S.alerts; cached.screeners = S.screeners; localStorage.setItem('marketai_cache', JSON.stringify(cached)); } catch (e) {}
  await fetch(`${API}/api/data`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ portfolio: S.portfolio, watchlists: S.watchlists, watchlistItems: S.watchlistItems, alerts: S.alerts, screeners: S.screeners }) });
}
async function doSync(silent = false) {
  if (S.syncing) return; S.syncing = true;
  const btn = document.getElementById('syncBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Syncing...'; }
  setSyncState('spin', 'Syncing...'); setLoad(30);
  try {
    let d;
    try { const r = await fetch(`${API}/api/sync`, { method: 'POST' }); const j = await r.json(); setLoad(70); if (!j.ok) throw new Error(j.error || 'Sync failed'); d = await fetchData(); }
    catch (apiErr) { console.warn('Server sync failed, falling back to direct browser sync from Google Sheets:', apiErr); setLoad(50); d = await fetchFromGoogleSheetsRealtime(); }
    mergeData(d); setLoad(100);
    setSyncState('ok', `Synced ${fago(S.lastSync)} · ${S.snapshots.length} snaps`);
    if (!silent) toast(`Synced ${S.snapshots.length} snapshots · ${S.symbols.length} symbols`, 'ok');
    renderAll();
  } catch (e) { setSyncState('err', 'Sync failed'); if (!silent) toast(e.message, 'err'); }
  finally { S.syncing = false; if (btn) { btn.disabled = false; btn.textContent = 'Sync'; } setTimeout(() => setLoad(0), 600); }
}
function mergeData(d) {
  if (d.snapshots) S.snapshots = dedupeSnapshotsByTs(d.snapshots); if (d.symbols) S.symbols = d.symbols; if (d.lastSync) S.lastSync = d.lastSync;
  if (d.portfolio) S.portfolio = d.portfolio; if (d.watchlists) S.watchlists = d.watchlists; if (d.watchlistItems) S.watchlistItems = d.watchlistItems;
  if (d.alerts) S.alerts = d.alerts; if (d.screeners) S.screeners = d.screeners;
  precomputeCache(); saveLocalCache();
}

async function askGroq(prompt, context = '') {
  const messages = [{ role: 'system', content: `You are MarketAI, a professional NSE stock market analyst. Be concise, data-driven, and use numbers. Context: ${context}` }, { role: 'user', content: prompt }];
  const r = await fetch(`${API}/api/groq`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages, max_tokens: 400 }) });
  const j = await r.json(); if (!j.ok) throw new Error(j.error || 'Groq unavailable'); return j.text;
}

function setLoad(pct) { const el = document.getElementById('loadbar'); if (el) el.style.width = pct + '%'; }
function setSyncState(type, lbl) { const d = document.getElementById('sdot'); const l = document.getElementById('slbl'); if (d) d.className = 'sync-dot' + (type ? ' ' + type : ''); if (l) l.textContent = lbl; }
let toastT;
function toast(msg, type = 'ok') {
  const wrap = document.getElementById('toasts'); if (!wrap) return;
  const el = document.createElement('div'); el.className = `toast ${type}`;
  el.innerHTML = `<span style="color:${type === 'ok' ? 'var(--green)' : 'var(--red)'}">&#x25CF;</span> ${msg}`;
  wrap.appendChild(el); requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 4000);
}
function showModal(title, body, footer = '') {
  document.getElementById('mbox').innerHTML = `<div class="modal-hdr"><div class="modal-title">${title}</div><button class="modal-close" onclick="closeModal()">&#x2715;</button></div><div>${body}</div>` + (footer ? `<div class="modal-footer">${footer}</div>` : '');
  document.getElementById('mbox').style.display = 'block'; document.getElementById('mbg').style.display = 'block';
}
function closeModal() { document.getElementById('mbox').style.display = 'none'; document.getElementById('mbg').style.display = 'none'; }

function renderTicker() {
  const el = document.getElementById('ticker'); const inner = document.getElementById('tickerInner');
  const validSyms = S.symbols.filter(s => { const st = stats(s); return st && st.count >= 1; });
  if (!validSyms.length) { el.style.display = 'none'; return; } el.style.display = 'block';
  const items = validSyms.slice(0, 60).map(sym => { const p = latestPrice(sym), c = change(sym), cls = cc(c); const arrow = c ? (c.pct >= 0 ? '+' : '-') : ''; return `<div class="ti"><span class="ti-sym">${sym}</span><span class="${cls}">${fp(p)}</span><span class="${cls}" style="font-size:9px">${c ? arrow + Math.abs(c.pct).toFixed(2) + '%' : ''}</span></div>`; }).join('');
  inner.innerHTML = items + items;
}

let sbTab = 'all';
function setSbTab(t, el) { sbTab = t; document.querySelectorAll('.sb-tab').forEach(e => e.classList.remove('active')); if (el) el.classList.add('active'); renderSidebar(); }
function renderSidebar(scrollTop) {
  const q = (document.getElementById('sbSearch')?.value || '').toUpperCase();
  let syms = [...S.symbols].filter(s => { const st = stats(s); return st && st.count >= 1; });
  if (q) syms = syms.filter(s => s.includes(q));
  if (sbTab === 'gain') syms = syms.filter(s => { const c = change(s); return c && c.pct > 0.01; });
  if (sbTab === 'loss') syms = syms.filter(s => { const c = change(s); return c && c.pct < -0.01; });
  if (sbTab === 'gain') syms.sort((a, b) => (change(b)?.pct || 0) - (change(a)?.pct || 0));
  if (sbTab === 'loss') syms.sort((a, b) => (change(a)?.pct || 0) - (change(b)?.pct || 0));
  const cnt = document.getElementById('symCount'); if (cnt) cnt.textContent = S.symbols.length;
  const el = document.getElementById('sbList'); if (!el) return;
  if (!el._sbV) { el._sbV = true; el.addEventListener('scroll', () => { clearTimeout(_sbScrollTimer); _sbScrollTimer = setTimeout(() => renderSidebar(el.scrollTop), 50); }); }
  if (!syms.length) { el.innerHTML = `<div style="padding:20px;color:var(--t3);font-size:11px;text-align:center">${S.symbols.length ? 'No matches' : 'Sync data first'}</div>`; return; }
  const ITEM_H = 44, OVERSCAN = 5, total = syms.length, viewH = el.clientHeight || 600;
  const st = scrollTop !== undefined ? scrollTop : el.scrollTop;
  const startIdx = Math.max(0, Math.floor(st / ITEM_H) - OVERSCAN);
  const endIdx = Math.min(total, Math.ceil((st + viewH) / ITEM_H) + OVERSCAN);
  const padTop = startIdx * ITEM_H, padBottom = (total - endIdx) * ITEM_H;
  let html = ''; if (padTop > 0) html += `<div style="height:${padTop}px"></div>`;
  for (let i = startIdx; i < endIdx; i++) { const sym = syms[i]; const p = latestPrice(sym), c = change(sym), cls = cc(c); html += `<div class="si${S.activeStock === sym ? ' active' : ''}" onclick="openStock('${sym}')">${spark(sym, 44, 18)}<div class="si-info"><div class="si-sym">${sym}</div><div class="si-chg ${cls}">${c ? fc(c, true) : '—'}</div></div><div class="si-price ${cls}">${fp(p)}</div></div>`; }
  if (padBottom > 0) html += `<div style="height:${padBottom}px"></div>`;
  el.innerHTML = html; if (scrollTop === undefined) el.scrollTop = st;
}
let _sbScrollTimer;

function openStock(sym) { S.activeStock = sym; nav('stock-detail', { sym }); }

const Pages = {};
function nav(pg, params = {}) {
  S.activePage = pg; S.routeParams = params;
  document.querySelectorAll('.navlink').forEach(el => el.classList.toggle('active', el.dataset.pg === pg));
  if (typeof updateNavIndicator === 'function') updateNavIndicator(pg);
  const activeTab = ['dashboard', 'stocks', 'screener', 'portfolio'].includes(pg) ? pg : 'more';
  document.querySelectorAll('.m-nav-item').forEach(el => el.classList.toggle('active', el.dataset.pg === activeTab));
  const bodyEl = document.querySelector('.body'); if (bodyEl) bodyEl.classList.toggle('show-sidebar-on-mobile', pg === 'stocks');
  const area = document.getElementById('pageArea'); if (!area) return;
  area.style.display = 'flex'; area.style.flexDirection = 'column'; area.style.height = '100%'; area.style.overflow = 'hidden';
  area.innerHTML = ''; area.style.animation = 'none'; void area.offsetWidth; area.style.animation = 'fadeUp .2s ease';
  loadPageScript(pg, area, params);
}
function renderAll() { renderTicker(); renderSidebar(); nav(S.activePage, S.routeParams || {}); }

function loadPageScript(pg, area, params) {
  if (Pages[pg]) { Pages[pg](area, params); renderSidebar(); return; }
  const script = document.createElement('script'); script.src = '/page-' + pg + '.js';
  script.onload = () => { if (Pages[pg]) Pages[pg](area, params); renderSidebar(); };
  script.onerror = () => { area.innerHTML = `<div class="empty"><div class="empty-title">Page not found: ${pg}</div></div>`; };
  document.head.appendChild(script);
}

function glCard(title, list) {
  if (!list.length) return `<div class="card"><div class="card-hdr"><div class="card-title">${title}</div></div><div class="empty"><div class="empty-sub">No data — sync first</div></div></div>`;
  return `<div class="card"><div class="card-hdr"><div class="card-title">${title}</div><span style="font-size:10px;color:var(--t3)">${list.length} stocks</span></div>${list.map(sym => { const c = change(sym); const cls = cc(c); return `<div class="gl-row" onclick="openStock('${sym}')">${spark(sym, 44, 18)}<div style="flex:1;min-width:0"><div style="font-family:var(--display);font-size:11px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sym}</div></div><div style="text-align:right;flex-shrink:0"><div class="${cls}" style="font-family:var(--display);font-size:11px;font-weight:700">${fp(latestPrice(sym))}</div><div class="${cls}" style="font-size:9px">${c ? fc(c, true) : ''}</div></div></div>`; }).join('')}</div>`;
}

function getAllPatterns() {
  const out = [];
  for (const sym of S.symbols) {
    const sr = series(sym);
    if (sr.length < 3) continue;
    for (let i = 2; i < sr.length; i++) {
      const prev2 = sr[i - 2], prev1 = sr[i - 1], item = sr[i];
      const nextItem = i < sr.length - 1 ? sr[i + 1] : null;
      let o, c, h, l;
      if (item.ohlc) { o = item.ohlc.o; c = item.ohlc.c; h = item.ohlc.h; l = item.ohlc.l; }
      else { o = prev1.price; c = item.price; h = o > c ? o : c; l = o < c ? o : c; }
      if (!isFinite(o) || !isFinite(c) || !isFinite(h) || !isFinite(l) || o <= 0 || c <= 0 || h <= 0 || l <= 0) continue;
      const body = Math.abs(c - o);
      const range = h - l || 0.001;
      const upperShadow = h - (o > c ? o : c);
      const lowerShadow = (o < c ? o : c) - l;
      
      // Hammer check
      const isHammer = upperShadow < body && lowerShadow > body && lowerShadow > (body * 0.5);
      if (isHammer) {
        const shadowRatio = lowerShadow / (upperShadow || 1);
        const bodySmallness = Math.max(0, 1 - ((body / c) * 100 / 2));
        const strength = Math.min(100, Math.round((shadowRatio * 40) + (bodySmallness * 60)));
        let score = 50 + (strength * 0.3);
        if (nextItem && (nextItem.price - c) / c > 0.005) score += 15;
        if (lowerShadow / h > 0.2) score += 10;
        score = Math.min(100, Math.round(score));
        if (score >= 40) {
          out.push({ sym, type: 'hammer', ts: item.ts, label: item.label, score, volSpike: score >= 60 });
        }
      }
      
      // Doji check
      const isDoji = (body / range < 0.1) && range > 0;
      if (isDoji && !isHammer) {
        out.push({ sym, type: 'doji', ts: item.ts, label: item.label, score: 50, volSpike: false });
      }
      
      // Engulfing check
      let p2_o, p2_c;
      if (prev1.ohlc) { p2_o = prev1.ohlc.o; p2_c = prev1.ohlc.c; }
      else { p2_o = prev2.price; p2_c = prev1.price; }
      const p2_body = Math.abs(p2_c - p2_o);
      const isEngulfing = body > p2_body * 1.4 && (c - o) * (p2_c - p2_o) < 0;
      if (isEngulfing) {
        const absSize = body / (p2_body || 1);
        const score = Math.min(100, Math.round(Math.abs(absSize) * 65));
        if (score >= 50) {
          out.push({ sym, type: 'engulfing', ts: item.ts, label: item.label, score, volSpike: score >= 70 });
        }
      }
    }
    
    // Morning Star
    for (let i = 3; i < sr.length; i++) {
      const prev3 = sr[i - 3], prev2 = sr[i - 2], prev1 = sr[i - 1], item = sr[i];
      let o1, c1, o2, c2, o3, c3;
      if (prev2.ohlc) { o1 = prev2.ohlc.o; c1 = prev2.ohlc.c; } else { o1 = prev3.price; c1 = prev2.price; }
      if (prev1.ohlc) { o2 = prev1.ohlc.o; c2 = prev1.ohlc.c; } else { o2 = prev2.price; c2 = prev1.price; }
      if (item.ohlc) { o3 = item.ohlc.o; c3 = item.ohlc.c; } else { o3 = prev1.price; c3 = item.price; }
      const isDown1 = c1 < o1;
      const isStar2 = Math.abs(c2 - o2) / ((o2 + c2) / 2 || 1) < 0.01;
      const isUp3 = c3 > o3 && c3 > (o1 + c1) / 2;
      if (isDown1 && isStar2 && isUp3) {
        out.push({ sym, type: 'morning_star', ts: item.ts, label: item.label, score: 75, volSpike: true });
      }
    }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, 100);
}

function updateNavIndicator(pg) {
  const activeBtn = document.querySelector('.nav-sidebar .nav-icon-btn[data-pg="' + pg + '"]');
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
    indicator.style.height = (46 + stretch) + 'px';
    if (targetTop > prevTop) { indicator.style.transform = 'translateY(' + (targetTop - stretch) + 'px)'; }
    else { indicator.style.transform = 'translateY(' + targetTop + 'px)'; }
    setTimeout(() => { indicator.style.height = '46px'; indicator.style.transform = 'translateY(' + targetTop + 'px)'; }, 220);
  } else {
    indicator.style.transform = 'translateY(' + targetTop + 'px)'; indicator.style.height = '46px';
  }
  indicator.dataset.top = targetTop;
}

window.toggleSidebar = function() {
  const body = document.querySelector('.body'); const icon = document.getElementById('sidebarToggleIcon');
  if (body) { const isCollapsed = body.classList.toggle('sidebar-collapsed'); try { localStorage.setItem('sidebar-collapsed', isCollapsed ? 'true' : 'false'); } catch (e) {} if (icon) icon.style.transform = isCollapsed ? 'rotate(180deg)' : 'rotate(0deg)'; }
};

let logoClicks = 0; let logoTimer;
window.handleLogoClick = function() {
  logoClicks++; clearTimeout(logoTimer); logoTimer = setTimeout(() => { logoClicks = 0; }, 1500);
  if (logoClicks < 5) nav('dashboard'); else { logoClicks = 0; nav('settings'); toast('Admin Panel Unlocked', 'ok'); }
};

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', newTheme);
  try { localStorage.setItem('theme', newTheme); } catch (e) {}
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) { if (newTheme === 'dark') themeToggle.classList.add('on'); else themeToggle.classList.remove('on'); }
}

function initLiquidBg() {
  const canvas = document.getElementById('liquid-bg'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let width = canvas.width = window.innerWidth / 4; let height = canvas.height = window.innerHeight / 4;
  window.addEventListener('resize', () => { width = canvas.width = window.innerWidth / 4; height = canvas.height = window.innerHeight / 4; if (S.activePage) updateNavIndicator(S.activePage); });
  const blobs = [
    { x: width * 0.2, y: height * 0.3, r: 120, vx: 0.08, vy: 0.11, getCol: () => document.documentElement.getAttribute('data-theme') === 'light' ? 'rgba(255, 255, 255, 0.45)' : 'rgba(10, 15, 30, 0.5)' },
    { x: width * 0.8, y: height * 0.7, r: 155, vx: -0.06, vy: -0.09, getCol: () => document.documentElement.getAttribute('data-theme') === 'light' ? 'rgba(255, 180, 200, 0.35)' : 'rgba(0, 150, 255, 0.15)' },
    { x: width * 0.5, y: height * 0.1, r: 105, vx: 0.1, vy: -0.07, getCol: () => document.documentElement.getAttribute('data-theme') === 'light' ? 'rgba(240, 210, 255, 0.4)' : 'rgba(142, 36, 170, 0.15)' },
    { x: width * 0.3, y: height * 0.9, r: 135, vx: -0.05, vy: 0.12, getCol: () => document.documentElement.getAttribute('data-theme') === 'light' ? 'rgba(255, 220, 230, 0.45)' : 'rgba(0, 220, 255, 0.12)' }
  ];
  const rain = []; for (let i = 0; i < 35; i++) rain.push({ x: Math.random() * width, y: Math.random() * height, len: Math.random() * 12 + 6, speed: Math.random() * 2 + 3, opacity: Math.random() * 0.15 + 0.05 });
  let mouse = { x: -1000, y: -1000 }; window.addEventListener('mousemove', (e) => { mouse.x = e.clientX / 4; mouse.y = e.clientY / 4; });
  let ripples = []; window.addEventListener('click', (e) => { const isLight = document.documentElement.getAttribute('data-theme') === 'light'; ripples.push({ x: e.clientX / 4, y: e.clientY / 4, r: 4, maxR: 80, opacity: 0.9, col: isLight ? (Math.random() > 0.5 ? 'rgba(217, 0, 108, 0.25)' : 'rgba(142, 36, 170, 0.25)') : (Math.random() > 0.5 ? 'rgba(0, 210, 255, 0.25)' : 'rgba(191, 85, 236, 0.25)') }); });
  function animate() {
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = document.documentElement.getAttribute('data-theme') === 'light' ? 'rgba(217, 0, 108, 0.08)' : 'rgba(0, 210, 255, 0.1)';
    ctx.lineWidth = 0.6; ctx.globalCompositeOperation = 'source-over';
    rain.forEach(r => { ctx.beginPath(); ctx.moveTo(r.x, r.y); ctx.lineTo(r.x + 0.4, r.y + r.len); ctx.stroke(); r.y += r.speed; r.x += 0.2; if (r.y > height) { r.y = -r.len; r.x = Math.random() * width; } });
    ripples.forEach((rip, rIdx) => { rip.r += 2.2; rip.opacity -= 0.025; if (rip.opacity <= 0 || rip.r >= rip.maxR) { ripples.splice(rIdx, 1); return; } blobs.forEach(b => { const dx = b.x - rip.x, dy = b.y - rip.y, dist = Math.hypot(dx, dy); if (dist < rip.r + 50 && dist > 0) { const force = (rip.r + 50 - dist) * 0.1; b.x += (dx / dist) * force; b.y += (dy / dist) * force; } }); const grad = ctx.createRadialGradient(rip.x, rip.y, 0, rip.x, rip.y, rip.r); grad.addColorStop(0, rip.col); grad.addColorStop(0.3, rip.col); grad.addColorStop(1, 'rgba(0,0,0,0)'); ctx.beginPath(); ctx.arc(rip.x, rip.y, rip.r, 0, Math.PI * 2); ctx.fillStyle = grad; ctx.globalAlpha = rip.opacity; ctx.globalCompositeOperation = 'source-over'; ctx.fill(); ctx.globalAlpha = 1; });
    blobs.forEach(b => { b.x += b.vx; b.y += b.vy; if (b.x - b.r < -100 || b.x + b.r > width + 100) b.vx *= -1; if (b.y - b.r < -100 || b.y + b.r > height + 100) b.vy *= -1; const dx = b.x - mouse.x, dy = b.y - mouse.y, dist = Math.hypot(dx, dy); if (dist < 130) { const force = (130 - dist) * 0.02; b.x += (dx / dist) * force; b.y += (dy / dist) * force; } const col = b.getCol(); const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r); grad.addColorStop(0, col); grad.addColorStop(0.15, col); grad.addColorStop(1, 'rgba(0,0,0,0)'); ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fillStyle = grad; ctx.globalCompositeOperation = 'source-over'; ctx.fill(); });
    ctx.globalCompositeOperation = 'source-over'; requestAnimationFrame(animate);
  }
  animate();
}

window.refreshAIBriefing = async function() {
  const el = document.getElementById('aiBriefing'); if (!el) return;
  const sum = summary(); const gainers = topGainers(3); const losers = topLosers(3);
  el.innerHTML = '<div class="ai-spinner"><div class="spin-ring"></div>Analyzing market data...</div>';
  try {
    const ctx = 'NSE market: ' + sum.total + ' stocks, ' + sum.advances + ' advancing, ' + sum.declines + ' declining. Top gainers: ' + gainers.map(g => g.sym + ' ' + fc(g.c, true)).join(', ') + '. Top losers: ' + losers.map(l => l.sym + ' ' + fc(l.c, true)).join(', ') + '. Snapshots: ' + S.snapshots.length + '.';
    const text = await askGroq('Give a 3-sentence professional market briefing with key insights and what traders should watch today.', ctx);
    el.innerHTML = text || 'No AI analysis available.';
  } catch (e) { el.innerHTML = 'AI briefing unavailable. Set GROQ_API_KEY in Vercel environment variables.'; }
};
window.setWS = function(id, el) {
  S.workspaces.forEach(w => w.active = w.id === id);
  document.querySelectorAll('.ws-tab').forEach(e => e.classList.remove('active'));
  if (el) el.classList.add('active');
};
window.addWSModal = function() {
  showModal('New Workspace', '<div class="form-grp"><label class="form-lbl">Name</label><input class="form-inp" id="wsName" placeholder="e.g. Pre-Market Scan"></div>', '<button class="btn btn-ghost btn-sm" onclick="closeModal()">Cancel</button><button class="btn btn-primary btn-sm" onclick="doAddWS()">Create</button>');
};
window.doAddWS = function() {
  const n = document.getElementById('wsName')?.value?.trim(); if (!n) return;
  S.workspaces.push({ id: 'ws' + uid(), name: n, active: false });
  closeModal(); nav('dashboard');
};
window.addToPortfolio = function(sym) {
  const p = latestPrice(sym) || 0;
  showModal('Add to Portfolio', '<div class="form-grp"><label class="form-lbl">Symbol</label><input class="form-inp" id="pfSym" value="' + sym + '" ' + (sym ? 'readonly' : '') + ' placeholder="e.g. RELIANCE"></div><div class="form-row"><div class="form-grp"><label class="form-lbl">Qty</label><input class="form-inp" id="pfQty" type="number" min="1" value="1" oninput="pfCalc()"></div><div class="form-grp"><label class="form-lbl">Avg Buy (Rs)</label><input class="form-inp" id="pfPrice" type="number" step="0.01" value="' + p.toFixed(2) + '" oninput="pfCalc()"></div></div><div class="form-grp"><label class="form-lbl">Date</label><input class="form-inp" id="pfDate" type="date" value="' + new Date().toISOString().slice(0, 10) + '"></div><div style="background:var(--s3);border:1px solid var(--b1);border-radius:var(--r6);padding:10px 12px;font-size:11px;display:flex;justify-content:space-between"><span style="color:var(--t3)">Total Invested</span><span id="pfTotal" style="font-weight:700">' + fp(p) + '</span></div>', '<button class="btn btn-ghost btn-sm" onclick="closeModal()">Cancel</button><button class="btn btn-primary btn-sm" onclick="doAddPos()">Add</button>');
};
window.addPosMdl = () => window.addToPortfolio('');
window.pfCalc = () => { const q = +document.getElementById('pfQty')?.value || 0; const p = +document.getElementById('pfPrice')?.value || 0; const el = document.getElementById('pfTotal'); if (el) el.textContent = fp(q * p); };
window.doAddPos = async () => {
  const sym = (document.getElementById('pfSym')?.value || '').trim().toUpperCase();
  const qty = +document.getElementById('pfQty')?.value; const price = +document.getElementById('pfPrice')?.value;
  const date = document.getElementById('pfDate')?.value;
  if (!sym || !qty || !price) return toast('Fill all required fields', 'err');
  S.portfolio.push({ id: 'pf' + uid(), sym, qty, avgBuy: price, date, createdAt: new Date().toISOString() });
  await saveUserData(); closeModal(); toast(sym + ' added to portfolio');
  if (S.activePage === 'portfolio') nav('portfolio');
};
window.createWLModal = () => showModal('New Watchlist', '<div class="form-grp"><label class="form-lbl">Name</label><input class="form-inp" id="wlName" placeholder="e.g. Blue Chips"></div><div class="form-grp"><label class="form-lbl">Description</label><input class="form-inp" id="wlDesc" placeholder="Optional"></div>', '<button class="btn btn-ghost btn-sm" onclick="closeModal()">Cancel</button><button class="btn btn-primary btn-sm" onclick="doCreateWL()">Create</button>');
window.doCreateWL = async () => {
  const n = document.getElementById('wlName')?.value?.trim(); if (!n) return toast('Enter a name', 'err');
  const wl = { id: 'wl' + uid(), name: n, desc: document.getElementById('wlDesc')?.value || '', createdAt: new Date().toISOString() };
  S.watchlists.push(wl); await saveUserData(); closeModal(); toast('Watchlist created'); nav('watchlists', { wlId: wl.id });
};
window.addToWatchlist = sym => showModal('Add to Watchlist', '<div class="form-grp"><label class="form-lbl">Symbol</label><input class="form-inp" id="wliSym" value="' + (sym || '') + '" placeholder="e.g. RELIANCE" list="wliSymList"><datalist id="wliSymList">' + S.symbols.slice(0, 200).map(s => '<option value="' + s + '">').join('') + '</datalist></div><div class="form-grp"><label class="form-lbl">Watchlist</label><select class="form-inp" id="wliWL">' + (S.watchlists.map(w => '<option value="' + w.id + '">' + w.name + '</option>').join('') || '<option disabled>No watchlists — create one first</option>') + '</select></div>', '<button class="btn btn-ghost btn-sm" onclick="closeModal()">Cancel</button><button class="btn btn-primary btn-sm" onclick="doAddWLItem()">Add</button>');
window.addToWLMdl = wlId => { window.addToWatchlist(''); setTimeout(() => { const el = document.getElementById('wliWL'); if (el) el.value = wlId; }, 0); };
window.doAddWLItem = async () => {
  const sym = (document.getElementById('wliSym')?.value || '').trim().toUpperCase();
  const wlId = document.getElementById('wliWL')?.value;
  if (!sym) return toast('Enter a symbol', 'err'); if (!wlId) return toast('Select a watchlist', 'err');
  S.watchlistItems.push({ id: 'wli' + uid(), wlId, sym, addedAt: new Date().toISOString() });
  await saveUserData(); closeModal(); toast(sym + ' added');
};
window.createAlertMdl = () => showModal('Create Alert', '<div class="form-grp"><label class="form-lbl">Symbol</label><input class="form-inp" id="alSym" placeholder="e.g. RELIANCE" list="alSymList"><datalist id="alSymList">' + S.symbols.slice(0, 200).map(s => '<option value="' + s + '">').join('') + '</datalist></div><div class="form-row"><div class="form-grp"><label class="form-lbl">Condition</label><select class="form-inp" id="alCond"><option value="above">Price goes above</option><option value="below">Price goes below</option></select></div><div class="form-grp"><label class="form-lbl">Target Price (Rs)</label><input class="form-inp" id="alTarget" type="number" step="0.01" placeholder="0.00"></div></div>', '<button class="btn btn-ghost btn-sm" onclick="closeModal()">Cancel</button><button class="btn btn-primary btn-sm" onclick="doCreateAlert()">Create</button>');
window.doCreateAlert = async () => {
  const sym = (document.getElementById('alSym')?.value || '').trim().toUpperCase();
  const target = parseFloat(document.getElementById('alTarget')?.value);
  if (!sym) return toast('Enter a symbol', 'err'); if (isNaN(target) || target <= 0) return toast('Enter valid price', 'err');
  S.alerts.push({ id: 'al' + uid(), sym, cond: document.getElementById('alCond')?.value || 'above', target, active: true, createdAt: new Date().toISOString() });
  await saveUserData(); closeModal(); toast('Alert set for ' + sym); if (S.activePage === 'alerts') nav('alerts');
};
// Auto alert check every minute (moved from page-alerts.js)
setInterval(() => {
  S.alerts.filter(a => a.active).forEach(a => {
    const cur = latestPrice(a.sym); if (!cur) return;
    const trig = (a.cond === 'above' && cur >= a.target) || (a.cond === 'below' && cur <= a.target);
    if (trig && !a._notified) { a._notified = true; toast('Alert: ' + a.sym + ' is ' + a.cond + ' Rs ' + a.target.toFixed(2) + ' (now ' + fp(cur) + ')'); }
    if (!trig) a._notified = false;
  });
}, 60000);

function generateMockData() {
  const syms = ['RELIANCE', 'TCS', 'INFOSYS', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'BHARTIARTL', 'ITC', 'LT', 'HINDUNILVR', 'KOTAKBANK', 'WIPRO'];
  const basePrices = { RELIANCE: 2450.50, TCS: 3350.20, INFOSYS: 1420.80, HDFCBANK: 1610.15, ICICIBANK: 920.40, SBIN: 580.60, BHARTIARTL: 840.10, ITC: 430.75, LT: 2850.00, HINDUNILVR: 2520.30, KOTAKBANK: 1840.90, WIPRO: 395.25 };
  const snapshots = []; const startTs = Date.now() - 20 * 24 * 3600 * 1000;
  for (let i = 0; i < 20; i++) { const ts = startTs + i * 24 * 3600 * 1000; const date = new Date(ts); const label = date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); const prices = {}; syms.forEach(sym => { let changePercent = (Math.sin(i * 0.6 + sym.charCodeAt(0)) * 1.6) + (Math.cos(i * 0.9) * 0.9); if (sym === 'SBIN' && i > 12) changePercent += 1.8; if (sym === 'RELIANCE') changePercent += 0.6; if (sym === 'TCS' && i === 18) changePercent -= 3.5; if (sym === 'TCS' && i === 19) changePercent += 4.5; const price = basePrices[sym] * (1 + (changePercent * i * 0.006)); prices[sym] = parseFloat(price.toFixed(2)); }); snapshots.push({ ts, label, prices }); }
  const portfolio = [{ id: 'pf-mock1', sym: 'RELIANCE', qty: 50, avgBuy: 2400.00, date: new Date(startTs).toISOString().slice(0, 10) }, { id: 'pf-mock2', sym: 'INFOSYS', qty: 120, avgBuy: 1450.00, date: new Date(startTs + 2 * 24 * 3600 * 1000).toISOString().slice(0, 10) }];
  const watchlists = [{ id: 'wl-mock1', name: 'Nifty Heavyweights', desc: 'Core market leaders', createdAt: new Date().toISOString() }];
  const watchlistItems = [{ id: 'wli-mock1', wlId: 'wl-mock1', sym: 'RELIANCE', addedAt: new Date().toISOString() }, { id: 'wli-mock2', wlId: 'wl-mock1', sym: 'TCS', addedAt: new Date().toISOString() }, { id: 'wli-mock3', wlId: 'wl-mock1', sym: 'HDFCBANK', addedAt: new Date().toISOString() }];
  const alerts = [{ id: 'al-mock1', sym: 'RELIANCE', cond: 'above', target: 2600.00, active: true, createdAt: new Date().toISOString() }];
  return { snapshots, symbols: syms, lastSync: Date.now(), portfolio, watchlists, watchlistItems, alerts, screeners: [] };
}

(function() {
  // Bind navigation button click listeners
  document.querySelectorAll('.navlink[data-pg]').forEach(el => {
    el.addEventListener('click', () => nav(el.dataset.pg));
  });
  document.querySelectorAll('.m-nav-item[data-pg]').forEach(el => {
    el.addEventListener('click', () => nav(el.dataset.pg));
  });

  setLoad(20);
  try { if (typeof initLiquidBg === 'function') initLiquidBg(); } catch (e) { console.warn('Liquid bg init failed:', e); }
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) { if (currentTheme === 'dark') themeToggle.classList.add('on'); else themeToggle.classList.remove('on'); }
  try { const sidebarCollapsed = localStorage.getItem('sidebar-collapsed') !== 'false'; if (sidebarCollapsed) { const body = document.querySelector('.body'); if (body) body.classList.add('sidebar-collapsed'); const icon = document.getElementById('sidebarToggleIcon'); if (icon) icon.style.transform = 'rotate(180deg)'; } } catch (e) { console.warn('localStorage unavailable:', e); }
  (async function boot() {
    let hasCache = false;
    try { const cached = localStorage.getItem('marketai_cache'); if (cached) { const parsed = JSON.parse(cached); if (parsed.symbols && parsed.symbols.length > 0) { mergeData(parsed); hasCache = true; setLoad(40); if (S.lastSync) setSyncState('ok', `Cached · ${S.snapshots.length} snaps · ${fago(S.lastSync)}`); renderTicker(); renderSidebar(); nav('dashboard'); } } } catch (e) { console.warn('Error loading cache:', e); }
    try {
      const d = await fetchData();
      if (d) {
        mergeData(d);
        // If data came from GitHub (historical), supplement with live sheets for today
        if (d._source === 'github') {
          try {
            const liveData = await fetchFromGoogleSheetsRealtime();
            if (liveData && liveData.snapshots && liveData.snapshots.length > 0) {
              const tsMap = {};
              for (const s of S.snapshots) tsMap[s.ts] = s;
              for (const s of liveData.snapshots) tsMap[s.ts] = s;
              S.snapshots = Object.values(tsMap).sort((a, b) => a.ts - b.ts);
              const allSyms = new Set([...S.symbols, ...(liveData.symbols || [])]);
              S.symbols = [...allSyms].sort();
              S.lastSync = Date.now();
              precomputeCache();
              console.log(`[Boot] Merged live sheets: ${S.snapshots.length} total snaps`);
            }
          } catch (e) { console.warn('Live sheets supplement failed:', e); }
        }
      }
      setLoad(80);
      if (S.lastSync) setSyncState('ok', `Loaded · ${S.snapshots.length} snaps · ${fago(S.lastSync)}`);
      renderTicker(); renderSidebar();
      if (!hasCache) nav('dashboard'); else renderAll();
      setLoad(100); setTimeout(() => setLoad(0), 600);
      const stale = !S.lastSync || Date.now() - S.lastSync > 10 * 60 * 1000;
      if (stale) setTimeout(() => doSync(S.snapshots.length > 0), 1200);
    }
    catch (e) {
      console.error('Error fetching fresh data:', e);
      if (!hasCache) { const mockData = generateMockData(); mergeData(mockData); setSyncState('ok', 'Demo Mode · Offline Fallback'); renderTicker(); renderSidebar(); nav('dashboard'); toast('Demo mode: loaded fallback market data', 'ok'); }
      else { setSyncState('ok', `Offline/Cached · ${fago(S.lastSync)}`); toast('Fresh data fetch failed: ' + e.message, 'err'); }
      setLoad(0);
    }
  })().catch(e => {
    console.error('Boot error:', e);
    if (!S.snapshots || !S.snapshots.length) { const mockData = generateMockData(); mergeData(mockData); setSyncState('ok', 'Demo Mode · Offline Fallback'); renderTicker(); renderSidebar(); nav('dashboard'); toast('Demo mode: boot fallback', 'ok'); }
    setLoad(0);
  });
})();
