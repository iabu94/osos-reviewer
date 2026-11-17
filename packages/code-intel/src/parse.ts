import { parseCSharpFile } from "./parse-csharp.js";
import { parseTypeScriptFile } from "./parse-typescript.js";
import type { ParseFileResult } from "./types.js";

export function parseSourceFile(opts: {
  filePath: string;
  sourceText: string;
}): ParseFileResult {
  const lower = opts.filePath.toLowerCase();
  if (lower.endsWith(".cs")) {
    return parseCSharpFile(opts);
  }
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) {
    return parseTypeScriptFile(opts);
  }
  return { symbols: [], relationships: [], errors: ["unsupported"] };
}
