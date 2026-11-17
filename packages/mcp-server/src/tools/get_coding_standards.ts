import type { EmbeddingProvider } from "@review/knowledge";
import { retrieveCodingStandards } from "@review/knowledge";
import type { CodingStandardRule } from "@review/shared";
import type { Pool } from "pg";
import { z } from "zod";

import type { McpToolResult } from "./stubs.js";

export const MAX_PAYLOAD_CHARS = 12_000;

export const getCodingStandardsInputSchema = z.object({
  query: z.string().min(1),
  category: z.enum(["coding-standards", "architecture", "security"]).optional(),
  technology: z.enum(["angular", "dotnet", "database", "general"]).optional(),
  limit: z.number().int().min(1).max(10).optional(),
});

export type GetCodingStandardsInput = z.infer<
  typeof getCodingStandardsInputSchema
>;

export interface GetCodingStandardsDeps {
  pool: Pool;
  embedder: EmbeddingProvider;
}

function boundRules(rules: CodingStandardRule[]): CodingStandardRule[] {
  const size = (r: CodingStandardRule[]) =>
    JSON.stringify({ status: "ok", data: { rules: r } }).length;
  let bounded = rules;
  let cap = 1500;
  while (size(bounded) >= MAX_PAYLOAD_CHARS && cap > 200) {
    cap -= 100;
    bounded = rules.map((r) => ({ ...r, ruleText: r.ruleText.slice(0, cap) }));
  }
  while (size(bounded) >= MAX_PAYLOAD_CHARS && bounded.length > 1) {
    bounded = bounded.slice(0, -1);
  }
  return bounded;
}

export async function handleGetCodingStandards(
  args: unknown,
  deps: GetCodingStandardsDeps,
): Promise<McpToolResult> {
  const parsed = getCodingStandardsInputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      status: "service_error",
      data: null,
      error: { code: "invalid_args", message: parsed.error.message },
    };
  }

  let rules: CodingStandardRule[];
  try {
    rules = await retrieveCodingStandards({
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

  if (rules.length === 0) {
    return { status: "no_results", data: { rules: [] } };
  }
  return { status: "ok", data: { rules: boundRules(rules) } };
}
