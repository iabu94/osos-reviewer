import { describe, it, expect } from "vitest";
import { extractTicketId, resolveCompanionBranch } from "../src/companion.js";
import { TicketUnresolvedError } from "@review/shared";

describe("extractTicketId", () => {
  it("extracts Centroniz-style tickets from branch names", () => {
    expect(extractTicketId("feature/ABC-123-login", /[A-Z]+-\d+/)).toBe(
      "ABC-123",
    );
  });
  it("returns null when no ticket present", () => {
    expect(extractTicketId("feature/login", /[A-Z]+-\d+/)).toBeNull();
  });
});

describe("resolveCompanionBranch", () => {
  it("selects the branch containing the ticket id", () => {
    const r = resolveCompanionBranch({
      branches: ["origin/develop", "origin/feature/ABC-123-ui"],
      ticketId: "ABC-123",
      fallbackBranch: "origin/develop",
    });
    expect(r).toEqual({
      branch: "origin/feature/ABC-123-ui",
      usedFallback: false,
      reason: "ticket_match",
    });
  });

  it("falls back when no companion branch matches", () => {
    const r = resolveCompanionBranch({
      branches: ["origin/develop", "origin/feature/OTHER-1"],
      ticketId: "ABC-123",
      fallbackBranch: "origin/develop",
    });
    expect(r.usedFallback).toBe(true);
    expect(r.branch).toBe("origin/develop");
    expect(r.reason).toBe("no_ticket_branch");
  });

  it("throws when ticket is unresolved", () => {
    expect(() =>
      resolveCompanionBranch({
        branches: ["origin/develop"],
        ticketId: null,
        fallbackBranch: "origin/develop",
      }),
    ).toThrow(TicketUnresolvedError);
  });
});
