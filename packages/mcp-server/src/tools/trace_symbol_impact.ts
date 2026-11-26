import { traceSymbolImpact } from "@osos-reviewer/code-intel";
import type { ImpactedSymbol } from "@osos-reviewer/shared";
import type { Pool } from "pg";
import { z } from "zod";

import { boundArray, clip } from "./bound.js";
import type { McpToolResult } from "./stubs.js";

export const traceSymbolImpactInputSchema = z.object({
  symbolName: z.string().min(1),
  repoIds: z.array(z.string()).optional(),
  reviewId: z.string().optional(),
  indexScope: z.enum(["baseline", "pr"]).optional(),
  maxDepth: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional(),
});

export type TraceSymbolImpactInput = z.infer<typeof traceSymbolImpactInputSchema>;

export interface TraceSymbolImpactDeps {
  pool: Pool;
}

function shrinkImpacted(item: ImpactedSymbol, cap: number): ImpactedSymbol {
  return {
    ...item,
    signature: clip(item.signature, cap),
    filePath: clip(item.filePath, Math.max(cap, 200)),
    symbolName: clip(item.symbolName, Math.max(cap, 80)),
  };
}

function boundImpacted(impacted: ImpactedSymbol[]): ImpactedSymbol[] {
  return boundArray("impacted", impacted, shrinkImpacted);
}

export async function handleTraceSymbolImpact(
  args: unknown,
  deps: TraceSymbolImpactDeps,
): Promise<McpToolResult> {
  const parsed = traceSymbolImpactInputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      status: "service_error",
      data: null,
      error: { code: "invalid_args", message: parsed.error.message },
    };
  }

  let impacted: ImpactedSymbol[];
  try {
    impacted = await traceSymbolImpact({
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

  if (impacted.length === 0) {
    return { status: "no_results", data: { impacted: [] } };
  }
  return { status: "ok", data: { impacted: boundImpacted(impacted) } };
}