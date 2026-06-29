export function render(el, params) {
  let filterStatus = 'all', q = '';

  function renderPage() {
    let zones = demandZones();
    if (filterStatus === 'tested') zones = zones.filter(z => z.tested);
    if (filterStatus === 'notested') zones = zones.filter(z => z.notTested);
    if (q) zones = zones.filter(z => z.sym.includes(q.toUpperCase()));
    el.innerHTML = `
    <div class="page-hdr">
      <div><div class="page-title">Demand Zones</div><div class="page-sub">${zones.length} Rally-Base-Rally patterns</div></div>
    </div>
    <div style="padding:10px 18px;border-bottom:1px solid var(--b1);background:var(--s1);display:flex;gap:10px;flex-wrap:wrap;align-items:center;flex-shrink:0">
      <input placeholder="Symbol..." oninput="dzQ(this.value)" style="font-size:11px;padding:5px 9px;width:130px">
      <select onchange="dzStatus(this.value)" style="font-size:11px;padding:5px 9px">
        <option value="all">All Status</option>
        <option value="notested">Not Tested</option>
        <option value="tested">Tested</option>
      </select>
      <button class="btn btn-sm btn-ghost" onclick="dzReset()">Reset</button>
      <div style="font-size:10px;color:var(--t3);margin-left:auto">
        <span style="color:var(--green);font-weight:700">${zones.filter(z => z.notTested).length}</span> not tested
        · <span style="color:var(--t3)">${zones.filter(z => z.tested).length}</span> tested
      </div>
    </div>
    <div style="flex:1;overflow:auto">
      ${!zones.length ? `<div class="empty"><div class="empty-title">No demand zones</div><div class="empty-sub">${S.symbols.length ? 'Not enough daily data to detect Rally-Base-Rally patterns' : 'Sync data first'}</div></div>` : `
      <div class="tbl-wrap" style="margin:0"><table>
        <thead><tr><th>Symbol</th><th class="hide-mobile">Detected</th><th>Proximal</th><th class="hide-mobile">Distal</th><th class="hide-mobile">Zone Size</th><th class="hide-mobile">Bases</th><th>Status</th><th>Distance</th></tr></thead>
        <tbody>${zones.map(z => {
          const cur = latestPrice(z.sym); const c = change(z.sym);
          const zoneSize = z.proximal - z.distal;
          const statusClass = z.notTested ? 'up' : z.tested ? 'dn' : 'nu';
          const statusBadge = z.notTested ? '<span class="badge badge-g">Not Tested</span>' : z.tested ? '<span class="badge badge-r">Tested</span>' : '<span class="badge badge-y">Partial</span>';
          return '<tr onclick="openStock(\'' + z.sym + '\')" style="cursor:pointer">' +
            '<td class="td-sym">' + z.sym + '</td>' +
            '<td style="color:var(--t3);font-size:10px" class="hide-mobile">' + (z.label || fds(z.ts)) + '</td>' +
            '<td style="font-weight:700;color:var(--accent)">' + fp(z.proximal) + '</td>' +
            '<td style="color:var(--t3)" class="hide-mobile">' + fp(z.distal) + '</td>' +
            '<td style="color:var(--t3);font-size:11px" class="hide-mobile">' + fp(zoneSize) + '</td>' +
            '<td style="font-size:11px" class="hide-mobile">' + '▌'.repeat(z.numBases) + '<span style="color:var(--t3)">' + z.numBases + '</span></td>' +
            '<td>' + statusBadge + '</td>' +
            '<td style="font-weight:700" class="' + statusClass + '">' + (z.distPct !== null ? z.distPct.toFixed(1) + '%' : '—') + '</td>' +
            '</tr>';
        }).join('')}
        </tbody>
      </table></div>`}
    </div>`;

    window.dzQ = v => { q = v; renderPage(); };
    window.dzStatus = v => { filterStatus = v; renderPage(); };
    window.dzReset = () => { filterStatus = 'all'; q = ''; renderPage(); };
  }

  renderPage();
}
