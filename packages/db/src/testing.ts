import pg from "pg";

/**
 * Database URL for suites that mutate/TRUNCATE data. Never falls back to
 * DATABASE_URL, and refuses to return the same database as DATABASE_URL so
 * tests cannot wipe the real index.
 */
export function resolveTestDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const testUrl = env.TEST_DATABASE_URL;
  if (!testUrl) {
    return undefined;
  }
  if (env.DATABASE_URL && sameDatabase(testUrl, env.DATABASE_URL)) {
    throw new Error(
      "TEST_DATABASE_URL must differ from DATABASE_URL (tests truncate tables)",
    );
  }
  return testUrl;
}

function sameDatabase(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return (
      left.hostname === right.hostname &&
      (left.port || "5432") === (right.port || "5432") &&
      left.pathname === right.pathname
    );
  } catch {
    return a === b;
  }
}

/** Creates the database named in `databaseUrl` if it does not exist yet. */
export async function ensureDatabase(databaseUrl: string): Promise<void> {
  const target = new URL(databaseUrl);
  const name = decodeURIComponent(target.pathname.replace(/^\//, ""));
  if (!name) {
    throw new Error("Database URL must include a database name");
  }
  const admin = new URL(databaseUrl);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [name],
    );
    if (exists.rowCount === 0) {
      try {
        await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
      } catch (error) {
        // Lost a race with a parallel creator.
        if ((error as { code?: string }).code !== "42P04") throw error;
      }
    }
  } finally {
    await client.end();
  }
}
