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

export function createLogger(base: Record<string, unknown> = {}) {
  const write = (level: string, msg: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      msg,
      ...omitSecretFields(base),
      ...(fields ? omitSecretFields(fields) : {}),
    });
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