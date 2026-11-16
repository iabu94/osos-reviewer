import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(pool: Pool): Promise<void> {
  const sqlPath = join(here, "sql", "001_extensions.sql");
  const sql = await readFile(sqlPath, "utf8");
  await pool.query(sql);
}
