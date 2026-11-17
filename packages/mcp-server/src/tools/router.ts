import { createPool, migrate } from "@review/db";
import { createEmbeddingProvider } from "@review/knowledge";
import { loadConfig } from "@review/shared";
import type { EmbeddingProvider } from "@review/knowledge";
import type { Pool } from "pg";

import {
  checkReusabilityInputSchema,
  handleCheckReusability,
} from "./check_reusability.js";
import {
  getCodingStandardsInputSchema,
  handleGetCodingStandards,
  type GetCodingStandardsDeps,
} from "./get_coding_standards.js";
import type { McpToolResult } from "./stubs.js";
import {
  handleTraceFeBeIntegration,
  traceFeBeIntegrationInputSchema,
} from "./trace_fe_be_integration.js";
import {
  handleTraceSymbolImpact,
  traceSymbolImpactInputSchema,
} from "./trace_symbol_impact.js";

export const TOOL_NAMES = [
  "trace_fe_be_integration",
  "trace_symbol_impact",
  "check_reusability",
  "get_coding_standards",
] as const;

export type CodeIntelDeps = {
  pool: Pool;
  embedder: EmbeddingProvider;
};

export interface RouterOptions {
  getStandardsDeps: () => Promise<GetCodingStandardsDeps>;
  getCodeIntelDeps: () => Promise<CodeIntelDeps>;
}

function createSharedEnvDeps(
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<CodeIntelDeps> {
  let pending: Promise<CodeIntelDeps> | undefined;
  return () => {
    pending ??= (async () => {
      const config = loadConfig({
        WORKTREE_ROOT: "/tmp/review-worktrees",
        REPOS_JSON: "[]",
        ...env,
      });
      const pool = createPool(config.databaseUrl);
      try {
        await migrate(pool);
        return { pool, embedder: createEmbeddingProvider(config.embedding) };
      } catch (error) {
        await pool.end().catch(() => undefined);
        throw error;
      }
    })();
    pending.catch(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** Lazily builds pool + embedder from env on the first standards call. */
export function createEnvStandardsDeps(
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<GetCodingStandardsDeps> {
  return createSharedEnvDeps(env);
}

/** Lazily builds pool + embedder from env on the first code-intel call. */
export function createEnvCodeIntelDeps(
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<CodeIntelDeps> {
  return createSharedEnvDeps(env);
}

async function loadCodeIntelDeps(
  options: RouterOptions,
): Promise<McpToolResult | CodeIntelDeps> {
  try {
    return await options.getCodeIntelDeps();
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
}

async function loadStandardsDeps(
  options: RouterOptions,
): Promise<McpToolResult | GetCodingStandardsDeps> {
  try {
    return await options.getStandardsDeps();
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
}

export async function handleToolRouted(
  name: string,
  args: unknown,
  options: RouterOptions,
): Promise<McpToolResult> {
  switch (name) {
    case "get_coding_standards": {
      const parsed = getCodingStandardsInputSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          status: "service_error",
          data: null,
          error: { code: "invalid_args", message: parsed.error.message },
        };
      }
      const deps = await loadStandardsDeps(options);
      if ("status" in deps) return deps;
      return handleGetCodingStandards(parsed.data, deps);
    }
    case "trace_fe_be_integration": {
      const parsed = traceFeBeIntegrationInputSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          status: "service_error",
          data: null,
          error: { code: "invalid_args", message: parsed.error.message },
        };
      }
      const deps = await loadCodeIntelDeps(options);
      if ("status" in deps) return deps;
      return handleTraceFeBeIntegration(parsed.data, { pool: deps.pool });
    }
    case "trace_symbol_impact": {
      const parsed = traceSymbolImpactInputSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          status: "service_error",
          data: null,
          error: { code: "invalid_args", message: parsed.error.message },
        };
      }
      const deps = await loadCodeIntelDeps(options);
      if ("status" in deps) return deps;
      return handleTraceSymbolImpact(parsed.data, { pool: deps.pool });
    }
    case "check_reusability": {
      const parsed = checkReusabilityInputSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          status: "service_error",
          data: null,
          error: { code: "invalid_args", message: parsed.error.message },
        };
      }
      const deps = await loadCodeIntelDeps(options);
      if ("status" in deps) return deps;
      return handleCheckReusability(parsed.data, deps);
    }
    default:
      return {
        status: "service_error",
        data: null,
        error: { code: "unknown_tool", message: `Unknown tool: ${name}` },
      };
  }
}