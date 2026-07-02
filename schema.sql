-- Create table for symbols / stocks
CREATE TABLE IF NOT EXISTS stocks (
  sym TEXT PRIMARY KEY,
  name TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create table for time-series price data
CREATE TABLE IF NOT EXISTS stock_prices (
  sym TEXT REFERENCES stocks(sym) ON DELETE CASCADE,
  ts BIGINT NOT NULL,
  label TEXT NOT NULL,
  close NUMERIC NOT NULL,
  open NUMERIC,
  high NUMERIC,
  low NUMERIC,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  PRIMARY KEY (sym, ts)
);

-- Index for fast time-series queries
CREATE INDEX IF NOT EXISTS idx_stock_prices_ts ON stock_prices (ts DESC);
CREATE INDEX IF NOT EXISTS idx_stock_prices_sym_ts ON stock_prices (sym, ts DESC);

-- RPC function to aggregate and return the latest N snapshots in the original client-side format
CREATE OR REPLACE FUNCTION get_latest_snapshots(limit_count INT)
RETURNS TABLE (ts BIGINT, label TEXT, prices JSONB) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    p.ts, 
    p.label, 
    jsonb_object_agg(
      p.sym, 
      CASE 
        WHEN p.open IS NOT NULL AND p.high IS NOT NULL AND p.low IS NOT NULL THEN 
          jsonb_build_object('c', p.close, 'o', p.open, 'h', p.high, 'l', p.low)
        ELSE 
          to_jsonb(p.close)
      END
    ) as prices
  FROM (
    SELECT sym, ts, label, close, open, high, low
    FROM stock_prices
    WHERE ts IN (SELECT DISTINCT s.ts FROM stock_prices s ORDER BY s.ts DESC LIMIT limit_count)
  ) p
  GROUP BY p.ts, p.label
  ORDER BY p.ts DESC;
END;
$$ LANGUAGE plpgsql;
