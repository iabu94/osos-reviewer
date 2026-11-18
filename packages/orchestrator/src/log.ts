const SECRET_KEY = /password|token|secret|authorization/i;

function omitSecretFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY.test(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    return /\s/.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function formatFields(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

export function createLogger(base: Record<string, unknown> = {}) {
  const write = (level: string, msg: string, fields?: Record<string, unknown>) => {
    const merged = {
      ...omitSecretFields(base),
      ...(fields ? omitSecretFields(fields) : {}),
    };
    const extras = formatFields(merged);
    const line = extras
      ? `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}  ${extras}`
      : `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
    process.stdout.write(`${line}\n`);
  };

  return {
    info(msg: string, fields?: Record<string, unknown>) {
      write("info", msg, fields);
    },
    warn(msg: string, fields?: Record<string, unknown>) {
      write("warn", msg, fields);
    },
    error(msg: string, fields?: Record<string, unknown>) {
      write("error", msg, fields);
    },
  };
}

export type ReviewLogger = ReturnType<typeof createLogger>;
