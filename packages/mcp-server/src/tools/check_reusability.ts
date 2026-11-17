import { findSimilarSymbols } from "@review/code-intel";
import type { EmbeddingProvider } from "@review/knowledge";
import type { ReusabilityCandidate } from "@review/shared";
import type { Pool } from "pg";
import { z } from "zod";

import { boundArray, clip } from "./bound.js";
import type { McpToolResult } from "./stubs.js";

const symbolTypeSchema = z.enum([
  "controller",
  "endpoint",
  "dto",
  "service_method",
  "validation_rule",
  "entity",
  "dbcontext_config",
  "angular_service",
  "http_call",
  "interface",
  "component",
  "signal",
]);

export const checkReusabilityInputSchema = z.object({
  query: z.string().min(1),
  repoIds: z.array(z.string()).optional(),
  symbolTypes: z.array(symbolTypeSchema).optional(),
  reviewId: z.string().optional(),
  indexScope: z.enum(["baseline", "pr"]).optional(),
  limit: z.number().int().min(1).optional(),
});

export type CheckReusabilityInput = z.infer<typeof checkReusabilityInputSchema>;

export interface CheckReusabilityDeps {
  pool: Pool;
  embedder: EmbeddingProvider;
}

function shrinkCandidate(c: ReusabilityCandidate, cap: number): ReusabilityCandidate {
  return {
    ...c,
    signature: clip(c.signature, cap),
    filePath: clip(c.filePath, Math.max(cap, 200)),
    symbolName: clip(c.symbolName, Math.max(cap, 80)),
    explanation: clip(c.explanation, cap),
  };
}

function boundCandidates(candidates: ReusabilityCandidate[]): ReusabilityCandidate[] {
  return boundArray("candidates", candidates, shrinkCandidate);
}

export async function handleCheckReusability(
  args: unknown,
  deps: CheckReusabilityDeps,
): Promise<McpToolResult> {
  const parsed = checkReusabilityInputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      status: "service_error",
      data: null,
      error: { code: "invalid_args", message: parsed.error.message },
    };
  }

  let candidates: ReusabilityCandidate[];
  try {
    candidates = await findSimilarSymbols({
      pool: deps.pool,
      embedder: deps.embedder,
      ...parsed.data,
    });
  } catch (error) {
    return {
      status: "service_error",
      data: null,
      error: {
        code: "retrieval_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (candidates.length === 0) {
    return { status: "no_results", data: { candidates: [] } };
  }
  return { status: "ok", data: { candidates: boundCandidates(candidates) } };
}