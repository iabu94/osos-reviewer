import { pathToFileURL } from "node:url";
import { startMcpServer } from "./server.js";

export { handleTool, STUB_TOOL_NAMES } from "./tools/stubs.js";
export { handleToolRouted, TOOL_NAMES } from "./tools/router.js";
export {
  getCodingStandardsInputSchema,
  handleGetCodingStandards,
} from "./tools/get_coding_standards.js";
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
