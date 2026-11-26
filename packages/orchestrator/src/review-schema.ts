import type { ReviewFinding, ReviewReport } from "@osos-reviewer/shared";
import { z } from "zod";

const findingCategoryEnum = z.enum([
  "integration",
  "reusability",
  "symbol_impact",
  "coding_standard",
  "other",
]);

const findingSeverityEnum = z.enum([
  "critical",
  "high",
  "medium",
  "low",
  "info",
]);

const findingConfidenceEnum = z.enum(["confirmed", "potential"]);

const nullableLineNumber = z.number().nullable();

export const reviewFindingSchema: z.ZodType<ReviewFinding> = z.object({
  category: findingCategoryEnum,
  severity: findingSeverityEnum,
  confidence: findingConfidenceEnum,
  title: z.string().min(1),
  description: z.string().min(1),
  evidence: z.string().min(1),
  repo: z.string().optional(),
  filePath: z.string().optional(),
  lineStart: nullableLineNumber.optional(),
  lineEnd: nullableLineNumber.optional(),
  relatedSymbol: z.string().optional(),
  relatedStandard: z.string().optional(),
  suggestedAction: z.string().optional(),
});

export const reviewReportSchema: z.ZodType<ReviewReport> = z.object({
  summary: z.string().min(1),
  findings: z.array(reviewFindingSchema),
});

const FINDING_CATEGORY_VALUES = [
  "integration",
  "reusability",
  "symbol_impact",
  "coding_standard",
  "other",
] as const;

const FINDING_SEVERITY_VALUES = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;

const FINDING_CONFIDENCE_VALUES = ["confirmed", "potential"] as const;

const reviewFindingJsonSchema = {
  type: "object",
  required: [
    "category",
    "severity",
    "confidence",
    "title",
    "description",
    "evidence",
  ],
  additionalProperties: false,
  properties: {
    category: { type: "string", enum: [...FINDING_CATEGORY_VALUES] },
    severity: { type: "string", enum: [...FINDING_SEVERITY_VALUES] },
    confidence: { type: "string", enum: [...FINDING_CONFIDENCE_VALUES] },
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    evidence: { type: "string", minLength: 1 },
    repo: { type: "string" },
    filePath: { type: "string" },
    lineStart: { type: ["number", "null"] },
    lineEnd: { type: ["number", "null"] },
    relatedSymbol: { type: "string" },
    relatedStandard: { type: "string" },
    suggestedAction: { type: "string" },
  },
} as const;

export const REVIEW_OUTPUT_JSON_SCHEMA = {
  type: "object",
  required: ["summary", "findings"],
  additionalProperties: false,
  properties: {
    summary: { type: "string", minLength: 1 },
    findings: {
      type: "array",
      items: reviewFindingJsonSchema,
    },
  },
} as const;

export function parseReviewReport(input: unknown): ReviewReport {
  return reviewReportSchema.parse(input);
}