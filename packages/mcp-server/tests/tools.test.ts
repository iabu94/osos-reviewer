import { describe, it, expect } from "vitest";
import { handleTool } from "../src/tools/stubs.js";

describe("MCP stubs", () => {
  for (const name of [
    "trace_fe_be_integration",
    "trace_symbol_impact",
    "check_reusability",
  ] as const) {
    it(`${name} returns no_results with bounded JSON`, async () => {
      const result = await handleTool(name, {});
      expect(result.status).toBe("no_results");
      expect(JSON.stringify(result).length).toBeLessThan(2_000);
    });
  }

  it("get_coding_standards is no longer a stub", async () => {
    const result = await handleTool("get_coding_standards", {});
    expect(result.error?.code).toBe("unknown_tool");
  });

  it("unknown tool returns service_error", async () => {
    const result = await handleTool("not_a_tool", {});
    expect(result.status).toBe("service_error");
    expect(result.error?.code).toBe("unknown_tool");
  });
});
