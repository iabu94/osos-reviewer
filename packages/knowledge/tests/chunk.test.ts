import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { chunkMarkdown } from "../src/index.js";

const meta = {
  relativePath: "coding-standards/angular/components.md",
  category: "coding-standards" as const,
  technology: "angular" as const,
  title: "Components",
};

describe("chunkMarkdown", () => {
  it("preserves section heading in chunks", () => {
    const chunks = chunkMarkdown(
      "# Components\n\n## Change detection\n\nPrefer OnPush change detection.\n",
      meta,
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0].section).toBe("Change detection");
    expect(chunks[0].chunkText).toContain("## Change detection");
    expect(chunks[0].chunkText).toContain("Prefer OnPush");
    expect(chunks[0].chunkHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses nested heading breadcrumbs for level-three sections", () => {
    const chunks = chunkMarkdown(
      [
        "# Components",
        "",
        "## Change detection",
        "",
        "Overview.",
        "",
        "### OnPush",
        "",
        "Use immutable inputs.",
      ].join("\n"),
      meta,
    );

    expect(chunks.map((chunk) => chunk.section)).toEqual([
      "Change detection",
      "Change detection > OnPush",
    ]);
    expect(chunks[1].chunkText).toContain("## Change detection");
    expect(chunks[1].chunkText).toContain("### OnPush");
    expect(chunks[1].chunkText).toContain("Use immutable inputs.");
  });

  it("returns one document chunk when there are no subheadings", () => {
    const chunks = chunkMarkdown(
      "# Components\n\nPrefer small, focused components.\n",
      meta,
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      sourcePath: meta.relativePath,
      documentTitle: meta.title,
      section: meta.title,
      category: meta.category,
      technology: meta.technology,
    });
    expect(chunks[0].chunkText).toContain("Prefer small, focused components.");
  });

  it("does not split on heading-like text inside fenced code", () => {
    const chunks = chunkMarkdown(
      "# Components\n\n## Examples\n\n```md\n## Not a section\n```\n",
      meta,
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0].section).toBe("Examples");
    expect(chunks[0].chunkText).toContain("## Not a section");
  });

  it("soft-splits long sections on paragraph boundaries with context", () => {
    const paragraphs = Array.from(
      { length: 8 },
      (_, index) => `Paragraph ${index + 1}: ${"x".repeat(180)}.`,
    );
    const chunks = chunkMarkdown(
      `# Components\n\n## Guidance\n\n${paragraphs.join("\n\n")}\n`,
      meta,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.chunkText.includes("## Guidance"))).toBe(
      true,
    );
    expect(chunks.map((chunk) => chunk.chunkText).join("\n")).toContain(
      paragraphs[7],
    );
  });

  it("hashes source path, section, and chunk text", () => {
    const [chunk] = chunkMarkdown(
      "# Components\n\n## Guidance\n\nUse clear inputs.\n",
      meta,
    );
    const expectedHash = createHash("sha256")
      .update(`${meta.relativePath}\0Guidance\0${chunk.chunkText}`)
      .digest("hex");

    expect(chunk.chunkHash).toBe(expectedHash);
  });
});
