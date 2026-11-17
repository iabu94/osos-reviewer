import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (this file lives at packages/knowledge/src). */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Absolute KNOWLEDGE_BASE_PATH values are used as-is; relative values always
 * resolve from the repository root, independent of the process cwd.
 */
export function resolveKnowledgeBasePath(
  knowledgeBasePath: string,
  repoRoot: string = REPO_ROOT,
): string {
  return isAbsolute(knowledgeBasePath)
    ? knowledgeBasePath
    : resolve(repoRoot, knowledgeBasePath);
}
