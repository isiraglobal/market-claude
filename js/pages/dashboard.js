export function render(el, params) {
  const sum = summary();
  const gainers = topGainers(8).map(x => x.sym);
  const losers = topLosers(8).map(x => x.sym);
  const hammers = hammerSignals().slice(0, 8);
  const dzones = demandZones();
  const picks = autoPicks(6);

  el.innerHTML = `
  <div style="flex:1;overflow:auto;display:flex;flex-direction:column;min-height:0">
    <!-- Workspace bar -->
    <div class="ws-bar" id="wsBar">
      ${S.workspaces.map(w => `<button class="ws-tab${w.active ? ' active' : ''}" onclick="setWS('${w.id}',this)">${w.name}</button>`).join('')}
      <button class="ws-tab" onclick="addWSModal()">+ New</button>
    </div>

    <div style="flex:1;overflow:auto;padding:18px 20px;display:flex;flex-direction:column;gap:18px">

      <!-- KPIs -->
      <div class="kpis">
        <div class="kpi ka"><div class="kpi-lbl">Symbols</div><div class="kpi-val">${sum.total.toLocaleString()}</div><div class="kpi-sub">NSE tracked</div></div>
        <div class="kpi"><div class="kpi-lbl">Snapshots</div><div class="kpi-val">${S.snapshots.length.toLocaleString()}</div><div class="kpi-sub">${S.lastSync ? fago(S.lastSync) : 'never synced'}</div></div>
        <div class="kpi ka"><div class="kpi-lbl">Advancing</div><div class="kpi-val up">${sum.advances}</div><div class="kpi-sub">${sum.total ? ((sum.advances / sum.total) * 100).toFixed(1) + '%' : ''} of market</div></div>
        <div class="kpi kr"><div class="kpi-lbl">Declining</div><div class="kpi-val dn">${sum.declines}</div><div class="kpi-sub">${sum.total ? ((sum.declines / sum.total) * 100).toFixed(1) + '%' : ''} of market</div></div>
        <div class="kpi kb"><div class="kpi-lbl">Hammer Signals</div><div class="kpi-val" style="color:var(--blue)">${hammers.length}</div><div class="kpi-sub">Reversal patterns</div></div>
        <div class="kpi"><div class="kpi-lbl">Demand Zones</div><div class="kpi-val" style="color:var(--green)">${dzones.filter(z => z.notTested).length}</div><div class="kpi-sub">${dzones.length} total zones</div></div>
        <div class="kpi"><div class="kpi-lbl">AI Picks</div><div class="kpi-val" style="color:var(--purple)">${picks.length}</div><div class="kpi-sub">Top momentum stocks</div></div>
      </div>

      <!-- AI Market Summary -->
      <div>
        <div class="sec-hdr"><div class="sec-title">AI Market Briefing</div><div class="sec-line"></div><button class="btn btn-sm btn-ghost" onclick="refreshAIBriefing()">Refresh</button></div>
        <div class="ai-box" id="aiBriefing"><div class="ai-spinner"><div class="spin-ring"></div>Generating market analysis...</div></div>
      </div>

      <!-- Auto Picks -->
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

      <!-- Hammer Signals -->
      ${hammers.length ? `
      <div>
        <div class="sec-hdr"><div class="sec-title">Hammer Reversal Signals</div><div class="sec-line"></div><div class="sec-count">${hammers.length} detected</div></div>
        <div class="tbl-wrap"><table>
          <thead><tr><th>Symbol</th><th class="hide-mobile">Detected</th><th>Entry</th><th>Current</th><th>Score</th><th class="hide-mobile">Strength</th></tr></thead>
          <tbody>${hammers.map(h => {
            const cur = latestPrice(h.sym); const c = change(h.sym);
            return `<tr onclick="openStock('${h.sym}')" style="cursor:pointer">
              <td class="td-sym">${h.sym}</td>
              <td style="color:var(--t3);font-size:10px" class="hide-mobile">${h.label || fds(h.ts)}</td>
              <td>${fp(h.entry)}</td><td class="${cc(c)}">${fp(cur)}</td>
              <td><span class="${h.score >= 70 ? 'up' : 'nu'}" style="font-weight:700">${h.score}</span></td>
              <td style="width:90px" class="hide-mobile">${sbar(h.score)}</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table></div>
      </div>` : ''}

      ${dzones.filter(z => z.notTested).length ? `
      <div>
        <div class="sec-hdr"><div class="sec-title">Demand Zone Signals</div><div class="sec-line"></div><div class="sec-count">${dzones.filter(z => z.notTested).length} not tested</div>
          <button class="btn btn-sm btn-ghost" onclick="nav('demandzones')">View All</button>
        </div>
        <div class="tbl-wrap"><table>
          <thead><tr><th>Symbol</th><th class="hide-mobile">Detected</th><th>Proximal</th><th>Distal</th><th>Distance</th><th class="hide-mobile">Bases</th></tr></thead>
          <tbody>${dzones.filter(z => z.notTested).slice(0, 8).map(z => {
            return '<tr onclick="openStock(\'' + z.sym + '\')" style="cursor:pointer">' +
              '<td class="td-sym">' + z.sym + '</td>' +
              '<td style="color:var(--t3);font-size:10px" class="hide-mobile">' + (z.label || fds(z.ts)) + '</td>' +
              '<td style="font-weight:700;color:var(--accent)">' + fp(z.proximal) + '</td>' +
              '<td style="color:var(--t3)">' + fp(z.distal) + '</td>' +
              '<td class="up" style="font-weight:700">' + (z.distPct !== null ? z.distPct.toFixed(1) + '%' : '—') + '</td>' +
              '<td style="font-size:11px" class="hide-mobile">' + '▌'.repeat(z.numBases) + z.numBases + '</td>' +
              '</tr>';
          }).join('')}
          </tbody>
        </table></div>
      </div>` : ''}

      <!-- Gainers / Losers -->
      <div class="grid2">
        ${glCard('Top Gainers', gainers)}
        ${glCard('Top Losers', losers)}
      </div>

    </div>
  </div>`;

  // Load AI briefing
  setTimeout(refreshAIBriefing, 50);
}
