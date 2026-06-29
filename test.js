// test.js — Comprehensive verification for MarketAI
// Usage: node test.js

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}
function section(name) { console.log(`\n${'─'.repeat(56)}\n${name}\n${'─'.repeat(56)}`); }

// ── 1. Module Loading ─────────────────────────────────────────────────────────
section('1. Module Loading');

let data, groq;
try {
  data = require('./api/data');
  assert(typeof data === 'function', 'data exports a function handler');
} catch (e) {
  console.error('FAILED to load api/data.js:', e.message);
  process.exit(1);
}

try {
  groq = require('./api/groq');
  assert(typeof groq === 'function', 'groq exports a function handler');
} catch (e) {
  console.error('FAILED to load api/groq.js:', e.message);
}

// ── 2. groq.js (syntax check) ──────────────────────────────────────────────
section('2. groq.js (syntax & structure)');

assert(typeof groq === 'function', 'groq exports handler');

// ── 3. data.js (syntax check) ──────────────────────────────────────────────
section('3. data.js (syntax & structure)');

assert(typeof data === 'function', 'data exports handler');

// ── 4. GoogleAppsScript.js (structure check) ──────────────────────────────
section('4. GoogleAppsScript.js (structure check)');

const gas = require('fs').readFileSync('./GoogleAppsScript.js', 'utf8');
const gasLines = gas.split('\n');
const fnMatches = gas.match(/function\s+(\w+)/g) || [];
const fnNames = fnMatches.map(f => f.replace('function ', ''));
const required = ['captureOHLCSnapshot','logStockPrices','setupAll','onOpen',
  'getTimeIST','gitApi','gitCommitFile','setGitHubToken','setGitHubTokenUI',
  'appendMinuteColumn','isMarketHours','isTradingDay','computePricesHash',
  'resetSheetDaily','getDateStr'];
for (const fn of required) {
  assert(fnNames.includes(fn), `GoogleAppsScript defines ${fn}()`);
}
assert(gasLines.length > 100, `GoogleAppsScript is substantial (${gasLines.length} lines)`);

// ── 5. common.js (syntax check) ──────────────────────────────────────────
section('5. common.js (syntax check)');

try {
  new Function(require('fs').readFileSync('./common.js', 'utf8'));
  assert(true, 'common.js no syntax errors');
} catch (e) {
  assert(false, 'common.js syntax error: ' + e.message);
}

// ── 6. Page file existence ──────────────────────────────────────────────
section('6. Page file existence');

const pages = ['dashboard','stocks','stock-detail','patterns','demandzones','screener','portfolio','watchlists','alerts','settings','more'];
for (const pg of pages) {
  try {
    require('fs').readFileSync(`./page-${pg}.js`, 'utf8');
    assert(true, `page-${pg}.js exists`);
  } catch (e) {
    assert(false, `page-${pg}.js missing`);
  }
}

// ── 7. Core files exist ──────────────────────────────────────────────
section('7. Core files exist');

const coreFiles = ['index.html','style.css','common.js','vercel.json'];
for (const f of coreFiles) {
  try {
    require('fs').readFileSync(f, 'utf8');
    assert(true, `${f} exists`);
  } catch (e) {
    assert(false, `${f} missing`);
  }
}

assert(require('fs').existsSync('./GoogleAppsScript.js'), 'GoogleAppsScript.js exists');

// No Firebase files should exist
assert(!require('fs').existsSync('./api/firebase.js'), 'api/firebase.js deleted');
assert(!require('fs').existsSync('./api/sync.js'), 'api/sync.js deleted');
assert(!require('fs').existsSync('./api/migrate.js'), 'api/migrate.js deleted');

// ── SUMMARY ────────────────────────────────────────────────────────────────
section('SUMMARY');
const total = passed + failed;
console.log(`  Total:  ${total}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Status: ${failed === 0 ? 'ALL OK ✓' : `${failed} FAILURE(S) ✗`}`);
process.exit(failed > 0 ? 1 : 0);
