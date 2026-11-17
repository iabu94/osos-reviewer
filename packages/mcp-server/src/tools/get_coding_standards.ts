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

const FIELD_CAP_STEPS = [1500, 1000, 600, 300, 150, 50, 0];

function resultSize(rules: CodingStandardRule[]): number {
  const result: McpToolResult = { status: "ok", data: { rules } };
  return JSON.stringify(result).length;
}

function clip(value: string, cap: number): string {
  return value.length > cap ? value.slice(0, cap) : value;
}

/**
 * Guarantees JSON.stringify of the ok result is strictly below
 * MAX_PAYLOAD_CHARS: shrinks ruleText, then metadata strings, then drops
 * trailing rules (the final rule is kept with minimal fields).
 */
export function boundRules(rules: CodingStandardRule[]): CodingStandardRule[] {
  let bounded = rules;
  for (const cap of FIELD_CAP_STEPS) {
    if (resultSize(bounded) < MAX_PAYLOAD_CHARS) return bounded;
    bounded = rules.map((r) => ({
      ...r,
      ruleText: clip(r.ruleText, cap),
      documentPath: clip(r.documentPath, Math.max(cap, 200)),
      documentTitle: clip(r.documentTitle, Math.max(cap, 100)),
      section: clip(r.section, Math.max(cap, 100)),
    }));
  }
  while (resultSize(bounded) >= MAX_PAYLOAD_CHARS && bounded.length > 1) {
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
