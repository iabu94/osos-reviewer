import { describe, it, expect } from "vitest";
import { handleToolRouted } from "../src/tools/router.js";

describe("MCP router", () => {
  const options = {
    getStandardsDeps: async () => {
      throw new Error("not used");
    },
    getCodeIntelDeps: async () => {
      throw new Error("not used");
    },
  };

  it("unknown tool returns service_error", async () => {
    const result = await handleToolRouted("not_a_tool", {}, options);
    expect(result.status).toBe("service_error");
    expect(result.error?.code).toBe("unknown_tool");
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
});