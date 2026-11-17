import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { discoverSourceFiles, parseSourceFile } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDotnetRoot = join(here, "..", "fixtures", "dotnet");
const fixtureAngularRoot = join(here, "..", "fixtures", "angular");

describe("discoverSourceFiles", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "code-intel-discover-"));
    const files: Record<string, string> = {
      "src/A.cs": "class A {}",
      "bin/Debug/B.cs": "class B {}",
      "obj/C.cs": "class C {}",
      "src/obj/D.cs": "class D {}",
      "web/a.ts": "export const a = 1;",
      "web/b.tsx": "export const b = 1;",
      "web/types.d.ts": "export type T = 1;",
      "node_modules/pkg/index.ts": "export {};",
      "dist/out.ts": "export {};",
      "web/readme.md": "# hi",
    };
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, body, "utf8");
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds cs and skips bin", async () => {
    const files = await discoverSourceFiles({
      rootDir: fixtureDotnetRoot,
      role: "backend",
    });
    expect(files.some((f) => f.endsWith("OrdersController.cs"))).toBe(true);
    expect(files.every((f) => !f.includes("/bin/"))).toBe(true);
  });

  it("backend excludes bin/obj and non-cs files", async () => {
    const files = await discoverSourceFiles({ rootDir: root, role: "backend" });
    expect(files).toEqual(["src/A.cs"]);
  });

  it("frontend finds ts/tsx and excludes node_modules, dist, d.ts", async () => {
    const files = await discoverSourceFiles({ rootDir: root, role: "frontend" });
    expect(files).toEqual(["web/a.ts", "web/b.tsx"]);
  });

  it("returns relative paths for the angular fixtures", async () => {
    const files = await discoverSourceFiles({
      rootDir: fixtureAngularRoot,
      role: "frontend",
    });
    expect(files).toContain("order.service.ts");
  });
});

describe("parseSourceFile", () => {
  it("dispatches by extension", () => {
    const cs = parseSourceFile({
      filePath: "A.cs",
      sourceText: "public class OrderService { public void List() {} }",
    });
    expect(cs.symbols.length).toBeGreaterThan(0);
    const ts = parseSourceFile({
      filePath: "a.service.ts",
      sourceText:
        "import { Injectable } from '@angular/core';\n@Injectable({ providedIn: 'root' })\nexport class FooService {}\n",
    });
    expect(ts.errors).toEqual([]);
  });

  it("reports unsupported extensions", () => {
    expect(parseSourceFile({ filePath: "x.py", sourceText: "" })).toEqual({
      symbols: [],
      relationships: [],
      errors: ["unsupported"],
    });
  });
});
