export type McpToolResult = {
  status: "ok" | "no_results" | "service_error";
  data: unknown;
  error?: { code: string; message: string };
};