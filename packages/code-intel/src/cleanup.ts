import type { Pool } from "pg";

/** Deletes every PR-scoped symbol for a review (relationships cascade). Baseline rows have NULL review_id and are never matched. */
export async function cleanupPrIndex(
  pool: Pool,
  reviewId: string,
): Promise<{ symbolsDeleted: number }> {
  const result = await pool.query(
    `DELETE FROM code_symbols WHERE index_scope = 'pr' AND review_id = $1`,
    [reviewId],
  );
  return { symbolsDeleted: result.rowCount ?? 0 };
}
