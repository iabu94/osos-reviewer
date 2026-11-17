import { createPool, migrate } from "@review/db";
import { createEmbeddingProvider } from "@review/knowledge";
import { loadConfig } from "@review/shared";

import {
  getCodingStandardsInputSchema,
  handleGetCodingStandards,
  type GetCodingStandardsDeps,
} from "./get_coding_standards.js";
import { handleTool, STUB_TOOL_NAMES, type McpToolResult } from "./stubs.js";

export const TOOL_NAMES = [...STUB_TOOL_NAMES, "get_coding_standards"] as const;

export interface RouterOptions {
  getStandardsDeps: () => Promise<GetCodingStandardsDeps>;
}

/** Lazily builds pool + embedder from env on the first standards call. */
export function createEnvStandardsDeps(
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<GetCodingStandardsDeps> {
  let pending: Promise<GetCodingStandardsDeps> | undefined;
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
      pending = undefined; // allow retry after a transient failure
    });
    return pending;
  };
}

export async function handleToolRouted(
  name: string,
  args: unknown,
  options: RouterOptions,
): Promise<McpToolResult> {
  if (name !== "get_coding_standards") {
    return handleTool(name, args);
  }

  const parsed = getCodingStandardsInputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      status: "service_error",
      data: null,
      error: { code: "invalid_args", message: parsed.error.message },
    };
  }

  let deps: GetCodingStandardsDeps;
  try {
    deps = await options.getStandardsDeps();
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
  return handleGetCodingStandards(parsed.data, deps);
}
