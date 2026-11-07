const SENSITIVE_KEY = /token|secret|authorization|password|api_key|sender_key|bearer|file_id|fileid|file_path|filepath/i;

export function safeErrorMessage(err: unknown, secrets: readonly string[]): string {
  let message = err instanceof Error ? err.message : "unknown error";
  for (const secret of secrets) {
    if (secret && secret.length >= 4) message = message.split(secret).join("[redacted]");
  }
  message = message.replace(/\/bot[^/\s]+(?:\/\S*)?/gi, "/bot[redacted]");
  message = message.replace(/https:\/\/api\.telegram\.org\/file\/\S+/gi, "https://api.telegram.org/file/[redacted]");
  message = message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  return message.slice(0, 300);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[max-depth]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(inner, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  }
  return value;
}

export type Logger = (event: Record<string, unknown>) => void;

export function createLogger(secrets: readonly string[], write: (line: string) => void = (line) => console.log(line)): Logger {
  return (event) => {
    const payload = redact({ ...event, ts: new Date().toISOString() }) as Record<string, unknown>;
    let line = JSON.stringify(payload);
    for (const secret of secrets) {
      if (secret && secret.length >= 4) line = line.split(secret).join("[redacted]");
    }
    line = line.replace(/\/bot[^/\s"]+(?:\/[^"\s]*)?/gi, "/bot[redacted]");
    line = line.replace(/https:\/\/api\.telegram\.org\/file\/\S+/gi, "https://api.telegram.org/file/[redacted]");
    write(line);
  };
}

export function collectSecrets(values: readonly string[]): string[] {
  return values.filter((value) => value.length >= 4);
}
