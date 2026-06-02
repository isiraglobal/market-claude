// netlify/functions/sync-cron.js
// Scheduled function — runs automatically via Netlify Scheduled Functions.
// Schedule: every 5 minutes during NSE market hours (Mon-Fri 09:10-15:40 IST)
// IST = UTC+5:30, so 09:10 IST = 03:40 UTC, 15:40 IST = 10:10 UTC
//
// In netlify.toml add:
// [functions."sync-cron"]
//   schedule = "*/5 3-10 * * 1-5"
//
// This calls the same sync logic as the on-demand sync function.

const syncHandler = require("./sync").handler;

exports.handler = async (event) => {
  console.log("[sync-cron] Running scheduled sync at", new Date().toISOString());
  const result = await syncHandler({ httpMethod: "GET" });
  console.log("[sync-cron] Result:", result.body);
  return result;
};
