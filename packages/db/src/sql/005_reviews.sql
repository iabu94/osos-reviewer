-- Review lifecycle records for Teams webhook idempotency and status tracking.

CREATE TABLE IF NOT EXISTS reviews (
  id VARCHAR(100) PRIMARY KEY,
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  pr_url TEXT NOT NULL,
  status VARCHAR(32) NOT NULL,
  teams_conversation_ref JSONB,
  result JSONB,
  error_code VARCHAR(64),
  error_message TEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  diagnostics JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT reviews_status_check
    CHECK (status IN ('accepted', 'running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS reviews_idempotency_key_idx ON reviews (idempotency_key);