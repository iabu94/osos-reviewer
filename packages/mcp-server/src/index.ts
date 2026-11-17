import { pathToFileURL } from "node:url";
import { startMcpServer } from "./server.js";

export {
  createEnvCodeIntelDeps,
  createEnvRouterDeps,
  createEnvStandardsDeps,
  handleToolRouted,
  TOOL_NAMES,
} from "./tools/router.js";
export {
  getCodingStandardsInputSchema,
  handleGetCodingStandards,
} from "./tools/get_coding_standards.js";
export {
  traceFeBeIntegrationInputSchema,
  handleTraceFeBeIntegration,
} from "./tools/trace_fe_be_integration.js";
export {
  traceSymbolImpactInputSchema,
  handleTraceSymbolImpact,
} from "./tools/trace_symbol_impact.js";
export {
  checkReusabilityInputSchema,
  handleCheckReusability,
} from "./tools/check_reusability.js";
export type { McpToolResult } from "./tools/stubs.js";
export { createServer, startMcpServer } from "./server.js";

const entry = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (entry && import.meta.url === entry) {
  startMcpServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}