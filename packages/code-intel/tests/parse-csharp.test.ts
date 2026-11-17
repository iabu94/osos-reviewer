import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCSharpFile } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

function readFixture(name: string): string {
  return readFileSync(join(here, "..", "fixtures", name), "utf8");
}

describe("parseCSharpFile", () => {
  it("parses controller endpoints and DTO", () => {
    const result = parseCSharpFile({
      filePath: "OrdersController.cs",
      sourceText: readFixture("dotnet/OrdersController.cs"),
    });
    expect(result.errors).toEqual([]);
    expect(result.symbols.some((s) => s.symbolType === "controller" && /OrdersController/.test(s.symbolName))).toBe(true);
    const ep = result.symbols.find((s) => s.symbolType === "endpoint");
    expect(ep?.metadata).toMatchObject({ httpMethod: "GET" });
    expect(String(ep?.metadata?.route ?? "")).toMatch(/orders/i);
  });

  it("combines class route and method templates for every endpoint", () => {
    const result = parseCSharpFile({
      filePath: "OrdersController.cs",
      sourceText: readFixture("dotnet/OrdersController.cs"),
    });
    const eps = result.symbols
      .filter((s) => s.symbolType === "endpoint")
      .map((s) => [s.symbolName, (s.metadata as { httpMethod: string }).httpMethod, (s.metadata as { route: string }).route]);
    expect(eps).toEqual([
      ["OrdersController.List", "GET", "api/orders"],
      ["OrdersController.Get", "GET", "api/orders/{id:int}"],
      ["OrdersController.Create", "POST", "api/orders"],
      ["OrdersController.Delete", "DELETE", "api/orders/{id:int}"],
    ]);
    expect(
      result.relationships.some(
        (r) =>
          r.relationshipType === "exposes" &&
          r.sourceType === "controller" &&
          r.sourceName === "OrdersController" &&
          r.targetName === "api/orders",
      ),
    ).toBe(true);
    expect(
      result.relationships.some(
        (r) =>
          r.relationshipType === "exposes" &&
          r.sourceType === "endpoint" &&
          r.sourceName === "OrdersController.Get" &&
          r.targetName === "api/orders/{id:int}",
      ),
    ).toBe(true);
  });

  it("parses DTO record and Dto-suffixed class", () => {
    const result = parseCSharpFile({
      filePath: "Models/OrderDto.cs",
      sourceText: readFixture("dotnet/OrderDto.cs"),
    });
    const dtos = result.symbols.filter((s) => s.symbolType === "dto").map((s) => s.symbolName);
    expect(dtos).toEqual(["OrderDto", "OrderSummaryDto"]);
  });

  it("dto/interface metadata includes property names", () => {
    const result = parseCSharpFile({
      filePath: "Models/OrderDto.cs",
      sourceText: readFixture("dotnet/OrderDto.cs"),
    });
    const dto = result.symbols.find((s) => s.symbolType === "dto" && s.symbolName === "OrderDto");
    expect(dto?.metadata?.properties).toEqual(expect.arrayContaining(["Id", "CustomerId", "Total"]));
  });

  it("parses service public methods only", () => {
    const result = parseCSharpFile({
      filePath: "OrderService.cs",
      sourceText: readFixture("dotnet/OrderService.cs"),
    });
    const names = result.symbols.filter((s) => s.symbolType === "service_method").map((s) => s.symbolName);
    expect(names).toEqual([
      "OrderService.ListAsync",
      "OrderService.GetAsync",
      "OrderService.CreateAsync",
      "OrderService.DeleteAsync",
    ]);
  });

  it("parses FluentValidation and entity", () => {
    const v = parseCSharpFile({
      filePath: "OrderValidator.cs",
      sourceText: readFixture("dotnet/OrderValidator.cs"),
    });
    expect(v.symbols.some((s) => s.symbolType === "validation_rule")).toBe(true);
    expect(v.relationships.some((r) => r.relationshipType === "validates" && r.targetName === "OrderDto")).toBe(true);

    const e = parseCSharpFile({ filePath: "Order.cs", sourceText: readFixture("dotnet/Order.cs") });
    const entity = e.symbols.find((s) => s.symbolType === "entity");
    expect(entity?.symbolName).toBe("Order");
    expect(entity?.metadata).toMatchObject({ keys: ["Id"] });
  });

  it("parses DbContext and entity type configuration", () => {
    const result = parseCSharpFile({
      filePath: "AppDbContext.cs",
      sourceText: readFixture("dotnet/AppDbContext.cs"),
    });
    const names = result.symbols.filter((s) => s.symbolType === "dbcontext_config").map((s) => s.symbolName);
    expect(names).toEqual(["AppDbContext", "OrderConfiguration"]);
    expect(
      result.relationships.some((r) => r.relationshipType === "maps_to" && r.sourceName === "OrderConfiguration" && r.targetName === "Order"),
    ).toBe(true);
  });

  it("returns an errors entry for syntax errors without throwing", () => {
    const result = parseCSharpFile({
      filePath: "Broken.cs",
      sourceText: "namespace X; public class Broken { public void Oops( { ",
    });
    expect(result.symbols).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("parseCSharpFile robustness", () => {
  it("handles sources larger than the default tree-sitter buffer", () => {
    const filler = Array.from({ length: 4000 }, (_, i) => `    public int P${i} { get; set; }`).join("\n");
    const result = parseCSharpFile({
      filePath: "Models/Big.cs",
      sourceText: `namespace X;\npublic class BigDto\n{\n${filler}\n}\n`,
    });
    expect(result.errors).toEqual([]);
    expect(result.symbols.map((s) => s.symbolName)).toEqual(["BigDto"]);
  });
});
