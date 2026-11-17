import { z } from "zod";

export const toolInputSchema = z.object({
  query: z.string().optional(),
  repoIds: z.array(z.string()).optional(),
});

export type McpToolResult = {
  status: "ok" | "no_results" | "service_error";
  data: unknown;
  error?: { code: string; message: string };
};

export const STUB_TOOL_NAMES = [
  "trace_fe_be_integration",
  "trace_symbol_impact",
  "check_reusability",
] as const;

export type StubToolName = (typeof STUB_TOOL_NAMES)[number];

const EMPTY_DATA: Record<StubToolName, unknown> = {
  trace_fe_be_integration: { mismatches: [] },
  trace_symbol_impact: { impacted: [] },
  check_reusability: { candidates: [] },
};

export async function handleTool(
  name: string,
  args: unknown,
): Promise<McpToolResult> {
  toolInputSchema.safeParse(args ?? {});

  if (!(STUB_TOOL_NAMES as readonly string[]).includes(name)) {
    return {
      status: "service_error",
      data: null,
      error: { code: "unknown_tool", message: `Unknown tool: ${name}` },
    };
  }

  return {
    status: "no_results",
    data: EMPTY_DATA[name as StubToolName],
  };
}
