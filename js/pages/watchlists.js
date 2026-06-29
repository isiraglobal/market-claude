export function render(el, params) {
  let activeWL = params.wlId ? S.watchlists.find(w => w.id === params.wlId) : S.watchlists[0];

  function renderPage() {
    const items = activeWL ? S.watchlistItems.filter(i => i.wlId === activeWL.id) : [];
    el.innerHTML = `
    <div style="display:flex;height:100%;overflow:hidden">
      <div class="sidebar">
        <div class="sb-hdr"><div class="sb-title">Watchlists</div>
          <button class="btn btn-primary btn-sm" onclick="createWLModal()" style="width:100%;margin-top:4px">+ New List</button>
        </div>
        <div class="sb-list">
          ${S.watchlists.map(wl => {
            const cnt = S.watchlistItems.filter(i => i.wlId === wl.id).length; return `
          <div class="si${activeWL?.id === wl.id ? ' active' : ''}" onclick="selWL('${wl.id}')">
            <div class="si-info"><div class="si-sym">${wl.name}</div><div class="si-chg nu">${cnt} stocks</div></div>
            <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();delWL('${wl.id}')">Del</button>
          </div>`;
          }).join('') || '<div style="padding:16px;color:var(--t3);font-size:11px;text-align:center">No watchlists yet</div>'}
        </div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
        ${activeWL ? `
        <div class="page-hdr" style="flex-wrap:wrap; gap:10px">
          <div><div class="page-title">${activeWL.name}</div><div class="page-sub">${items.length} stocks</div></div>
          
          <div class="wl-mobile-actions" style="display:none; align-items:center; gap:8px">
            <select class="form-inp" style="padding: 5px 8px; font-size:11px; background:var(--s1); border:1px solid var(--b1); color:var(--t1); border-radius:var(--r4)" onchange="selWL(this.value)">
              ${S.watchlists.map(w => `<option value="${w.id}" ${activeWL.id === w.id ? 'selected' : ''}>${w.name}</option>`).join('')}
            </select>
            <button class="btn btn-sm btn-ghost" onclick="createWLModal()">+ New</button>
            ${S.watchlists.length > 1 ? `<button class="btn btn-sm btn-danger" onclick="delWL('${activeWL.id}')">Del</button>` : ''}
          </div>

          <button class="btn btn-ghost" onclick="addToWLMdl('${activeWL.id}')">+ Add Stock</button>
        </div>
        <div style="flex:1;overflow:auto">
          ${!items.length ? `<div class="empty"><div class="empty-title">Empty watchlist</div><div class="empty-sub">Add stocks to monitor</div><button class="btn btn-primary" style="margin-top:10px" onclick="addToWLMdl('${activeWL.id}')">+ Add Stock</button></div>` : `
          <div class="tbl-wrap" style="margin:0"><table>
            <thead><tr><th>Symbol</th><th>Sparkline</th><th>Price</th><th>Change</th><th class="hide-mobile">High</th><th class="hide-mobile">Low</th><th class="hide-mobile">Added</th><th></th></tr></thead>
            <tbody>${items.map(item => {
              const p = latestPrice(item.sym), c = change(item.sym), st = stats(item.sym), cls = cc(c);
              return `<tr onclick="openStock('${item.sym}')" style="cursor:pointer">
                <td class="td-sym">${item.sym}</td><td>${spark(item.sym, 56, 20)}</td>
                <td class="${cls}" style="font-weight:700;font-family:var(--display)">${fp(p)}</td>
                <td class="${cls}" style="font-weight:700">${c ? fc(c, true) : '—'}</td>
                <td class="up hide-mobile">${st ? fp(st.hi) : '—'}</td><td class="dn hide-mobile">${st ? fp(st.lo) : '—'}</td>
                <td style="font-size:10px;color:var(--t3)" class="hide-mobile">${item.addedAt ? new Date(item.addedAt).toLocaleDateString('en-IN') : '—'}</td>
                <td onclick="event.stopPropagation()"><button class="btn btn-sm btn-danger" onclick="delWLItem('${item.id}')">Del</button></td>
              </tr>`;
            }).join('')}
            </tbody>
          </table></div>`}
        </div>` :
        `<div class="empty"><div class="empty-title">Select a watchlist</div><div class="empty-sub">Or create a new one</div><button class="btn btn-primary" style="margin-top:10px" onclick="createWLModal()">Create Watchlist</button></div>`}
      </div>
    </div>`;

    window.selWL = id => { activeWL = S.watchlists.find(w => w.id === id); renderPage(); };
    window.delWLItem = async id => { S.watchlistItems = S.watchlistItems.filter(i => i.id !== id); await saveUserData(); renderPage(); };
    window.delWL = async id => { if (!confirm('Delete watchlist?')) return; S.watchlists = S.watchlists.filter(w => w.id !== id); S.watchlistItems = S.watchlistItems.filter(i => i.wlId !== id); if (activeWL?.id === id) activeWL = S.watchlists[0]; await saveUserData(); renderPage(); toast('Watchlist deleted'); };
    window.createWLModal = () => showModal('New Watchlist', `
      <div class="form-grp"><label class="form-lbl">Name</label><input class="form-inp" id="wlName" placeholder="e.g. Blue Chips"></div>
      <div class="form-grp"><label class="form-lbl">Description</label><input class="form-inp" id="wlDesc" placeholder="Optional"></div>`,
      `<button class="btn btn-ghost btn-sm" onclick="closeModal()">Cancel</button><button class="btn btn-primary btn-sm" onclick="doCreateWL()">Create</button>`);
    window.doCreateWL = async () => {
      const n = document.getElementById('wlName')?.value?.trim(); if (!n) return toast('Enter a name', 'err');
      const wl = { id: 'wl' + uid(), name: n, desc: document.getElementById('wlDesc')?.value || '', createdAt: new Date().toISOString() };
      S.watchlists.push(wl); await saveUserData(); closeModal(); toast('Watchlist created'); nav('watchlists', { wlId: wl.id });
    };
  }

  renderPage();
}
