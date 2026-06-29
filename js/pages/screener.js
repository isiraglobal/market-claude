export function render(el, params) {
  let filters = { minP: 0, maxP: Infinity, minSnaps: 0, minRet: -Infinity, maxRet: Infinity, trend: 'all', minVol: 0, maxVol: Infinity };
  let page = 1;
  const pageSize = 100;

  function applyFilters() {
    return S.symbols.filter(sym => {
      const p = latestPrice(sym); const st = stats(sym); const c = change(sym);
      if (!p || !st) return false;
      if (p < filters.minP || p > filters.maxP) return false;
      if (st.count < filters.minSnaps) return false;
      if (st.pct < filters.minRet || st.pct > filters.maxRet) return false;
      if (st.vol < filters.minVol || st.vol > filters.maxVol) return false;
      if (filters.trend === 'up' && (!c || c.pct <= 0)) return false;
      if (filters.trend === 'dn' && (!c || c.pct >= 0)) return false;
      return true;
    });
  }

  function renderPage() {
    const res = applyFilters();
    const total = res.length;
    const maxPage = Math.ceil(total / pageSize) || 1;
    if (page > maxPage) page = maxPage;
    if (page < 1) page = 1;
    const startIdx = (page - 1) * pageSize;
    const endIdx = startIdx + pageSize;
    const pageRes = res.slice(startIdx, endIdx);

    el.innerHTML = `
    <div style="display:flex;height:100%;overflow:hidden">
      <div class="sidebar" style="width:240px">
        <div class="sb-hdr"><div class="sb-title">Filters</div>
          <button class="btn btn-sm btn-ghost" onclick="scrReset()" style="width:100%;margin-top:4px">Reset All</button>
        </div>
        <div class="sb-list" style="padding:14px;display:flex;flex-direction:column;gap:12px">
          <div><label class="form-lbl">Price (Rs)</label>
            <div class="form-row">
              <input type="number" id="scr-minP" class="form-inp" placeholder="Min" value="${filters.minP || ''}" oninput="sf('minP',+this.value||0)" style="font-size:11px; width:100%">
              <input type="number" id="scr-maxP" class="form-inp" placeholder="Max" value="${filters.maxP === Infinity ? '' : filters.maxP}" oninput="sf('maxP',+this.value||Infinity)" style="font-size:11px; width:100%">
            </div>
          </div>
          <div><label class="form-lbl">Min Snapshots</label>
            <input type="number" id="scr-minSnaps" class="form-inp" min="0" value="${filters.minSnaps}" oninput="sf('minSnaps',+this.value)" style="width:100%;font-size:11px">
          </div>
          <div><label class="form-lbl">Return % Range</label>
            <div class="form-row">
              <input type="number" id="scr-minRet" class="form-inp" placeholder="Min %" value="${filters.minRet === -Infinity ? '' : filters.minRet}" oninput="sf('minRet',+this.value||-Infinity)" style="font-size:11px; width:100%">
              <input type="number" id="scr-maxRet" class="form-inp" placeholder="Max %" value="${filters.maxRet === Infinity ? '' : filters.maxRet}" oninput="sf('maxRet',+this.value||Infinity)" style="font-size:11px; width:100%">
            </div>
          </div>
          <div><label class="form-lbl">Volatility %</label>
            <div class="form-row">
              <input type="number" id="scr-minVol" class="form-inp" placeholder="Min" value="${filters.minVol || ''}" oninput="sf('minVol',+this.value||0)" style="font-size:11px; width:100%">
              <input type="number" id="scr-maxVol" class="form-inp" placeholder="Max" value="${filters.maxVol === Infinity ? '' : filters.maxVol}" oninput="sf('maxVol',+this.value||Infinity)" style="font-size:11px; width:100%">
            </div>
          </div>
          <div><label class="form-lbl">Trend</label>
            <select id="scr-trend" class="form-inp" onchange="sf('trend',this.value)" style="width:100%;font-size:11px">
              <option value="all" ${filters.trend === 'all' ? 'selected' : ''}>Any</option>
              <option value="up" ${filters.trend === 'up' ? 'selected' : ''}>Upward</option>
              <option value="dn" ${filters.trend === 'dn' ? 'selected' : ''}>Downward</option>
            </select>
          </div>
          <hr style="border-color:var(--b1)">
          <button class="btn btn-primary btn-sm" onclick="scrSave()">Save Screener</button>
          ${S.screeners.length ? `<div><div class="sb-title" style="margin-bottom:6px">Saved</div>
            ${S.screeners.map(s => `<div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--b1)">
              <div style="flex:1;font-size:11px;cursor:pointer" onclick="scrLoad('${s.id}')">${s.name}</div>
              <button class="btn btn-sm btn-ghost" onclick="scrDel('${s.id}')">Del</button>
            </div>`).join('')}
          </div>` : ''}
        </div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
        <div class="page-hdr">
          <div><div class="page-title">Screener Results</div><div class="page-sub">${res.length} stocks match</div></div>
          <button class="btn btn-sm btn-ghost scr-mobile-filters" style="display:none" onclick="showScrFiltersModal()">Filters</button>
        </div>
        <div style="flex:1;overflow:auto;display:flex;flex-direction:column">
          ${!res.length ? `<div class="empty"><div class="empty-title">No matches</div><div class="empty-sub">Relax filters or sync more data</div></div>` : `
          <div class="tbl-wrap" style="margin:0;flex:1;overflow:auto"><table>
            <thead><tr><th>Symbol</th><th>Sparkline</th><th>Price</th><th>Change</th><th>Return %</th><th class="hide-mobile">Volatility</th><th class="hide-mobile">Snaps</th><th></th></tr></thead>
            <tbody>${pageRes.map(sym => {
              const p = latestPrice(sym), c = change(sym), st = stats(sym), cls = cc(c);
              return `<tr onclick="openStock('${sym}')" style="cursor:pointer">
                <td class="td-sym">${sym}</td><td>${spark(sym, 56, 20)}</td>
                <td class="${cls}" style="font-weight:700;font-family:var(--display)">${fp(p)}</td>
                <td class="${cls}" style="font-weight:700">${c ? fc(c, true) : '—'}</td>
                <td class="${st && st.pct >= 0 ? 'up' : 'dn'}">${st ? (st.pct >= 0 ? '+' : '') + st.pct.toFixed(2) + '%' : '—'}</td>
                <td style="color:var(--t3)" class="hide-mobile">${st ? st.vol.toFixed(2) + '%' : '—'}</td>
                <td style="color:var(--t3)" class="hide-mobile">${st ? st.count : '—'}</td>
                <td><button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();openStock('${sym}')">View</button></td>
              </tr>`;
            }).join('')}
            </tbody>
          </table></div>
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(255,255,255,0.25);border-top:1px solid rgba(255,255,255,0.3);flex-shrink:0">
            <div style="font-size:11px;color:var(--t2)">Showing ${startIdx + 1}-${Math.min(endIdx, total)} of ${total}</div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-sm btn-ghost" onclick="scrPage(-1)" ${page === 1 ? 'disabled' : ''}>Previous</button>
              <span style="font-size:11px;align-self:center;color:var(--t2)">Page ${page} of ${maxPage}</span>
              <button class="btn btn-sm btn-ghost" onclick="scrPage(1)" ${page === maxPage ? 'disabled' : ''}>Next</button>
            </div>
          </div>
          `}
        </div>
      </div>
    </div>`;

    window.sf = (k, v) => {
      filters[k] = v;
      page = 1;
      const activeId = document.activeElement ? document.activeElement.id : null;
      const start = document.activeElement ? document.activeElement.selectionStart : null;
      const end = document.activeElement ? document.activeElement.selectionEnd : null;
      renderPage();
      if (activeId) {
        const el = document.getElementById(activeId);
        if (el) {
          el.focus();
          if (start !== null && end !== null && typeof el.setSelectionRange === 'function') {
            el.setSelectionRange(start, end);
          }
        }
      }
    };
    window.scrPage = delta => { page += delta; renderPage(); };
    window.scrReset = () => { filters = { minP: 0, maxP: Infinity, minSnaps: 0, minRet: -Infinity, maxRet: Infinity, trend: 'all', minVol: 0, maxVol: Infinity }; page = 1; renderPage(); };
    window.scrSave = () => showModal('Save Screener', `<div class="form-grp"><label class="form-lbl">Name</label><input class="form-inp" id="scrName" placeholder="e.g. High Momentum"></div>`,
      `<button class="btn btn-ghost btn-sm" onclick="closeModal()">Cancel</button><button class="btn btn-primary btn-sm" onclick="doScrSave()">Save</button>`);
    window.doScrSave = async () => { const n = document.getElementById('scrName')?.value?.trim(); if (!n) return; S.screeners.push({ id: 'scr' + uid(), name: n, filters: { ...filters } }); await saveUserData(); closeModal(); toast('Screener saved'); renderPage(); };
    window.scrLoad = id => { const s = S.screeners.find(x => x.id === id); if (s) { filters = { ...filters, ...s.filters }; page = 1; renderPage(); } };
    window.scrDel = async id => { S.screeners = S.screeners.filter(x => x.id !== id); await saveUserData(); renderPage(); };
    
    window.showScrFiltersModal = () => showModal('Screener Filters', `
      <div style="display:flex; flex-direction:column; gap:12px; padding: 4px 0">
        <div><label class="form-lbl">Price (Rs)</label>
          <div class="form-row">
            <input type="number" id="m-scr-minP" class="form-inp" placeholder="Min" value="${filters.minP || ''}" oninput="sf('minP',+this.value||0)" style="font-size:11px; width:100%">
            <input type="number" id="m-scr-maxP" class="form-inp" placeholder="Max" value="${filters.maxP === Infinity ? '' : filters.maxP}" oninput="sf('maxP',+this.value||Infinity)" style="font-size:11px; width:100%">
          </div>
        </div>
        <div><label class="form-lbl">Min Snapshots</label>
          <input type="number" id="m-scr-minSnaps" class="form-inp" min="0" value="${filters.minSnaps}" oninput="sf('minSnaps',+this.value)" style="width:100%;font-size:11px">
        </div>
        <div><label class="form-lbl">Return % Range</label>
          <div class="form-row">
            <input type="number" id="m-scr-minRet" class="form-inp" placeholder="Min %" value="${filters.minRet === -Infinity ? '' : filters.minRet}" oninput="sf('minRet',+this.value||-Infinity)" style="font-size:11px; width:100%">
            <input type="number" id="m-scr-maxRet" class="form-inp" placeholder="Max %" value="${filters.maxRet === Infinity ? '' : filters.maxRet}" oninput="sf('maxRet',+this.value||Infinity)" style="font-size:11px; width:100%">
          </div>
        </div>
        <div><label class="form-lbl">Volatility %</label>
          <div class="form-row">
            <input type="number" id="m-scr-minVol" class="form-inp" placeholder="Min" value="${filters.minVol || ''}" oninput="sf('minVol',+this.value||0)" style="font-size:11px; width:100%">
            <input type="number" id="m-scr-maxVol" class="form-inp" placeholder="Max" value="${filters.maxVol === Infinity ? '' : filters.maxVol}" oninput="sf('maxVol',+this.value||Infinity)" style="font-size:11px; width:100%">
          </div>
        </div>
        <div><label class="form-lbl">Trend</label>
          <select id="m-scr-trend" class="form-inp" onchange="sf('trend',this.value)" style="width:100%;font-size:11px">
            <option value="all" ${filters.trend === 'all' ? 'selected' : ''}>Any</option>
            <option value="up" ${filters.trend === 'up' ? 'selected' : ''}>Upward</option>
            <option value="dn" ${filters.trend === 'dn' ? 'selected' : ''}>Downward</option>
          </select>
        </div>
        ${S.screeners.length ? `
        <div style="margin-top:8px">
          <label class="form-lbl">Saved Screeners</label>
          <select class="form-inp" onchange="scrLoad(this.value); closeModal()" style="width:100%;font-size:11px">
            <option value="">-- Load Saved --</option>
            ${S.screeners.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
          </select>
        </div>` : ''}
      </div>
    `, `
      <button class="btn btn-ghost btn-sm" onclick="scrReset(); closeModal()">Reset All</button>
      <button class="btn btn-primary btn-sm" onclick="closeModal()">Apply</button>
    `);
  }

  renderPage();
}
