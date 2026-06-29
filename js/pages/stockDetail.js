export function render(el, params) {
  const sym = params.sym || S.activeStock;
  if (!sym) { el.innerHTML = `<div class="empty"><div class="empty-title">No symbol selected</div></div>`; return; }
  S.activeStock = sym;
  let period = 'all';

  function renderPage() {
    const sr = series(sym, period);
    const p = latestPrice(sym), c = change(sym), cls = cc(c), st = stats(sym, period);
    const rsi = st ? calcRSI(st.prices) : null;
    el.innerHTML = `
    <div class="detail-hdr">
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          <button class="btn btn-sm btn-ghost" onclick="nav('stocks')">Back</button>
          <div class="detail-sym">${sym}</div>
          <span class="badge badge-n">${params.exchange ? params.exchange.toUpperCase() : 'NSE'}</span>
          ${sr.length ? `<span class="badge badge-n">${sr.length} snapshots</span>` : ''}
          ${st ? `<span class="badge badge-n">Vol ${st.vol.toFixed(1)}%</span>` : ''}
        </div>
        <div class="detail-meta">
          ${sr.length ? `<div class="meta-tag">Since ${fds(sr[0].ts)}</div>` : ''}
          ${st ? `<div class="meta-tag">Avg ${fp(st.avg)}</div>` : ''}
        </div>
      </div>
      <div class="detail-price">
        <div class="dp-main ${cls}">${fp(p)}</div>
        <div class="dp-chg ${cls}">${c ? fc(c) : '—'}</div>
        <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:8px">
          <button class="btn btn-sm btn-ghost" onclick="addToPortfolio('${sym}')">Portfolio</button>
          <button class="btn btn-sm btn-ghost" onclick="addToWatchlist('${sym}')">Watchlist</button>
        </div>
      </div>
    </div>
    <div class="detail-body">
      <div class="detail-left">
        <!-- Chart -->
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <div style="font-size:10px;color:var(--t2);text-transform:uppercase;letter-spacing:1px;font-weight:700">Price History</div>
            <div class="period-row">
              ${['all', 'm3', 'm1', 'w1', 'd3'].map(pp => `<button class="prd${period === pp ? ' active' : ''}" onclick="setPrd('${pp}',this)">${pp === 'all' ? 'All' : pp.toUpperCase()}</button>`).join('')}
            </div>
          </div>
          <div class="chart-outer" style="height:220px">
            <canvas id="mc" style="display:block;width:100%;height:100%"></canvas>
            <div class="chart-tip" id="ct"></div>
          </div>
        </div>
        <!-- Mini stats -->
        ${st ? `<div class="mini-stat-grid">
          ${[['Latest', fp(st.last), cls], ['High', fp(st.hi), 'up'], ['Low', fp(st.lo), 'dn'], ['Avg', fp(st.avg), ''], ['Return', (st.pct >= 0 ? '+' : '') + st.pct.toFixed(2) + '%', st.pct >= 0 ? 'up' : 'dn'], ['Snaps', st.count + '', '']].map(([l, v, c]) => `
          <div class="ms"><div class="ms-lbl">${l}</div><div class="ms-val ${c}">${v}</div></div>`).join('')}
        </div>` : ''}
        <!-- AI Analysis -->
        <div>
          <div class="sec-hdr"><div class="sec-title">AI Analysis</div><div class="sec-line"></div><button class="btn btn-sm btn-ghost" onclick="loadStockAI('${sym}')">Refresh</button></div>
          <div class="ai-box" id="stockAI"><div class="ai-spinner"><div class="spin-ring"></div>Loading analysis...</div></div>
        </div>
      </div>
      <!-- Right panel -->
      <div class="detail-right">
        <div class="card card-sm">
          <div class="card-title" style="margin-bottom:10px">Statistics</div>
          <div class="info-rows">${st ? [
            ['Snapshots', st.count], ['High', `<span class="up">${fp(st.hi)}</span>`], ['Low', `<span class="dn">${fp(st.lo)}</span>`],
            ['Average', fp(st.avg)], ['Return', `<span class="${st.pct >= 0 ? 'up' : 'dn'}">${st.pct >= 0 ? '+' : ''}${st.pct.toFixed(2)}%</span>`],
            ['Volatility', st.vol.toFixed(2) + '%'], ['RSI(14)', rsi ? `<span style="color:${rsi > 70 ? 'var(--red)' : rsi < 30 ? 'var(--green)' : 'var(--t2)'}">${rsi.toFixed(1)}</span>` : '—'],
            ['First Seen', st.series.length ? fds(st.series[0].ts) : '—'],
          ].map(([k, v]) => `<div class="ir"><span class="ir-key">${k}</span><span class="ir-val">${v}</span></div>`).join('') : '<div style="color:var(--t3);font-size:11px">No data</div>'}</div>
        </div>
        <div class="card card-sm">
          <div class="card-title" style="margin-bottom:10px">Distribution</div>
          <div id="distEl"></div>
          <div style="font-size:9px;color:var(--t3);margin-top:6px;text-align:center">Price across snapshots</div>
        </div>
        <div class="card card-sm">
          <div class="card-title" style="margin-bottom:8px">In Watchlists</div>
          ${(() => {
            const wls = S.watchlists.filter(wl => S.watchlistItems.find(i => i.sym === sym && i.wlId === wl.id));
            return wls.length ? wls.map(wl => `<div style="font-size:11px;padding:4px 0;border-bottom:1px solid var(--b1)">${wl.name}</div>`).join('')
              : '<div style="color:var(--t3);font-size:11px">Not in any watchlist</div>';
          })()}
          <button class="btn btn-sm btn-ghost" style="margin-top:8px;width:100%" onclick="addToWatchlist('${sym}')">Add to Watchlist</button>
        </div>
      </div>
    </div>`;

    // Draw chart
    requestAnimationFrame(() => {
      const canvas = document.getElementById('mc');
      if (canvas) drawChart(canvas, sr, sym);
      addChartTooltip(canvas, document.getElementById('ct'));
      distBar(document.getElementById('distEl'), st?.prices);
      loadStockAI(sym);
    });
  }

  window.setPrd = (pp, btn) => { period = pp; renderPage(); };

  window.loadStockAI = async function (s) {
    const el = document.getElementById('stockAI'); if (!el) return;
    const st = stats(s); if (!st) { el.innerHTML = 'Not enough data for analysis.'; return; }
    const c = change(s);
    el.innerHTML = '<div class="ai-spinner"><div class="spin-ring"></div>Analyzing...</div>';
    try {
      const ctx = `Stock: ${s}, Price: ${fp(latestPrice(s))}, Change: ${c ? fc(c) : 'none'}, Period return: ${st.pct.toFixed(2)}%, High: ${fp(st.hi)}, Low: ${fp(st.lo)}, Avg: ${fp(st.avg)}, Volatility: ${st.vol.toFixed(2)}%, RSI: ${calcRSI(st.prices).toFixed(1)}, Snapshots: ${st.count}`;
      const text = await askGroq(`Analyze this NSE stock and give 3 bullet points: trend assessment, key levels (support/resistance), and trading outlook.`, ctx);
      el.innerHTML = text;
    } catch (e) { el.innerHTML = 'AI analysis unavailable (GROQ_API_KEY needed).'; }
  };

  // Load Firebase history once per symbol visit
  Cache.firebaseLoaded = Cache.firebaseLoaded || {};
  if (!Cache.firebaseLoaded[sym]) {
    Cache.firebaseLoaded[sym] = 'loading';
    fetch(`/api/firebase?action=history&symbol=${encodeURIComponent(sym)}&days=30`)
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          console.warn(`[Firebase history] ${sym}: ${data.error}`);
          Cache.firebaseLoaded[sym] = 'error';
          return;
        }
        if (Array.isArray(data.history) && data.history.length > 0) {
          mergeFirebaseHistory(sym, data.history);
          Cache.firebaseLoaded[sym] = 'loaded';
          renderPage();
        } else {
          Cache.firebaseLoaded[sym] = 'empty';
        }
      })
      .catch(err => {
        console.error(`[Firebase history] Failed to fetch for ${sym}:`, err);
        Cache.firebaseLoaded[sym] = 'error';
      });
  }

  function mergeFirebaseHistory(sym, fbHistory) {
    const localHistory = Cache.histories[sym] || [];
    const mergedMap = new Map();

    for (const item of localHistory) {
      mergedMap.set(item.ts, item);
    }

    const formatTimestamp = ts => {
      const d = new Date(ts);
      const pad = n => String(n).padStart(2, '0');
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    for (const dayDoc of fbHistory) {
      if (Array.isArray(dayDoc.minuteBars) && dayDoc.minuteBars.length > 0) {
        for (const bar of dayDoc.minuteBars) {
          if (!mergedMap.has(bar.ts)) {
            mergedMap.set(bar.ts, {
              ts: bar.ts,
              label: formatTimestamp(bar.ts),
              price: bar.price,
              ohlc: null
            });
          }
        }
      } else {
        const dayTs = new Date(dayDoc.date + 'T15:30:00').getTime();
        if (!mergedMap.has(dayTs)) {
          mergedMap.set(dayTs, {
            ts: dayTs,
            label: dayDoc.date + ' 15:30',
            price: dayDoc.close,
            ohlc: { o: dayDoc.open, h: dayDoc.high, l: dayDoc.low, c: dayDoc.close }
          });
        }
      }
    }

    const newHistory = Array.from(mergedMap.values()).sort((a, b) => a.ts - b.ts);
    Cache.histories[sym] = newHistory;
    recomputeSymbolCache(sym);
  }

  function recomputeSymbolCache(sym) {
    const history = Cache.histories[sym];
    if (!history || history.length === 0) return;

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

    if (Cache.spark) {
      delete Cache.spark[sym];
    }
  }

  renderPage();
}
