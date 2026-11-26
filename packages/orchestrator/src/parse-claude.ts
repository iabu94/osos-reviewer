import {
  NO_FINDINGS_SUMMARY,
  type ReviewDiagnostics,
  type ReviewReport,
} from "@osos-reviewer/shared";
import { ZodError } from "zod";
import { parseReviewReport } from "./review-schema.js";

const ERROR_SUBTYPES = new Set([
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
]);

interface ClaudeEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export type ParseClaudeSuccess = {
  ok: true;
  report: ReviewReport;
  diagnostics: ReviewDiagnostics;
  raw: unknown;
};

export type ParseClaudeFailure = {
  ok: false;
  code: "invalid_review_output" | "claude_envelope_error";
  message: string;
  diagnostics?: ReviewDiagnostics;
  raw?: unknown;
};

function mapDiagnostics(envelope: ClaudeEnvelope): ReviewDiagnostics {
  const diagnostics: ReviewDiagnostics = {};
  if (envelope.duration_ms !== undefined) {
    diagnostics.durationMs = envelope.duration_ms;
  }
  if (envelope.duration_api_ms !== undefined) {
    diagnostics.durationApiMs = envelope.duration_api_ms;
  }
  if (envelope.num_turns !== undefined) {
    diagnostics.numTurns = envelope.num_turns;
  }
  if (envelope.session_id !== undefined) {
    diagnostics.sessionId = envelope.session_id;
  }
  if (envelope.total_cost_usd !== undefined) {
    diagnostics.totalCostUsd = envelope.total_cost_usd;
  }
  const usage = envelope.usage;
  if (usage?.input_tokens !== undefined) {
    diagnostics.inputTokens = usage.input_tokens;
  }
  if (usage?.output_tokens !== undefined) {
    diagnostics.outputTokens = usage.output_tokens;
  }
  if (usage?.cache_read_input_tokens !== undefined) {
    diagnostics.cacheReadTokens = usage.cache_read_input_tokens;
  }
  if (usage?.cache_creation_input_tokens !== undefined) {
    diagnostics.cacheCreationTokens = usage.cache_creation_input_tokens;
  }
  return diagnostics;
}

function isEnvelopeError(envelope: ClaudeEnvelope): boolean {
  if (envelope.is_error === true) {
    return true;
  }
  return (
    envelope.subtype !== undefined && ERROR_SUBTYPES.has(envelope.subtype)
  );
}

export function parseClaudeReviewOutput(
  stdout: string,
): ParseClaudeSuccess | ParseClaudeFailure {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return {
      ok: false,
      code: "invalid_review_output",
      message: "Claude stdout is not JSON",
    };
  }

  const envelope = raw as ClaudeEnvelope;
  const diagnostics = mapDiagnostics(envelope);

  if (isEnvelopeError(envelope)) {
    const message =
      typeof envelope.result === "string" && envelope.result.length > 0
        ? envelope.result
        : (envelope.subtype ?? "Claude review failed");
    return {
      ok: false,
      code: "claude_envelope_error",
      message,
      diagnostics,
      raw,
    };
  }

  if (
    envelope.structured_output === undefined ||
    envelope.structured_output === null
  ) {
    return {
      ok: false,
      code: "invalid_review_output",
      message: "missing structured_output",
      diagnostics,
      raw,
    };
  }

  let report: ReviewReport;
  try {
    report = parseReviewReport(envelope.structured_output);
  } catch (err) {
    const message =
      err instanceof ZodError ? err.message : "Invalid review output";
    return {
      ok: false,
      code: "invalid_review_output",
      message,
      diagnostics,
      raw,
    };
  }

  if (report.findings.length === 0) {
    report = { ...report, summary: NO_FINDINGS_SUMMARY };
  }

  return {
    ok: true,
    report,
    diagnostics,
    raw,
  };
}