export function render(el, params) {
  let sort = 'sym', dir = 1, q = '', tab = 'all';
  let page = 1;
  const pageSize = 100;

  function renderPage() {
    let syms = [...S.symbols].filter(s => { const st = stats(s); return st && st.count >= 1; });
    if (q) syms = syms.filter(s => s.includes(q.toUpperCase()));
    if (tab === 'gain') syms = syms.filter(s => { const c = change(s); return c && c.pct > 0.01; });
    if (tab === 'loss') syms = syms.filter(s => { const c = change(s); return c && c.pct < -0.01; });
    syms.sort((a, b) => {
      let va, vb;
      if (sort === 'sym') { va = a; vb = b; }
      else if (sort === 'price') { va = latestPrice(a) || 0; vb = latestPrice(b) || 0; }
      else if (sort === 'chg') { va = change(a)?.pct || 0; vb = change(b)?.pct || 0; }
      else if (sort === 'snaps') { va = series(a).length; vb = series(b).length; }
      if (typeof va === 'string') return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });

    const total = syms.length;
    const maxPage = Math.ceil(total / pageSize) || 1;
    if (page > maxPage) page = maxPage;
    if (page < 1) page = 1;
    const startIdx = (page - 1) * pageSize;
    const endIdx = startIdx + pageSize;
    const pageSyms = syms.slice(startIdx, endIdx);

    const arr = dir === 1 ? '&#x2191;' : '&#x2193;';
    el.innerHTML = `
    <div class="page-hdr">
      <div><div class="page-title">Stocks</div><div class="page-sub">${syms.length} of ${S.symbols.length} symbols (${S.symbols.length - syms.length} with insufficient data) — ${S.activeExchange || 'NSE'}</div></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="stocksSearch" placeholder="Search..." oninput="stSearch(this.value)" style="font-size:11px;padding:5px 9px;width:160px" value="${q}">
        <div class="sb-tabs">
          ${['all', 'gain', 'loss'].map(t => `<button class="sb-tab${tab === t ? ' active' : ''}" onclick="stTab('${t}',this)">${t === 'all' ? 'All' : t === 'gain' ? 'Gainers' : 'Losers'}</button>`).join('')}
        </div>
      </div>
    </div>
    <div style="flex:1;overflow:auto;display:flex;flex-direction:column">
      ${!syms.length ? `<div class="empty"><div class="empty-title">${S.symbols.length ? 'No matches' : 'No data'}</div><div class="empty-sub">${S.symbols.length ? 'Try a different filter' : 'Click Sync to load market data'}</div></div>` : `
      <div class="tbl-wrap" style="margin:0;flex:1;overflow:auto"><table>
        <thead><tr>
          <th onclick="stSort('sym')" style="cursor:pointer">Symbol${sort === 'sym' ? arr : ''}</th>
          <th>Sparkline</th>
          <th onclick="stSort('price')" style="cursor:pointer">Price${sort === 'price' ? arr : ''}</th>
          <th onclick="stSort('chg')" style="cursor:pointer">Change${sort === 'chg' ? arr : ''}</th>
          <th class="hide-mobile">High</th><th class="hide-mobile">Low</th>
          <th onclick="stSort('snaps')" style="cursor:pointer" class="hide-mobile">Snaps${sort === 'snaps' ? arr : ''}</th>
          <th>Action</th>
        </tr></thead>
        <tbody>${pageSyms.map(sym => {
          const p = latestPrice(sym), c = change(sym), cls = cc(c), st = stats(sym);
          return `<tr onclick="openStock('${sym}')" style="cursor:pointer">
            <td class="td-sym">${sym}</td>
            <td>${spark(sym, 56, 20)}</td>
            <td class="${cls}" style="font-family:var(--display);font-weight:700">${fp(p)}</td>
            <td class="${cls}" style="font-weight:700">${c ? fc(c, true) : '—'}</td>
            <td class="up hide-mobile" style="font-size:11px">${st ? fp(st.hi) : '—'}</td>
            <td class="dn hide-mobile" style="font-size:11px">${st ? fp(st.lo) : '—'}</td>
            <td style="color:var(--t3)" class="hide-mobile">${st ? st.count : '—'}</td>
            <td onclick="event.stopPropagation()">
              <button class="btn btn-sm btn-ghost" onclick="openStock('${sym}')">View</button>
            </td>
          </tr>`;
        }).join('')}
        </tbody>
      </table></div>
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(255,255,255,0.25);border-top:1px solid rgba(255,255,255,0.3);flex-shrink:0">
        <div style="font-size:11px;color:var(--t2)">Showing ${startIdx + 1}-${Math.min(endIdx, total)} of ${total}</div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm btn-ghost" onclick="stPage(-1)" ${page === 1 ? 'disabled' : ''}>Previous</button>
          <span style="font-size:11px;align-self:center;color:var(--t2)">Page ${page} of ${maxPage}</span>
          <button class="btn btn-sm btn-ghost" onclick="stPage(1)" ${page === maxPage ? 'disabled' : ''}>Next</button>
        </div>
      </div>
      `}
    </div>`;
  }

  window.stSearch = v => {
    q = v;
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

  window.stTab = (t, btn) => { tab = t; page = 1; renderPage(); };
  window.stSort = col => { if (sort === col) dir *= -1; else { sort = col; dir = col === 'sym' ? 1 : -1; } page = 1; renderPage(); };
  window.stPage = delta => { page += delta; renderPage(); };

  renderPage();
}
