import { readdir, readFile } from "node:fs/promises";
import { extname, parse, relative, resolve, sep } from "node:path";

import type {
  DocumentCategory,
  DocumentTechnology,
} from "@review/shared";

const categories = new Set<DocumentCategory>([
  "coding-standards",
  "architecture",
  "security",
]);
const technologies = new Set<DocumentTechnology>([
  "angular",
  "dotnet",
  "database",
]);

export interface DiscoveredDocument {
  absolutePath: string;
  relativePath: string;
  category: DocumentCategory;
  technology: DocumentTechnology;
  title: string;
}

async function collectMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return collectMarkdownFiles(path);
      }
      return entry.isFile() && extname(entry.name).toLowerCase() === ".md"
        ? [path]
        : [];
    }),
  );
  return files.flat();
}

function readTitle(markdown: string, absolutePath: string): string {
  let fence:
    | { character: "`" | "~"; length: number }
    | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.character &&
        fenceMatch[1].length >= fence.length &&
        fenceMatch[2].trim() === ""
      ) {
        fence = undefined;
      }
      continue;
    }

    if (fenceMatch) {
      fence = {
        character: fenceMatch[1][0] as "`" | "~",
        length: fenceMatch[1].length,
      };
      continue;
    }

    const heading = /^\s{0,3}#\s+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(line);
    if (heading) {
      return heading[1];
    }
  }
  return parse(absolutePath).name;
}

export interface DiscoverOptions {
  /** Called once per unknown top-level entry whose Markdown files were skipped. */
  onSkippedTopLevel?: (topLevelEntry: string) => void;
}

export async function discoverDocuments(
  rootDir: string,
  options: DiscoverOptions = {},
): Promise<DiscoveredDocument[]> {
  const skipped = new Set<string>();
  const root = resolve(rootDir);
  const files = await collectMarkdownFiles(root);
  const documents = await Promise.all(
    files.map(async (absolutePath): Promise<DiscoveredDocument | null> => {
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      const [categorySegment, technologySegment] = relativePath.split("/");
      if (!categories.has(categorySegment as DocumentCategory)) {
        skipped.add(categorySegment);
        return null;
      }

      const markdown = await readFile(absolutePath, "utf8");
      return {
        absolutePath,
        relativePath,
        category: categorySegment as DocumentCategory,
        technology: technologies.has(
          technologySegment as DocumentTechnology,
        )
          ? (technologySegment as DocumentTechnology)
          : "general",
        title: readTitle(markdown, absolutePath),
      };
    }),
  );

  for (const entry of [...skipped].sort()) {
    options.onSkippedTopLevel?.(entry);
  }

  return documents
    .filter((document): document is DiscoveredDocument => document !== null)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
