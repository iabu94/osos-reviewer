import type {
  ReviewLifecycleStatus,
  ReviewResult,
  TeamsConversationRef,
} from "@osos-reviewer/shared";
import type { Pool } from "pg";

export interface ReviewRow {
  id: string;
  idempotency_key: string;
  pr_url: string;
  status: ReviewLifecycleStatus;
  teams_conversation_ref: TeamsConversationRef | null;
  result: ReviewResult | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  diagnostics: ReviewResult["diagnostics"] | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

type ClaimReviewInput = {
  reviewId: string;
  idempotencyKey: string;
  prUrl: string;
  teamsConversationRef: TeamsConversationRef | null;
};

type ClaimReviewResult =
  | { kind: "created"; reviewId: string }
  | {
      kind: "existing";
      reviewId: string;
      status: ReviewLifecycleStatus;
    };

const REVIEW_ROW_SELECT = `
  SELECT
    id,
    idempotency_key,
    pr_url,
    status,
    teams_conversation_ref,
    result,
    error_code,
    error_message,
    attempt_count,
    diagnostics,
    created_at,
    updated_at,
    completed_at
  FROM reviews
`;

function rowFromDb(row: Record<string, unknown>): ReviewRow {
  return {
    id: row.id as string,
    idempotency_key: row.idempotency_key as string,
    pr_url: row.pr_url as string,
    status: row.status as ReviewLifecycleStatus,
    teams_conversation_ref: (row.teams_conversation_ref as TeamsConversationRef | null) ?? null,
    result: (row.result as ReviewResult | null) ?? null,
    error_code: (row.error_code as string | null) ?? null,
    error_message: (row.error_message as string | null) ?? null,
    attempt_count: row.attempt_count as number,
    diagnostics: (row.diagnostics as ReviewResult["diagnostics"] | null) ?? null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    completed_at: (row.completed_at as Date | null) ?? null,
  };
}

export async function claimReview(
  pool: Pool,
  input: ClaimReviewInput,
): Promise<ClaimReviewResult> {
  try {
    await pool.query(
      `INSERT INTO reviews (id, idempotency_key, pr_url, status, teams_conversation_ref)
       VALUES ($1, $2, $3, 'accepted', $4)`,
      [
        input.reviewId,
        input.idempotencyKey,
        input.prUrl,
        input.teamsConversationRef
          ? JSON.stringify(input.teamsConversationRef)
          : null,
      ],
    );
    return { kind: "created", reviewId: input.reviewId };
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") {
      throw error;
    }
    const existing = await getReviewByIdempotencyKey(pool, input.idempotencyKey);
    if (!existing) {
      throw error;
    }
    return {
      kind: "existing",
      reviewId: existing.id,
      status: existing.status,
    };
  }
}

export async function markReviewRunning(pool: Pool, reviewId: string): Promise<void> {
  await pool.query(
    `UPDATE reviews
     SET status = 'running',
         attempt_count = attempt_count + 1,
         updated_at = NOW()
     WHERE id = $1`,
    [reviewId],
  );
}

export async function markReviewFinished(
  pool: Pool,
  reviewId: string,
  result: ReviewResult,
): Promise<void> {
  await pool.query(
    `UPDATE reviews
     SET status = $2,
         result = $3::jsonb,
         error_code = $4,
         error_message = $5,
         diagnostics = $6::jsonb,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [
      reviewId,
      result.status,
      JSON.stringify(result),
      result.error?.code ?? null,
      result.error?.message ?? null,
      result.diagnostics ? JSON.stringify(result.diagnostics) : null,
    ],
  );
}

export async function getReviewByIdempotencyKey(
  pool: Pool,
  key: string,
): Promise<ReviewRow | null> {
  const { rows } = await pool.query(
    `${REVIEW_ROW_SELECT} WHERE idempotency_key = $1`,
    [key],
  );
  if (rows.length === 0) {
    return null;
  }
  return rowFromDb(rows[0] as Record<string, unknown>);
}