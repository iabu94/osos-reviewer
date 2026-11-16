import { pathToFileURL } from "node:url";
import { startMcpServer } from "./server.js";

export { handleTool, TOOL_NAMES } from "./tools/stubs.js";
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
