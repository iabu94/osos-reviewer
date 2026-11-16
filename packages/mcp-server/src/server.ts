import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { handleTool, TOOL_NAMES } from "./tools/stubs.js";

export function createServer(): Server {
  const server = new Server(
    { name: "review-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_NAMES.map((name) => ({
      name,
      description: `Stub Phase 1 tool: ${name}`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          repoIds: { type: "array", items: { type: "string" } },
        },
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await handleTool(
      request.params.name,
      request.params.arguments ?? {},
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: result.status === "service_error",
    };
  });

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
