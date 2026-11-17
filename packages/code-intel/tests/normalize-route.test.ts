import { describe, expect, it } from "vitest";
import { httpContractKey, normalizeRoutePath } from "../src/normalize-route.js";

describe("normalizeRoutePath", () => {
  it("normalizes ASP.NET and Angular path templates to the same key", () => {
    expect(httpContractKey("GET", "/api/orders/{id:int}")).toBe(
      httpContractKey("get", "/api/orders/${id}"),
    );
    expect(normalizeRoutePath("API/Orders/")).toBe("api/orders");
  });
});