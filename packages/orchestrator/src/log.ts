const SECRET_KEY = /password|token|secret|authorization/i;
/** Noisy identity fields — omit from terminal lines (still usable by callers). */
const OMIT_TERMINAL_KEYS = new Set(["component", "reviewId"]);

function omitSecretFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY.test(key) || OMIT_TERMINAL_KEYS.has(key)) {
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

export type LogOptions = {
  /** When false, skip logger base fields (e.g. component). Default true. */
  base?: boolean;
};

export function createLogger(base: Record<string, unknown> = {}) {
  const write = (
    level: string,
    msg: string,
    fields?: Record<string, unknown>,
    options?: LogOptions,
  ) => {
    const useBase = options?.base !== false;
    const merged = {
      ...(useBase ? omitSecretFields(base) : {}),
      ...(fields ? omitSecretFields(fields) : {}),
    };
    const extras = formatFields(merged);
    const line = extras
      ? `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}  ${extras}`
      : `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
    process.stdout.write(`${line}\n`);
  };

  return {
    info(msg: string, fields?: Record<string, unknown>, options?: LogOptions) {
      write("info", msg, fields, options);
    },
    warn(msg: string, fields?: Record<string, unknown>, options?: LogOptions) {
      write("warn", msg, fields, options);
    },
    error(msg: string, fields?: Record<string, unknown>, options?: LogOptions) {
      write("error", msg, fields, options);
    },
  };
}

export type ReviewLogger = ReturnType<typeof createLogger>;
