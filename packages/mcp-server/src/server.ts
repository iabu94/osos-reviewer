import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createEnvRouterDeps,
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

const TRACE_FE_BE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    backendRepoIds: { type: "array", items: { type: "string" }, minItems: 1 },
    frontendRepoIds: { type: "array", items: { type: "string" }, minItems: 1 },
    reviewId: { type: "string" },
    indexScope: { type: "string", enum: ["baseline", "pr"] },
    limit: { type: "integer", minimum: 1 },
  },
  required: ["backendRepoIds", "frontendRepoIds"],
};

const TRACE_SYMBOL_IMPACT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    symbolName: { type: "string", minLength: 1 },
    repoIds: { type: "array", items: { type: "string" } },
    reviewId: { type: "string" },
    indexScope: { type: "string", enum: ["baseline", "pr"] },
    maxDepth: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1 },
  },
  required: ["symbolName"],
};

const CHECK_REUSABILITY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1 },
    repoIds: { type: "array", items: { type: "string" } },
    symbolTypes: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "controller",
          "endpoint",
          "dto",
          "service_method",
          "validation_rule",
          "entity",
          "dbcontext_config",
          "angular_service",
          "http_call",
          "interface",
          "component",
          "signal",
        ],
      },
    },
    reviewId: { type: "string" },
    indexScope: { type: "string", enum: ["baseline", "pr"] },
    limit: { type: "integer", minimum: 1 },
  },
  required: ["query"],
};

const TOOL_DESCRIPTIONS: Record<(typeof TOOL_NAMES)[number], string> = {
  trace_fe_be_integration:
    "Trace frontend HTTP calls against backend endpoints and DTOs using indexed code intelligence; returns integration mismatches.",
  trace_symbol_impact:
    "Trace relationship graph impact from a seed symbol name across indexed repositories.",
  check_reusability:
    "Find similar symbols as reusability candidates (vector and name fallback); explanations are hints, not proof of duplication.",
  get_coding_standards:
    "Retrieve relevant coding standards, architecture, and security rules from the ingested knowledge base using real vector retrieval (pgvector).",
};

const TOOL_INPUT_SCHEMAS: Record<(typeof TOOL_NAMES)[number], object> = {
  trace_fe_be_integration: TRACE_FE_BE_INPUT_SCHEMA,
  trace_symbol_impact: TRACE_SYMBOL_IMPACT_INPUT_SCHEMA,
  check_reusability: CHECK_REUSABILITY_INPUT_SCHEMA,
  get_coding_standards: STANDARDS_INPUT_SCHEMA,
};

export function createServer(options?: Partial<RouterOptions>): Server {
  const envDefaults = createEnvRouterDeps();
  const routerOptions: RouterOptions = {
    getStandardsDeps:
      options?.getStandardsDeps ?? envDefaults.getStandardsDeps,
    getCodeIntelDeps:
      options?.getCodeIntelDeps ?? envDefaults.getCodeIntelDeps,
  };
  const server = new Server(
    { name: "review-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_NAMES.map((name) => ({
      name,
      description: TOOL_DESCRIPTIONS[name],
      inputSchema: TOOL_INPUT_SCHEMAS[name],
    })),
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