const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SHEET_ID = '1o6L7bHDrUozEPaLFsXPtls7Jey88lQm0789fq5T2GqA';
const DATA_FILE = '/Users/lakshitsinghvi/Documents/Stock Market/data.json';
const MAX_SNAPSHOTS = 200;

function clean(v) {
  if (!v) return "";
  let s = v.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const cells = [];
    let cur = "", inQ = false;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (c === '"') {
        if (inQ && line[j + 1] === '"') { cur += '"'; j++; }
        else { inQ = !inQ; }
      } else if (c === ',' && !inQ) {
        cells.push(cur.trim());
        cur = "";
      } else {
        cur += c;
      }
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

function parseTimestamp(raw) {
  const s = clean(raw);
  if (!s || s === "SYMBOL") return null;
  if (/^\d{10,}$/.test(s)) {
    const ts = +s;
    if (ts >= 946684800000 && ts <= 4102444800000) return ts;
    return null;
  }
  const gviz = s.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/i);
  if (gviz) {
    const [, yr, mo, day, hh = 0, mm = 0, ss = 0] = gviz;
    const yr_num = +yr;
    if (yr_num < 2000 || yr_num > 2100) return null;
    const ts = new Date(yr_num, +mo, +day, +hh, +mm, +ss).getTime();
    return isNaN(ts) ? null : ts;
  }
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (dmy) {
    const [, day, mon, yr, hh, mm, ss = "00"] = dmy;
    const yr_num = +yr;
    if (yr_num < 2000 || yr_num > 2100) return null;
    const ts = new Date(`${yr}-${mon.padStart(2, "0")}-${day.padStart(2, "0")}T${hh.padStart(2, "0")}:${mm}:${ss}`).getTime();
    return isNaN(ts) ? null : ts;
  }
  const d = new Date(s);
  const ts = d.getTime();
  if (!isNaN(ts) && ts >= 946684800000 && ts <= 4102444800000) return ts;
  return null;
}

function parsePrice(raw) {
  if (!raw) return null;
  let s = clean(raw);
  if (!s || ["#N/A", "N/A", "#VALUE!", "#REF!", "#ERROR!", "#NUM!"].includes(s)) return null;
  let n = parseFloat(s);
  if (isNaN(n)) n = parseFloat(s.replace(/[^\d.-]/g, ""));
  return isFinite(n) && n > 0 ? n : null;
}

(async () => {
  try {
    console.log('Fetching SYMBOLS CSV via curl...');
    const s1Csv = execSync(`curl -s -L "https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=SYMBOLS"`, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
    const s1Rows = parseCSV(s1Csv);

    console.log('Fetching NSE CSV via curl...');
    const s2Csv = execSync(`curl -s -L "https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=NSE"`, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
    const s2Rows = parseCSV(s2Csv);

    console.log(`Parsed ${s1Rows.length} symbol rows, ${s2Rows.length} price rows.`);

    const header = s2Rows[0];
    const firstColHeader = clean(header[0]).toUpperCase();

    // Check if new format
    const isNewFormat = firstColHeader.includes("SYMBOL") || isNaN(Number(s2Rows[1][0].trim()));
    console.log(`isNewFormat: ${isNewFormat}`);

    const meta = [];
    const startCol = isNewFormat ? 1 : 0;
    
    // Process only the last MAX_SNAPSHOTS columns to keep payload small
    const colLimit = Math.max(startCol, header.length - MAX_SNAPSHOTS);
    for (let c = colLimit; c < header.length; c++) {
      const colTs = parseTimestamp(header[c]);
      if (colTs) meta.push({ col: c, label: clean(header[c]), ts: colTs });
    }

    console.log(`Identified ${meta.length} snapshots in range.`);

    const priceMap = {};
    meta.forEach(m => { priceMap[m.ts + "_" + m.col] = {}; });
    const symsSet = new Set();

    for (let r = 1; r < s2Rows.length; r++) {
      const row = s2Rows[r];
      let sym = "";
      if (isNewFormat) {
        sym = clean(row[0]).toUpperCase().replace(/\s+/g, "");
      }

      if (!sym || sym === "SYMBOL") continue;

      for (const m of meta) {
        const p = parsePrice(row[m.col]);
        if (p !== null) {
          priceMap[m.ts + "_" + m.col][sym] = p;
          symsSet.add(sym);
        }
      }
    }

    const validAdded = meta
      .map(m => ({
        id: `snap_${m.ts}_${m.col}`,
        ts: m.ts,
        label: m.label,
        prices: priceMap[m.ts + "_" + m.col]
      }))
      .filter(s => Object.keys(s.prices).length > 0)
      .sort((a, b) => a.ts - b.ts);

    const pool = {
      snapshots: validAdded,
      symbols: [...symsSet].sort(),
      lastSync: Date.now(),
      syncCount: 1
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(pool, null, 2), 'utf8');
    console.log(`Saved clean pool to ${DATA_FILE}.`);
    console.log(`Total Symbols: ${pool.symbols.length}`);
    console.log(`Total Snapshots: ${pool.snapshots.length}`);
    console.log(`Symbols preview:`, pool.symbols.slice(0, 10));
  } catch (err) {
    console.error('Error executing generator:', err);
  }
})();
