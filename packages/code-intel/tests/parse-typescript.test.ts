import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTypeScriptFile } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

function readFixture(name: string): string {
  return readFileSync(join(here, "..", "fixtures", name), "utf8");
}

describe("parseTypeScriptFile", () => {
  it("parses Angular OrderService HttpClient calls and interface", () => {
    const source = readFixture("angular/order.service.ts");
    const result = parseTypeScriptFile({
      filePath: "src/app/order.service.ts",
      sourceText: source,
    });
    expect(result.errors).toEqual([]);
    expect(
      result.symbols.some((s) => s.symbolType === "angular_service" && s.symbolName === "OrderService"),
    ).toBe(true);
    const http = result.symbols.find((s) => s.symbolType === "http_call");
    expect(http?.metadata).toMatchObject({ httpMethod: "GET", path: "/api/orders" });
    expect(result.relationships.some((r) => r.relationshipType === "http_calls")).toBe(true);
    const methods = result.symbols
      .filter((s) => s.symbolType === "http_call")
      .map((s) => (s.metadata as { httpMethod: string }).httpMethod);
    expect(methods).toEqual(["GET", "GET", "POST", "DELETE"]);
    expect(
      result.relationships.find((r) => r.relationshipType === "http_calls" && r.targetName === "/api/orders"),
    ).toMatchObject({ sourceName: "OrderService.list" });
  });

  it("parses component and interface from fixtures", () => {
    const model = parseTypeScriptFile({
      filePath: "order.model.ts",
      sourceText: readFixture("angular/order.model.ts"),
    });
    expect(model.symbols.some((s) => s.symbolType === "interface" && s.symbolName === "OrderDto")).toBe(true);

    const comp = parseTypeScriptFile({
      filePath: "order-list.component.ts",
      sourceText: readFixture("angular/order-list.component.ts"),
    });
    const component = comp.symbols.find((s) => s.symbolType === "component");
    expect(component?.symbolName).toBe("OrderListComponent");
    expect(component?.metadata).toMatchObject({
      selector: "app-order-list",
      inputs: expect.arrayContaining(["customerId"]),
      outputs: expect.arrayContaining(["selected"]),
    });
    expect(
      comp.relationships.filter((r) => r.relationshipType === "injects" && r.targetName === "OrderService").length,
    ).toBeGreaterThanOrEqual(1);
    expect(comp.relationships.every((r) => r.relationshipType !== "injects" || r.sourceName === "OrderListComponent")).toBe(true);
    const signals = comp.symbols.filter((s) => s.symbolType === "signal").map((s) => s.symbolName);
    expect(signals).toEqual(expect.arrayContaining(["OrderListComponent.orders", "OrderListComponent.pageSize", "OrderListComponent.refreshed"]));
  });

  it("dto/interface metadata includes property names", () => {
    const model = parseTypeScriptFile({
      filePath: "order.model.ts",
      sourceText: readFixture("angular/order.model.ts"),
    });
    const iface = model.symbols.find((s) => s.symbolType === "interface" && s.symbolName === "OrderDto");
    expect(iface?.metadata?.properties).toEqual(
      expect.arrayContaining(["id", "customerName", "total"]),
    );
  });

  it("reports no errors for empty input", () => {
    const r = parseTypeScriptFile({ filePath: "x.ts", sourceText: "" });
    expect(r).toEqual({ symbols: [], relationships: [], errors: [] });
  });
});
