export function render(el, params) {
  function renderPage() {
    el.innerHTML = `
    <div class="page-hdr"><div class="page-title">Settings</div></div>
    <div class="page-body" style="max-width:620px">

      <div class="card" style="margin-bottom:14px">
        <div class="card-hdr"><div class="card-title">Data Source</div></div>
        <div style="font-size:11px;color:var(--t2);margin-bottom:14px;line-height:1.7">
          The app fetches from Google Sheets via a Vercel serverless function on every page load, and every 10 minutes via a cron job during market hours. All data is stored in <code style="color:var(--accent)">data.json</code> on the server or in Vercel KV.
        </div>
        <div class="info-rows">
          <div class="ir"><span class="ir-key">Sheet Link</span><span class="ir-val" style="font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis"><a href="https://docs.google.com/spreadsheets/d/${SHEET_CONFIG.id}/edit" target="_blank">Spreadsheet (${SHEET_CONFIG.nseTab})</a></span></div>
          <div class="ir"><span class="ir-key">Tab</span><span class="ir-val">${SHEET_CONFIG.nseTab}</span></div>
          <div class="ir"><span class="ir-key">Snapshots stored</span><span class="ir-val">${S.snapshots.length.toLocaleString()}</span></div>
          <div class="ir"><span class="ir-key">Symbols tracked</span><span class="ir-val">${S.symbols.length.toLocaleString()}</span></div>
          <div class="ir"><span class="ir-key">Last sync</span><span class="ir-val">${S.lastSync ? fdt(S.lastSync) : 'Never'}</span></div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn btn-primary" onclick="doSync()">Sync Now</button>
          <button class="btn btn-ghost" onclick="if(confirm('Clear all snapshots?')){clearMarketData();}">Clear Market Data</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-hdr"><div class="card-title">User Data</div></div>
        <div class="info-rows">
          <div class="ir"><span class="ir-key">Portfolio positions</span><span class="ir-val">${S.portfolio.length}</span></div>
          <div class="ir"><span class="ir-key">Watchlists</span><span class="ir-val">${S.watchlists.length}</span></div>
          <div class="ir"><span class="ir-key">Watchlist items</span><span class="ir-val">${S.watchlistItems.length}</span></div>
          <div class="ir"><span class="ir-key">Active alerts</span><span class="ir-val">${S.alerts.filter(a => a.active).length}</span></div>
          <div class="ir"><span class="ir-key">Saved screeners</span><span class="ir-val">${S.screeners.length}</span></div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="exportData()">Export Data (JSON)</button>
        </div>
      </div>

      <div class="card" style="border-color:rgba(242,92,110,.2)">
        <div class="card-hdr"><div class="card-title" style="color:var(--red)">Danger Zone</div></div>
        <div style="font-size:11px;color:var(--t3);margin-bottom:12px">Market data can be re-synced. Portfolio/watchlists/alerts cannot be recovered once deleted.</div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-danger btn-sm" onclick="clearMarketData()">Clear Market Data</button>
          <button class="btn btn-danger btn-sm" onclick="clearAll()">Clear Everything</button>
        </div>
      </div>

    </div>`;

    window.clearMarketData = async () => {
      S.snapshots = []; S.symbols = []; S.lastSync = null;
      precomputeCache();
      await fetch(`${API}/api/sync`, { method: 'DELETE' }).catch(() => { });
      setSyncState('', 'Not synced'); toast('Market data cleared'); renderPage();
    };
    window.clearAll = async () => {
      if (!confirm('Delete ALL data? This cannot be undone.')) return;
      S.portfolio = []; S.watchlists = []; S.watchlistItems = []; S.alerts = []; S.screeners = [];
      await saveUserData(); await window.clearMarketData();
    };
    window.exportData = () => {
      const data = { exported: new Date().toISOString(), snapshots: S.snapshots, portfolio: S.portfolio, watchlists: S.watchlists, watchlistItems: S.watchlistItems, alerts: S.alerts, screeners: S.screeners };
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.download = `marketai_${Date.now()}.json`; a.click();
      toast('Data exported');
    };
  }

  renderPage();
}
