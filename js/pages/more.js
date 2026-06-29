export function render(el, params) {
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
        <div class="more-card-icon">📊</div>
        <div class="more-card-info">
          <div class="more-card-title">Demand Zones</div>
          <div class="more-card-desc">Rally-Base-Rally patterns with proximal and distal levels</div>
        </div>
      </div>
      <div class="more-card" onclick="nav('patterns')">
        <div class="more-card-icon">🎯</div>
        <div class="more-card-info">
          <div class="more-card-title">Patterns</div>
          <div class="more-card-desc">Scan candlesticks for hammer, doji, and engulfing signals</div>
        </div>
      </div>
      <div class="more-card" onclick="nav('watchlists')">
        <div class="more-card-icon">⭐</div>
        <div class="more-card-info">
          <div class="more-card-title">Watchlists</div>
          <div class="more-card-desc">Manage custom lists and track specific stocks</div>
        </div>
      </div>
      <div class="more-card" onclick="nav('alerts')">
        <div class="more-card-icon">🔔</div>
        <div class="more-card-info">
          <div class="more-card-title">Alerts</div>
          <div class="more-card-desc">Set triggers to get notified when prices cross targets</div>
        </div>
      </div>
    </div>
  </div>`;
}
