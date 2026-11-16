import { TicketUnresolvedError } from "@review/shared";

export function extractTicketId(
  text: string,
  pattern: RegExp,
): string | null {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const match = re.exec(text);
  return match ? match[0] : null;
}

export function resolveCompanionBranch(input: {
  branches: string[];
  ticketId: string | null;
  fallbackBranch: string;
}): { branch: string; usedFallback: boolean; reason: string } {
  if (input.ticketId === null) {
    throw new TicketUnresolvedError();
  }

  const matches = input.branches
    .filter((b) => b.includes(input.ticketId!))
    .sort((a, b) => a.localeCompare(b));

  if (matches.length === 0) {
    return {
      branch: input.fallbackBranch,
      usedFallback: true,
      reason: "no_ticket_branch",
    };
  }

  if (matches.length > 1) {
    return {
      branch: matches[0]!,
      usedFallback: false,
      reason: "ticket_match_ambiguous_first",
    };
  }

  return {
    branch: matches[0]!,
    usedFallback: false,
    reason: "ticket_match",
  };
}
