import { createHash } from "node:crypto";

import type {
  DocumentCategory,
  DocumentTechnology,
} from "@review/shared";

import type { DiscoveredDocument } from "./discover.js";

const MAX_CHUNK_CHARACTERS = 1200;

export interface DocumentChunkDraft {
  sourcePath: string;
  documentTitle: string;
  section: string;
  category: DocumentCategory;
  technology: DocumentTechnology;
  chunkText: string;
  chunkHash: string;
}

interface MarkdownSection {
  section: string;
  headings: string[];
  body: string;
}

function parseSections(markdown: string, title: string): MarkdownSection[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: MarkdownSection[] = [];
  let levelTwo: string | undefined;
  let fence:
    | { character: "`" | "~"; length: number }
    | undefined;
  let current: MarkdownSection = {
    section: title,
    headings: [`# ${title}`],
    body: "",
  };

  const flush = (): void => {
    if (current.body.trim() || current.section !== title) {
      sections.push({ ...current, body: current.body.trim() });
    }
  };

  for (const line of lines) {
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
      current.body += `${line}\n`;
      continue;
    }

    if (fenceMatch) {
      fence = {
        character: fenceMatch[1][0] as "`" | "~",
        length: fenceMatch[1].length,
      };
      current.body += `${line}\n`;
      continue;
    }

    const titleHeading = /^#\s+/.test(line);
    const heading =
      /^\s{0,3}(##|###)\s+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(line);
    if (heading) {
      flush();
      const headingTitle = heading[2];
      if (heading[1] === "##") {
        levelTwo = headingTitle;
        current = {
          section: headingTitle,
          headings: [`# ${title}`, `## ${headingTitle}`],
          body: "",
        };
      } else {
        current = {
          section: levelTwo
            ? `${levelTwo} > ${headingTitle}`
            : headingTitle,
          headings: [
            `# ${title}`,
            ...(levelTwo ? [`## ${levelTwo}`] : []),
            `### ${headingTitle}`,
          ],
          body: "",
        };
      }
      continue;
    }

    if (!titleHeading) {
      current.body += `${line}\n`;
    }
  }
  flush();

  if (sections.length === 0) {
    return [{ section: title, headings: [`# ${title}`], body: "" }];
  }
  return sections;
}

function splitSection(section: MarkdownSection): string[] {
  const context = section.headings.join("\n\n");
  const paragraphs = section.body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return [context];
  }

  const chunks: string[] = [];
  let body = "";
  for (const paragraph of paragraphs) {
    const candidateBody = body ? `${body}\n\n${paragraph}` : paragraph;
    const candidate = `${context}\n\n${candidateBody}`;
    if (body && candidate.length > MAX_CHUNK_CHARACTERS) {
      chunks.push(`${context}\n\n${body}`);
      body = paragraph;
    } else {
      body = candidateBody;
    }
  }
  chunks.push(`${context}\n\n${body}`);
  return chunks;
}

export function chunkMarkdown(
  markdown: string,
  meta: Pick<
    DiscoveredDocument,
    "relativePath" | "category" | "technology" | "title"
  >,
): DocumentChunkDraft[] {
  return parseSections(markdown, meta.title).flatMap((section) =>
    splitSection(section).map((chunkText) => ({
      sourcePath: meta.relativePath,
      documentTitle: meta.title,
      section: section.section,
      category: meta.category,
      technology: meta.technology,
      chunkText,
      chunkHash: createHash("sha256")
        .update(`${meta.relativePath}\0${section.section}\0${chunkText}`)
        .digest("hex"),
    })),
  );
}
