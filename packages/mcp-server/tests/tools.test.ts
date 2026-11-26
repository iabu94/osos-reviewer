import { describe, it, expect } from "vitest";
import type { Pool } from "pg";

import { handleCheckReusability } from "../src/tools/check_reusability.js";
import { handleTraceFeBeIntegration } from "../src/tools/trace_fe_be_integration.js";
import { handleTraceSymbolImpact } from "../src/tools/trace_symbol_impact.js";
import {
  createEnvCodeIntelDeps,
  createEnvRouterDeps,
  createEnvStandardsDeps,
  handleToolRouted,
} from "../src/tools/router.js";
import { FakeEmbeddingProvider } from "@osos-reviewer/knowledge";

describe("MCP router", () => {
  const brokenOptions = {
    getStandardsDeps: async () => {
      throw new Error("not used");
    },
    getCodeIntelDeps: async () => {
      throw new Error("not used");
    },
  };

  it("unknown tool returns service_error", async () => {
    const result = await handleToolRouted("not_a_tool", {}, brokenOptions);
    expect(result.status).toBe("service_error");
    expect(result.error?.code).toBe("unknown_tool");
  });

  it("env router deps share one lazy factory per env", () => {
    const routed = createEnvRouterDeps();
    expect(routed.getStandardsDeps).toBe(routed.getCodeIntelDeps);
    expect(createEnvStandardsDeps()).toBe(createEnvCodeIntelDeps());
  });

  it("trace_fe_be_integration rejects empty repo lists before deps load", async () => {
    let initialized = false;
    const result = await handleToolRouted(
      "trace_fe_be_integration",
      { backendRepoIds: [], frontendRepoIds: ["fe"] },
      {
        getStandardsDeps: async () => {
          initialized = true;
          throw new Error("broken");
        },
        getCodeIntelDeps: async () => {
          initialized = true;
          throw new Error("broken");
        },
      },
    );
    expect(result.status).toBe("service_error");
    expect(result.error?.code).toBe("invalid_args");
    expect(initialized).toBe(false);
  });

  it("trace_symbol_impact rejects missing symbolName before deps load", async () => {
    let initialized = false;
    for (const args of [{}, { symbolName: "" }]) {
      const result = await handleToolRouted("trace_symbol_impact", args, {
        getStandardsDeps: async () => {
          initialized = true;
          throw new Error("broken");
        },
        getCodeIntelDeps: async () => {
          initialized = true;
          throw new Error("broken");
        },
      });
      expect(result.status).toBe("service_error");
      expect(result.error?.code).toBe("invalid_args");
    }
    expect(initialized).toBe(false);
  });

  it("check_reusability rejects missing query before deps load", async () => {
    let initialized = false;
    for (const args of [{}, { query: "" }]) {
      const result = await handleToolRouted("check_reusability", args, {
        getStandardsDeps: async () => {
          initialized = true;
          throw new Error("broken");
        },
        getCodeIntelDeps: async () => {
          initialized = true;
          throw new Error("broken");
        },
      });
      expect(result.status).toBe("service_error");
      expect(result.error?.code).toBe("invalid_args");
    }
    expect(initialized).toBe(false);
  });

  const explodingPool = {
    query: async () => {
      throw new Error("pool offline");
    },
  } as unknown as Pool;
  const explodingEmbedder = new FakeEmbeddingProvider();

  it.each([
    "trace_fe_be_integration",
    "trace_symbol_impact",
    "check_reusability",
  ] as const)("router returns retrieval_failed when deps fail for %s", async (name) => {
    const args =
      name === "trace_fe_be_integration"
        ? { backendRepoIds: ["be"], frontendRepoIds: ["fe"] }
        : name === "trace_symbol_impact"
          ? { symbolName: "X" }
          : { query: "x" };
    const result = await handleToolRouted(name, args, {
      getStandardsDeps: async () => ({
        pool: explodingPool,
        embedder: explodingEmbedder,
      }),
      getCodeIntelDeps: async () => {
        throw new Error("deps init failed");
      },
    });
    expect(result.status).toBe("service_error");
    expect(result.error?.code).toBe("retrieval_failed");
  });
});

describe("handler retrieval_failed", () => {
  const explodingPool = {
    query: async () => {
      throw new Error("pool offline");
    },
  } as unknown as Pool;

  it("trace_fe_be_integration surfaces retrieval_failed from pool", async () => {
    const result = await handleTraceFeBeIntegration(
      { backendRepoIds: ["be"], frontendRepoIds: ["fe"] },
      { pool: explodingPool },
    );
    expect(result.status).toBe("service_error");
    expect(result.error?.code).toBe("retrieval_failed");
  });

  it("trace_symbol_impact surfaces retrieval_failed from pool", async () => {
    const result = await handleTraceSymbolImpact(
      { symbolName: "OrdersController" },
      { pool: explodingPool },
    );
    expect(result.status).toBe("service_error");
    expect(result.error?.code).toBe("retrieval_failed");
  });

  it("check_reusability surfaces retrieval_failed from pool", async () => {
    const result = await handleCheckReusability(
      { query: "orders" },
      { pool: explodingPool, embedder: new FakeEmbeddingProvider() },
    );
    expect(result.status).toBe("service_error");
    expect(result.error?.code).toBe("retrieval_failed");
  });
});