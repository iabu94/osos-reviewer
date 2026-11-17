import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { discoverDocuments } from "../src/index.js";

const fixtureRoots: string[] = [];

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "review-knowledge-"));
  fixtureRoots.push(root);
  return root;
}

async function writeMarkdown(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const absolutePath = join(root, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("discoverDocuments", () => {
  it("maps coding-standards/angular/components.md metadata", async () => {
    const root = await createFixtureRoot();
    await writeMarkdown(
      root,
      "coding-standards/angular/components.md",
      "# Angular Components\n\nPrefer standalone components.\n",
    );

    const docs = await discoverDocuments(root);

    expect(docs).toEqual([
      {
        absolutePath: join(
          root,
          "coding-standards/angular/components.md",
        ),
        relativePath: "coding-standards/angular/components.md",
        category: "coding-standards",
        technology: "angular",
        title: "Angular Components",
      },
    ]);
  });

  it("uses general and the filename stem when metadata is absent", async () => {
    const root = await createFixtureRoot();
    await writeMarkdown(
      root,
      "architecture/system-overview.md",
      "An overview without a level-one heading.\n",
    );

    const docs = await discoverDocuments(root);

    expect(docs[0]).toMatchObject({
      relativePath: "architecture/system-overview.md",
      category: "architecture",
      technology: "general",
      title: "system-overview",
    });
  });

  it("does not treat headings inside fenced code as the document title", async () => {
    const root = await createFixtureRoot();
    await writeMarkdown(
      root,
      "security/example.md",
      "```md\n# Not the title\n```\n\n# Actual title\n",
    );

    const docs = await discoverDocuments(root);

    expect(docs[0].title).toBe("Actual title");
  });

  it("ignores non-Markdown files and unknown top-level directories", async () => {
    const root = await createFixtureRoot();
    await writeMarkdown(root, "security/database/access.md", "# Access\n");
    await writeMarkdown(root, "security/database/notes.txt", "not markdown\n");
    await writeMarkdown(root, "misc/angular/ignored.md", "# Ignored\n");

    const docs = await discoverDocuments(root);

    expect(docs.map((doc) => doc.relativePath)).toEqual([
      "security/database/access.md",
    ]);
  });
});
