const fs = require("fs");
const https = require("https");
const path = require("path");

const project = "stockmarket-isira";
const key = "AIzaSyBv3vXMpMWhm3Y672LyAyrsjtO8edvXVp0";
const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/market-index/v1?key=${key}`;

console.log("Fetching market-index/v1 from Firestore...");

https.get(url, res => {
  let body = "";
  res.on("data", chunk => body += chunk);
  res.on("end", () => {
    if (res.statusCode !== 200) {
      console.error(`Error: Fetch failed with status code ${res.statusCode}`);
      console.error(body);
      process.exit(1);
    }

    try {
      const doc = JSON.parse(body);
      const rawData = doc.fields?.data?.stringValue;
      if (!rawData) {
        console.error("Error: Firestore document does not contain a data field.");
        process.exit(1);
      }

      const fbData = JSON.parse(rawData);
      console.log(`Firestore data loaded: ${fbData.snapshots?.length || 0} snapshots, ${fbData.symbols?.length || 0} symbols.`);

      // Read local data.json
      const localPath = path.join(__dirname, "../data.json");
      let localData = { snapshots: [], symbols: [], lastSync: null };
      if (fs.existsSync(localPath)) {
        try {
          localData = JSON.parse(fs.readFileSync(localPath, "utf8"));
          console.log(`Local data loaded: ${localData.snapshots?.length || 0} snapshots.`);
        } catch (e) {
          console.warn("Could not parse local data.json, starting fresh.");
        }
      }

      // Merge snapshots by ts
      const snapMap = {};
      (localData.snapshots || []).forEach(s => { if (s && s.ts) snapMap[s.ts] = s; });
      (fbData.snapshots || []).forEach(s => { if (s && s.ts) snapMap[s.ts] = s; });

      const mergedSnapshots = Object.values(snapMap).sort((a, b) => a.ts - b.ts);
      
      // Merge symbols
      const symbolsSet = new Set([...(localData.symbols || []), ...(fbData.symbols || [])]);
      const mergedSymbols = Array.from(symbolsSet).sort();

      const mergedData = {
        snapshots: mergedSnapshots,
        symbols: mergedSymbols,
        lastSync: Math.max(localData.lastSync || 0, fbData.lastSync || 0) || Date.now(),
        syncCount: (localData.syncCount || 0) + 1
      };

      // Write back to data.json
      fs.writeFileSync(localPath, JSON.stringify(mergedData, null, 2), "utf8");
      console.log(`Successfully merged and saved to data.json!`);
      console.log(`New total: ${mergedSnapshots.length} snapshots, ${mergedSymbols.length} symbols.`);
    } catch (err) {
      console.error("Error processing data:", err.message);
      process.exit(1);
    }
  });
}).on("error", err => {
  console.error("HTTP error:", err.message);
  process.exit(1);
});
