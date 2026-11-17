-- Document RAG chunk storage. Retrieval uses exact cosine distance (pgvector <=>)
-- on a small knowledge base; no ivfflat/hnsw ANN index in Phase 2.

CREATE TABLE IF NOT EXISTS document_chunks (
  id BIGSERIAL PRIMARY KEY,
  source_path TEXT NOT NULL,
  document_title TEXT NOT NULL,
  section TEXT NOT NULL,
  category VARCHAR(50) NOT NULL,
  technology VARCHAR(50) NOT NULL,
  chunk_text TEXT NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  chunk_hash VARCHAR(64) NOT NULL,
  embedding vector(768) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_chunks_chunk_hash_key UNIQUE (chunk_hash)
);

CREATE INDEX IF NOT EXISTS document_chunks_category_technology_idx
  ON document_chunks (category, technology);