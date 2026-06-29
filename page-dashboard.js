Pages.dashboard = function(el) {
  const sum = summary();
  const gainers = topGainers(8).map(x => x.sym);
  const losers = topLosers(8).map(x => x.sym);
  const picks = autoPicks(6);

  el.innerHTML = `
  <div style="flex:1;overflow:auto;display:flex;flex-direction:column;min-height:0">
    <div class="ws-bar" id="wsBar">
      ${S.workspaces.map(w => `<button class="ws-tab${w.active ? ' active' : ''}" onclick="setWS('${w.id}',this)">${w.name}</button>`).join('')}
      <button class="ws-tab" onclick="addWSModal()">+ New</button>
    </div>
    <div style="flex:1;overflow:auto;padding:18px 20px;display:flex;flex-direction:column;gap:18px">
      <div class="kpis">
        <div class="kpi ka"><div class="kpi-lbl">Symbols</div><div class="kpi-val">${sum.total.toLocaleString()}</div><div class="kpi-sub">NSE tracked</div></div>
        <div class="kpi"><div class="kpi-lbl">Snapshots</div><div class="kpi-val">${S.snapshots.length.toLocaleString()}</div><div class="kpi-sub">${S.lastSync ? fago(S.lastSync) : 'never synced'}</div></div>
        <div class="kpi ka"><div class="kpi-lbl">Advancing</div><div class="kpi-val up">${sum.advances}</div><div class="kpi-sub">${sum.total ? ((sum.advances / sum.total) * 100).toFixed(1) + '%' : ''} of market</div></div>
        <div class="kpi kr"><div class="kpi-lbl">Declining</div><div class="kpi-val dn">${sum.declines}</div><div class="kpi-sub">${sum.total ? ((sum.declines / sum.total) * 100).toFixed(1) + '%' : ''} of market</div></div>
        <div class="kpi kb"><div class="kpi-lbl">Hammer Signals</div><div class="kpi-val" style="color:var(--blue)" id="dash-hammer-count">—</div><div class="kpi-sub">Reversal patterns</div></div>
        <div class="kpi"><div class="kpi-lbl">Demand Zones</div><div class="kpi-val" style="color:var(--green)" id="dash-dz-count">—</div><div class="kpi-sub">Rally-Base-Rally</div></div>
        <div class="kpi"><div class="kpi-lbl">AI Picks</div><div class="kpi-val" style="color:var(--purple)">${picks.length}</div><div class="kpi-sub">Top momentum stocks</div></div>
      </div>
      <div>
        <div class="sec-hdr"><div class="sec-title">AI Market Briefing</div><div class="sec-line"></div><button class="btn btn-sm btn-ghost" onclick="refreshAIBriefing()">Refresh</button></div>
        <div class="ai-box" id="aiBriefing"><div class="ai-spinner"><div class="spin-ring"></div>Generating market analysis...</div></div>
      </div>
      ${picks.length ? `
      <div>
        <div class="sec-hdr"><div class="sec-title">AI Auto-Picks</div><div class="sec-line"></div><div class="sec-count">Top ${picks.length} by momentum score</div></div>
        <div class="pick-grid">
          ${picks.map(p => { const cls = cc(p.c); return `<div class="pick-card${p.c && p.c.pct >= 0 ? ' up-pick' : ' dn-pick'}" onclick="openStock('${p.sym}')">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
              <div class="pick-sym">${p.sym}</div><div class="pick-score">${p.score}</div>
            </div>
            <div class="pick-price ${cls}">${fp(latestPrice(p.sym))}</div>
            <div class="pick-chg ${cls}">${p.c ? fc(p.c, true) : '—'}</div>
            <div class="pick-reason">${p.reason}</div>
            <div style="margin-top:7px">${spark(p.sym, 120, 24)}</div>
          </div>`; }).join('')}
        </div>
      </div>` : ''}
    </div>
  </div>`;

  setTimeout(refreshAIBriefing, 50);
  setTimeout(() => { const h = hammerSignals(); const hc = document.getElementById('dash-hammer-count'); if (hc) hc.textContent = h.length; }, 100);
  setTimeout(() => { const dz = demandZones(); const dc = document.getElementById('dash-dz-count'); if (dc) dc.textContent = dz.filter(z => z.notTested).length; }, 300);
};
