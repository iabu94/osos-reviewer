export { chunkMarkdown } from "./chunk.js";
export type { DocumentChunkDraft } from "./chunk.js";
export { discoverDocuments } from "./discover.js";
export type { DiscoveredDocument } from "./discover.js";
export {
  createEmbeddingProvider,
  EmbeddingError,
  FakeEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
} from "./embed.js";
export type { EmbeddingProvider } from "./embed.js";
export { ingestKnowledgeBase } from "./ingest.js";
export type { IngestReport } from "./ingest.js";
export { retrieveCodingStandards } from "./retrieve.js";
export {
  deleteChunksForMissingPaths,
  deleteChunksNotIn,
  upsertChunks,
} from "./store.js";
export type { StoredChunk } from "./store.js";
