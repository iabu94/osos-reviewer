import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createEnvStandardsDeps,
  handleToolRouted,
  TOOL_NAMES,
  type RouterOptions,
} from "./tools/router.js";

const STANDARDS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1 },
    category: {
      type: "string",
      enum: ["coding-standards", "architecture", "security"],
    },
    technology: {
      type: "string",
      enum: ["angular", "dotnet", "database", "general"],
    },
    limit: { type: "integer", minimum: 1, maximum: 10 },
  },
  required: ["query"],
};

const STUB_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    repoIds: { type: "array", items: { type: "string" } },
  },
};

export function createServer(options?: Partial<RouterOptions>): Server {
  const routerOptions: RouterOptions = {
    getStandardsDeps: options?.getStandardsDeps ?? createEnvStandardsDeps(),
  };
  const server = new Server(
    { name: "review-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_NAMES.map((name) =>
      name === "get_coding_standards"
        ? {
            name,
            description:
              "Retrieve relevant coding standards, architecture, and security rules from the ingested knowledge base using real vector retrieval (pgvector).",
            inputSchema: STANDARDS_INPUT_SCHEMA,
          }
        : {
            name,
            description: `Stub Phase 1 tool: ${name}`,
            inputSchema: STUB_INPUT_SCHEMA,
          },
    ),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await handleToolRouted(
      request.params.name,
      request.params.arguments ?? {},
      routerOptions,
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
