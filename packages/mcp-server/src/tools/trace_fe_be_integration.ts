import { traceFeBeIntegration } from "@review/code-intel";
import type { IntegrationMismatch, SymbolEvidence } from "@review/shared";
import type { Pool } from "pg";
import { z } from "zod";

import { boundArray, clip } from "./bound.js";
import type { McpToolResult } from "./stubs.js";

export const traceFeBeIntegrationInputSchema = z.object({
  backendRepoIds: z.array(z.string()).min(1),
  frontendRepoIds: z.array(z.string()).min(1),
  reviewId: z.string().optional(),
  indexScope: z.enum(["baseline", "pr"]).optional(),
  limit: z.number().int().min(1).optional(),
});

export type TraceFeBeIntegrationInput = z.infer<
  typeof traceFeBeIntegrationInputSchema
>;

export interface TraceFeBeIntegrationDeps {
  pool: Pool;
}

function shrinkEvidence(ev: SymbolEvidence, cap: number): SymbolEvidence {
  return {
    ...ev,
    signature: clip(ev.signature, cap),
    filePath: clip(ev.filePath, Math.max(cap, 200)),
    symbolName: clip(ev.symbolName, Math.max(cap, 80)),
  };
}

function shrinkMismatch(m: IntegrationMismatch, cap: number): IntegrationMismatch {
  return {
    ...m,
    summary: clip(m.summary, cap),
    frontend: m.frontend ? shrinkEvidence(m.frontend, cap) : undefined,
    backend: m.backend ? shrinkEvidence(m.backend, cap) : undefined,
    detail: m.detail
      ? {
          ...m.detail,
          path: m.detail.path ? clip(m.detail.path, Math.max(cap, 200)) : undefined,
          frontendProperties: m.detail.frontendProperties?.map((p) =>
            clip(p, Math.max(cap, 80)),
          ),
          backendProperties: m.detail.backendProperties?.map((p) =>
            clip(p, Math.max(cap, 80)),
          ),
        }
      : undefined,
  };
}

function boundMismatches(mismatches: IntegrationMismatch[]): IntegrationMismatch[] {
  return boundArray("mismatches", mismatches, shrinkMismatch);
}

export async function handleTraceFeBeIntegration(
  args: unknown,
  deps: TraceFeBeIntegrationDeps,
): Promise<McpToolResult> {
  const parsed = traceFeBeIntegrationInputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      status: "service_error",
      data: null,
      error: { code: "invalid_args", message: parsed.error.message },
    };
  }

  let mismatches: IntegrationMismatch[];
  try {
    mismatches = await traceFeBeIntegration({
      pool: deps.pool,
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

  if (mismatches.length === 0) {
    return { status: "no_results", data: { mismatches: [] } };
  }
  return { status: "ok", data: { mismatches: boundMismatches(mismatches) } };
}