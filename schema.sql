-- ===============================================================================
--  MarketAI — D1 Database Schema
--  Run this ONCE in Cloudflare Dashboard → D1 → your database → Console
--  OR via: wrangler d1 execute marketai --file=schema.sql
-- ===============================================================================

CREATE TABLE IF NOT EXISTS prices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT    NOT NULL,     -- "yyyy-MM-dd HH:mm:ss" IST
  market    TEXT    NOT NULL,     -- "NSE" | "NASDAQ" | "LSE" | "SGX" | "HKEX" | "JPX" | "ASX"
  symbol    TEXT    NOT NULL,     -- e.g. "RELIANCE", "AAPL"
  price     REAL    NOT NULL      -- numeric price, never null
);

-- Indexes for fast filtering
CREATE INDEX IF NOT EXISTS idx_market        ON prices (market);
CREATE INDEX IF NOT EXISTS idx_symbol        ON prices (symbol);
CREATE INDEX IF NOT EXISTS idx_timestamp     ON prices (timestamp);
CREATE INDEX IF NOT EXISTS idx_market_symbol ON prices (market, symbol);
CREATE INDEX IF NOT EXISTS idx_market_sym_ts ON prices (market, symbol, timestamp);
