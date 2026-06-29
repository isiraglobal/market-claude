Pages.alerts = function(el) {
  function checkAlert(a) { const cur = latestPrice(a.sym); if (!cur) return false; return (a.cond === 'above' && cur >= a.target) || (a.cond === 'below' && cur <= a.target); }
  function render() {
    const triggered = S.alerts.filter(a => a.active && checkAlert(a));
    el.innerHTML = `
    <div class="page-hdr">
      <div><div class="page-title">Price Alerts</div><div class="page-sub">${S.alerts.filter(a => a.active).length} active${triggered.length ? ' · ' + triggered.length + ' triggered' : ''}</div></div>
      <button class="btn btn-primary" onclick="createAlertMdl()">+ New Alert</button>
    </div>
    ${triggered.length ? '<div style="padding:10px 18px;border-bottom:1px solid rgba(255,46,147,.08);background:rgba(255,46,147,.05);display:flex;gap:10px;flex-wrap:wrap">' + triggered.map(a => '<div style="background:rgba(255,46,147,.1);border:1px solid rgba(255,46,147,.25);border-radius:var(--r8);padding:9px 13px"><div style="font-family:var(--display);font-size:13px;font-weight:800;color:var(--accent)">' + a.sym + '</div><div style="font-size:10px;color:var(--t3)">' + a.cond + ' Rs ' + a.target.toFixed(2) + '</div><div style="font-size:12px;font-weight:700;color:var(--accent)">' + fp(latestPrice(a.sym)) + '</div></div>').join('') + '</div>' : ''}
    <div style="flex:1;overflow:auto">
      ${!S.alerts.length ? '<div class="empty"><div class="empty-title">No alerts</div><div class="empty-sub">Get notified when stocks cross your target price</div><button class="btn btn-primary" style="margin-top:10px" onclick="createAlertMdl()">+ New Alert</button></div>' : `
      <div class="tbl-wrap" style="margin:0"><table>
        <thead><tr><th>Symbol</th><th>Condition</th><th>Target</th><th>Current</th><th>Distance</th><th>Status</th><th></th></tr></thead>
        <tbody>${S.alerts.map(a => {
          const cur = latestPrice(a.sym); const trig = checkAlert(a);
          const dist = cur ? ((cur - a.target) / a.target * 100).toFixed(2) : null;
          return `<tr>
            <td class="td-sym" onclick="openStock('${a.sym}')" style="cursor:pointer">${a.sym}</td>
            <td style="text-transform:capitalize;color:var(--t3)">${a.cond}</td>
            <td style="font-weight:700">Rs ${a.target.toFixed(2)}</td>
            <td class="${trig ? 'up' : 'nu'}">${fp(cur)}</td>
            <td style="font-size:10px">${dist != null ? '<span class="' + (+dist >= 0 ? 'up' : 'dn') + '">' + (+dist >= 0 ? '+' : '') + dist + '%</span>' : '—'}</td>
            <td>${trig ? '<span class="badge badge-g">Triggered</span>' : a.active ? '<span class="badge badge-y">Watching</span>' : '<span class="badge badge-n">Paused</span>'}</td>
            <td style="display:flex;gap:5px">
              <button class="btn btn-sm btn-ghost" onclick="toggleAlert('${a.id}')">${a.active ? 'Pause' : 'Resume'}</button>
              <button class="btn btn-sm btn-danger" onclick="delAlert('${a.id}')">Del</button>
            </td>
          </tr>`;}).join('')}
        </tbody>
      </table></div>`}
    </div>`;
    window.toggleAlert = async id => { const a = S.alerts.find(x => x.id === id); if (a) { a.active = !a.active; await saveUserData(); render(); } };
    window.delAlert = async id => { if (!confirm('Delete alert?')) return; S.alerts = S.alerts.filter(x => x.id !== id); await saveUserData(); render(); toast('Alert deleted'); };
  }
  render();
};

// (modal helpers moved to common.js)
