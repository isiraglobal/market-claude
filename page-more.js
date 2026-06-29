Pages.more = function(el) {
  el.innerHTML = `
  <div class="page-hdr">
    <div>
      <div class="page-title">More Features</div>
      <div class="page-sub">Access other modules and tools</div>
    </div>
  </div>
  <div class="page-body">
    <div class="more-grid">
      <div class="more-card" onclick="nav('demandzones')">
        <div class="more-card-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg></div>
        <div class="more-card-info">
          <div class="more-card-title">Demand Zones</div>
          <div class="more-card-desc">Rally-Base-Rally patterns with proximal and distal levels</div>
        </div>
      </div>
      <div class="more-card" onclick="nav('patterns')">
        <div class="more-card-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
        <div class="more-card-info">
          <div class="more-card-title">Patterns</div>
          <div class="more-card-desc">Scan candlesticks for hammer, doji, and engulfing signals</div>
        </div>
      </div>
      <div class="more-card" onclick="nav('watchlists')">
        <div class="more-card-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg></div>
        <div class="more-card-info">
          <div class="more-card-title">Watchlists</div>
          <div class="more-card-desc">Manage custom lists and track specific stocks</div>
        </div>
      </div>
      <div class="more-card" onclick="nav('alerts')">
        <div class="more-card-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg></div>
        <div class="more-card-info">
          <div class="more-card-title">Alerts</div>
          <div class="more-card-desc">Set triggers to get notified when prices cross targets</div>
        </div>
      </div>
    </div>
  </div>`;
};
