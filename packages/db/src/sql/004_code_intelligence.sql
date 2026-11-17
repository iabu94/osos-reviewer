-- Code intelligence: symbols and relationships for baseline and PR-delta indexing.

CREATE TABLE IF NOT EXISTS code_symbols (
  id BIGSERIAL PRIMARY KEY,
  repo VARCHAR(20) NOT NULL,
  revision VARCHAR(100) NOT NULL,
  branch_tag VARCHAR(100),
  index_scope VARCHAR(20) NOT NULL,
  review_id VARCHAR(100),
  symbol_type VARCHAR(50) NOT NULL,
  symbol_name VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL,
  line_start INT,
  line_end INT,
  signature TEXT NOT NULL,
  summary TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  content_hash VARCHAR(64) NOT NULL,
  embedding vector(768),
  commit_sha VARCHAR(64) NOT NULL,
  CONSTRAINT code_symbols_index_scope_check
    CHECK (index_scope IN ('baseline', 'pr')),
  CONSTRAINT code_symbols_index_scope_review_id_check
    CHECK (
      (index_scope = 'baseline' AND review_id IS NULL)
      OR (index_scope = 'pr' AND review_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS code_symbols_repo_index_scope_review_id_idx
  ON code_symbols (repo, index_scope, review_id);

CREATE INDEX IF NOT EXISTS code_symbols_repo_commit_sha_idx
  ON code_symbols (repo, commit_sha);

CREATE INDEX IF NOT EXISTS code_symbols_repo_file_path_idx
  ON code_symbols (repo, file_path);

CREATE INDEX IF NOT EXISTS code_symbols_symbol_type_symbol_name_idx
  ON code_symbols (symbol_type, symbol_name);

CREATE TABLE IF NOT EXISTS code_relationships (
  id BIGSERIAL PRIMARY KEY,
  repo VARCHAR(20) NOT NULL,
  index_scope VARCHAR(20) NOT NULL,
  review_id VARCHAR(100),
  commit_sha VARCHAR(64) NOT NULL,
  source_symbol_id BIGINT NOT NULL REFERENCES code_symbols (id) ON DELETE CASCADE,
  target_symbol_id BIGINT REFERENCES code_symbols (id) ON DELETE SET NULL,
  target_name VARCHAR(255),
  relationship_type VARCHAR(50) NOT NULL,
  file_path TEXT,
  line_start INT,
  CONSTRAINT code_relationships_index_scope_check
    CHECK (index_scope IN ('baseline', 'pr')),
  CONSTRAINT code_relationships_index_scope_review_id_check
    CHECK (
      (index_scope = 'baseline' AND review_id IS NULL)
      OR (index_scope = 'pr' AND review_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS code_relationships_source_symbol_id_idx
  ON code_relationships (source_symbol_id);

CREATE INDEX IF NOT EXISTS code_relationships_repo_index_scope_review_id_idx
  ON code_relationships (repo, index_scope, review_id);