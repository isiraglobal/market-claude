Pages.portfolio = function(el) {
  function calcPL(e) { const cur = latestPrice(e.sym); if (!cur) return null; const inv = e.qty * e.avgBuy; const curV = e.qty * cur; const pl = curV - inv; return { cur, inv, curV, pl, plPct: pl / inv * 100 }; }
  function render() {
    const allPL = S.portfolio.map(e => ({ ...e, pl: calcPL(e) }));
    const totInv = allPL.reduce((a, e) => a + (e.pl?.inv || 0), 0);
    const totCur = allPL.reduce((a, e) => a + (e.pl?.curV || 0), 0);
    const totPL = totCur - totInv;
    el.innerHTML = `
    <div class="page-hdr">
      <div><div class="page-title">Portfolio</div><div class="page-sub">${S.portfolio.length} positions</div></div>
      <button class="btn btn-primary" onclick="addPosMdl()">+ Add Position</button>
    </div>
    <div class="page-body">
      ${!S.portfolio.length ? `<div class="empty"><div class="empty-title">No positions</div><div class="empty-sub">Add stocks to track unrealised P&L</div><button class="btn btn-primary" style="margin-top:10px" onclick="addPosMdl()">+ Add Position</button></div>` : `
      <div class="kpis" style="margin-bottom:18px">
        <div class="kpi"><div class="kpi-lbl">Invested</div><div class="kpi-val">${totInv >= 1e7 ? 'Rs ' + (totInv / 1e7).toFixed(2) + 'Cr' : fp(totInv)}</div></div>
        <div class="kpi ${totPL >= 0 ? 'ka' : 'kr'}"><div class="kpi-lbl">Current Value</div><div class="kpi-val ${totPL >= 0 ? 'up' : 'dn'}">${totCur >= 1e7 ? 'Rs ' + (totCur / 1e7).toFixed(2) + 'Cr' : fp(totCur)}</div></div>
        <div class="kpi ${totPL >= 0 ? 'ka' : 'kr'}"><div class="kpi-lbl">Total P&L</div><div class="kpi-val ${totPL >= 0 ? 'up' : 'dn'}">${fp(totPL)}</div></div>
        <div class="kpi ${totPL >= 0 ? 'ka' : 'kr'}"><div class="kpi-lbl">Return</div><div class="kpi-val ${totPL >= 0 ? 'up' : 'dn'}">${totInv ? (totPL >= 0 ? '+' : '') + ((totPL / totInv) * 100).toFixed(2) + '%' : '—'}</div></div>
        <div class="kpi"><div class="kpi-lbl">Positions</div><div class="kpi-val">${S.portfolio.length}</div></div>
      </div>
      <div class="tbl-wrap"><table>
        <thead><tr><th>Symbol</th><th>Qty</th><th>Avg Buy</th><th>Current</th><th>Invested</th><th>Value</th><th>P&L</th><th>P&L %</th><th>Date</th><th></th></tr></thead>
        <tbody>${allPL.map(e => { const cls = e.pl && e.pl.pl >= 0 ? 'up' : 'dn'; return `<tr>
          <td class="td-sym" onclick="openStock('${e.sym}')" style="cursor:pointer">${e.sym}</td>
          <td>${e.qty.toLocaleString()}</td><td>${fp(e.avgBuy)}</td>
          <td class="${cls}">${e.pl ? fp(e.pl.cur) : '—'}</td>
          <td>${fp(e.qty * e.avgBuy)}</td>
          <td>${e.pl ? fp(e.pl.curV) : '—'}</td>
          <td class="${cls}" style="font-weight:700">${e.pl ? fp(e.pl.pl) : '—'}</td>
          <td><span class="badge ${e.pl && e.pl.plPct >= 0 ? 'badge-g' : 'badge-r'}">${e.pl ? (e.pl.plPct >= 0 ? '+' : '') + e.pl.plPct.toFixed(2) + '%' : '—'}</span></td>
          <td style="font-size:10px;color:var(--t3)">${e.date || '—'}</td>
          <td><button class="btn btn-sm btn-danger" onclick="delPos('${e.id}')">Del</button></td>
        </tr>`;}).join('')}
        </tbody>
      </table></div>`}
    </div>`;
    window.delPos = async id => { if (!confirm('Remove position?')) return; S.portfolio = S.portfolio.filter(e => e.id !== id); await saveUserData(); render(); toast('Position removed'); };
  }
  render();
};
