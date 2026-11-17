-- Records which embedding model (provider:model) produced each vector so
-- changing models re-embeds documents and retrieval never mixes vector spaces.
-- Pre-existing rows get '' and are re-embedded on the next ingest.

ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(200) NOT NULL DEFAULT '';
