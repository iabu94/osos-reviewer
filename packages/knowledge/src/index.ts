export { chunkMarkdown } from "./chunk.js";
export type { DocumentChunkDraft } from "./chunk.js";
export { discoverDocuments } from "./discover.js";
export type {
  DiscoveredDocument,
  DiscoverOptions,
} from "./discover.js";
export { resolveKnowledgeBasePath } from "./paths.js";
export {
  createEmbeddingProvider,
  FAKE_EMBEDDING_MODEL_ID,
  EmbeddingError,
  FakeEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
} from "./embed.js";
export type { EmbeddingProvider } from "./embed.js";
export { ingestKnowledgeBase, EmptyDiscoveryError } from "./ingest.js";
export type { IngestReport } from "./ingest.js";
export { retrieveCodingStandards } from "./retrieve.js";
export {
  deleteChunksForMissingPaths,
  deleteChunksNotIn,
  isDocumentCurrent,
  upsertChunks,
} from "./store.js";
export type { StoredChunk } from "./store.js";
