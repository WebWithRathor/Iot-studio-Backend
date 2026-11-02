/**
 * Log redaction. Applied to every log entry's metadata by the logger format,
 * so callers cannot accidentally write secrets to logs.
 */
const SENSITIVE_KEY = /pass(word)?|secret|token|jwt|cookie|authorization|auth[-_]?header|refresh|session[-_]?key|api[-_]?key|private[-_]?key|credential|encryption[-_]?key|set-cookie/i;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const URI_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi;

const MAX_STRING = 500;
const MAX_DEPTH = 5;
const MAX_KEYS = 40;

export const REDACTED = '[REDACTED]';

export function redactString(s: string): string {
  let out = s.replace(JWT_LIKE, REDACTED).replace(URI_CREDENTIALS, `$1${REDACTED}@`);
  if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}…(+${out.length - MAX_STRING} chars)`;
  return out;
}

export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(value);
  if (Array.isArray(value)) {
    const arr = value.slice(0, 20).map((v) => redact(v, depth + 1, seen));
    if (value.length > 20) arr.push(`…(+${value.length - 20} items)`);
    return arr;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [k, v] of entries.slice(0, MAX_KEYS)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1, seen);
  }
  if (entries.length > MAX_KEYS) out['…'] = `+${entries.length - MAX_KEYS} keys`;
  return out;
}

/** Summarise an MQTT payload for logs without writing the whole body. */
export function summarisePayload(payload: string, max = 120): string {
  return payload.length > max ? `${redactString(payload.slice(0, max))}…(${payload.length} bytes)` : redactString(payload);
}
