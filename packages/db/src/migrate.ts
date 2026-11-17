import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(pool: Pool): Promise<void> {
  const sqlDir = join(here, "sql");
  const files = (await readdir(sqlDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = await readFile(join(sqlDir, file), "utf8");
    await pool.query(sql);
  }
}