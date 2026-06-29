Pages['stock-detail'] = function(el, params = {}) {
  const sym = params.sym || S.activeStock;
  if (!sym) { el.innerHTML = `<div class="empty"><div class="empty-title">No symbol selected</div></div>`; return; }
  S.activeStock = sym;
  let period = 'all';

  function render() {
    const sr = series(sym, period);
    const p = latestPrice(sym), c = change(sym), cls = cc(c), st = stats(sym, period);
    const rsi = st ? calcRSI(st.prices) : null;
    el.innerHTML = `
    <div class="detail-hdr">
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          <button class="btn btn-sm btn-ghost" onclick="nav('stocks')">Back</button>
          <div class="detail-sym">${sym}</div>
          <span class="badge badge-n">NSE</span>
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
        ${st ? `<div class="mini-stat-grid">
          ${[['Latest', fp(st.last), cls], ['High', fp(st.hi), 'up'], ['Low', fp(st.lo), 'dn'], ['Avg', fp(st.avg), ''], ['Return', (st.pct >= 0 ? '+' : '') + st.pct.toFixed(2) + '%', st.pct >= 0 ? 'up' : 'dn'], ['Snaps', st.count + '', '']].map(([l, v, c]) => `
          <div class="ms"><div class="ms-lbl">${l}</div><div class="ms-val ${c}">${v}</div></div>`).join('')}
        </div>` : ''}
        <div>
          <div class="sec-hdr"><div class="sec-title">AI Analysis</div><div class="sec-line"></div><button class="btn btn-sm btn-ghost" onclick="loadStockAI('${sym}')">Refresh</button></div>
          <div class="ai-box" id="stockAI"><div class="ai-spinner"><div class="spin-ring"></div>Loading analysis...</div></div>
        </div>
      </div>
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
          ${(() => { const wls = S.watchlists.filter(wl => S.watchlistItems.find(i => i.sym === sym && i.wlId === wl.id));
            return wls.length ? wls.map(wl => `<div style="font-size:11px;padding:4px 0;border-bottom:1px solid var(--b1)">${wl.name}</div>`).join('') : '<div style="color:var(--t3);font-size:11px">Not in any watchlist</div>'; })()}
          <button class="btn btn-sm btn-ghost" style="margin-top:8px;width:100%" onclick="addToWatchlist('${sym}')">Add to Watchlist</button>
        </div>
      </div>
    </div>`;

    requestAnimationFrame(() => {
      try {
        const canvas = document.getElementById('mc');
        if (canvas) drawChart(canvas, sr, sym);
        addChartTooltip(canvas, document.getElementById('ct'));
        distBar(document.getElementById('distEl'), st?.prices);
        loadStockAI(sym);
      } catch (e) { console.error('Chart render error:', e); }
    });

    window.setPrd = (pp, btn) => { period = pp; render(); };
  }

  window.loadStockAI = async function(s) {
    const el = document.getElementById('stockAI'); if (!el) return;
    const st = stats(s); if (!st) { el.innerHTML = 'Not enough data for analysis.'; return; }
    const c = change(s);
    el.innerHTML = '<div class="ai-spinner"><div class="spin-ring"></div>Analyzing...</div>';
    try {
      const ctx = 'Stock: ' + s + ', Price: ' + fp(latestPrice(s)) + ', Change: ' + (c ? fc(c) : 'none') + ', Period return: ' + st.pct.toFixed(2) + '%, High: ' + fp(st.hi) + ', Low: ' + fp(st.lo) + ', Avg: ' + fp(st.avg) + ', Volatility: ' + st.vol.toFixed(2) + '%, RSI: ' + calcRSI(st.prices).toFixed(1) + ', Snapshots: ' + st.count;
      const text = await askGroq('Analyze this NSE stock and give 3 bullet points: trend assessment, key levels (support/resistance), and trading outlook.', ctx);
      el.innerHTML = text;
    } catch (e) { el.innerHTML = 'AI analysis unavailable (GROQ_API_KEY needed).'; }
  };

  render();
};
