export function render(el, params) {
  let filterType = 'all', filterStatus = 'all', minScore = 0, q = '';

  function renderPage() {
    let pats = getAllPatterns();
    if (filterType !== 'all') pats = pats.filter(p => p.type === filterType);
    if (minScore > 0) pats = pats.filter(p => p.score >= minScore);
    if (q) pats = pats.filter(p => p.sym.includes(q.toUpperCase()));
    const typeMap = { hammer: 'badge-g', doji: 'badge-y', engulfing: 'badge-b', morning_star: 'badge-p' };

    el.innerHTML = `
    <div class="page-hdr">
      <div><div class="page-title">Pattern Analysis</div><div class="page-sub">${pats.length} patterns detected</div></div>
    </div>
    <div style="padding:10px 18px;border-bottom:1px solid var(--b1);background:var(--s1);display:flex;gap:10px;flex-wrap:wrap;align-items:center;flex-shrink:0">
      <input placeholder="Symbol..." oninput="patQ(this.value)" style="font-size:11px;padding:5px 9px;width:130px">
      <select onchange="patType(this.value)" style="font-size:11px;padding:5px 9px">
        <option value="all">All Patterns</option>
        ${['hammer', 'doji', 'engulfing', 'morning_star'].map(t => `<option value="${t}">${t.replace(/_/g, ' ')}</option>`).join('')}
      </select>
      <div style="display:flex;align-items:center;gap:8px;font-size:10px;color:var(--t3)">Min Score:
        <input type="range" min="0" max="100" value="${minScore}" oninput="patScore(+this.value)" style="width:80px">
        <span id="scoreV" style="color:var(--accent);font-weight:700">${minScore}</span>
      </div>
      <button class="btn btn-sm btn-ghost" onclick="patReset()">Reset</button>
    </div>
    <div style="flex:1;overflow:auto">
      ${!pats.length ? `<div class="empty"><div class="empty-title">No patterns</div><div class="empty-sub">${S.symbols.length ? 'Try adjusting filters or sync more data' : 'Sync data first'}</div></div>` : `
      <div class="tbl-wrap" style="margin:0"><table>
        <thead><tr><th>Symbol</th><th>Pattern</th><th class="hide-mobile">Detected</th><th>Score</th><th class="hide-mobile">Strength</th><th>Vol Spike</th></tr></thead>
        <tbody>${pats.map(p => `<tr onclick="openStock('${p.sym}')" style="cursor:pointer">
          <td class="td-sym">${p.sym}</td>
          <td><span class="badge ${typeMap[p.type] || 'badge-n'}">${p.type.replace(/_/g, ' ')}</span></td>
          <td style="color:var(--t3);font-size:10px" class="hide-mobile">${p.label || fds(p.ts)}</td>
          <td><span class="${p.score >= 70 ? 'up' : p.score >= 40 ? '' : 'dn'}" style="font-weight:700">${p.score}</span></td>
          <td style="width:90px" class="hide-mobile">${sbar(p.score)}</td>
          <td>${p.volSpike ? '<span class="up" style="font-weight:700;font-size:10px">Yes</span>' : '<span style="color:var(--t3)">—</span>'}</td>
        </tr>`).join('')}
        </tbody>
      </table></div>`}
    </div>`;

    window.patQ = v => { q = v; renderPage(); };
    window.patType = v => { filterType = v; renderPage(); };
    window.patScore = v => { minScore = v; document.getElementById('scoreV').textContent = v; renderPage(); };
    window.patReset = () => { filterType = 'all'; filterStatus = 'all'; minScore = 0; q = ''; renderPage(); };
  }

  renderPage();
}
