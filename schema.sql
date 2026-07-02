-- Create table for storing historical market snapshots
CREATE TABLE IF NOT EXISTS snapshots (
  ts BIGINT PRIMARY KEY,
  label TEXT NOT NULL,
  prices JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Index for sorting by timestamp descending
CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots (ts DESC);
