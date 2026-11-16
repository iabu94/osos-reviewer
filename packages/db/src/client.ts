import pg from "pg";
import { migrate } from "./migrate.js";

const { Pool } = pg;

export type { Pool };

export function createPool(databaseUrl: string): pg.Pool {
  return new Pool({ connectionString: databaseUrl });
}

export async function healthCheck(
  pool: pg.Pool,
): Promise<{ ok: true; vector: boolean }> {
  const result = await pool.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
  );
  return { ok: true, vector: result.rowCount === 1 };
}

export { migrate };
