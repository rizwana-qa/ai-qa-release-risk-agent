/**
 * Safe, short error text for provider (Gemini) failures.
 *
 * Provider errors reach the pipeline trace, gate reasons, reports and the PDF. They must never carry
 * credentials, authorization headers, request content or bulky provider diagnostics. This keeps the
 * useful part (an HTTP status and a short provider message) and drops the rest. Pure: it reads the
 * environment only to redact the exact key values it holds, and never prints or returns them.
 */

const MAX_LENGTH = 200;
const SECRET_ENV_VARS = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];

const PATTERNS: Array<[RegExp, string]> = [
  [/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]"],
  [/\bya29\.[0-9A-Za-z._-]{10,}/g, "[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\b(x-goog-api-key|authorization|api[_-]?key|access[_-]?token)\b\s*["']?\s*[:=]\s*["']?[^\s,;&"'}]+/gi, "$1=[redacted]"],
  [/([?&](?:key|api_key|access_token)=)[^&\s"']+/gi, "$1[redacted]"],
  [/(https?:\/\/[^\s"'?)]+)\?[^\s"')]*/g, "$1"], // drop query strings from any URL
];

/** If the message embeds a JSON error body, keep only its status, code and message (drop `details`). */
function summariseJsonBody(text: string): string {
  const start = text.indexOf("{");
  if (start < 0) return text;
  try {
    const body = JSON.parse(text.slice(start)) as { error?: { code?: unknown; status?: unknown; message?: unknown } };
    const e = body?.error;
    if (!e || typeof e !== "object") return text;
    const head = [typeof e.code === "number" || typeof e.code === "string" ? `HTTP ${e.code}` : "", typeof e.status === "string" ? e.status : ""].filter(Boolean).join(" ");
    const message = typeof e.message === "string" ? e.message : "";
    return [text.slice(0, start).trim(), [head, message].filter(Boolean).join(": ")].filter(Boolean).join(" ");
  } catch {
    return text;
  }
}

export function sanitizeProviderError(err: unknown, env: NodeJS.ProcessEnv = process.env): string {
  let text = err instanceof Error ? err.message : typeof err === "string" ? err : "Provider request failed.";
  const status = (err as { status?: unknown } | null)?.status;
  text = summariseJsonBody(String(text));
  for (const name of SECRET_ENV_VARS) {
    const value = env[name]?.trim();
    if (value && value.length >= 8) text = text.split(value).join("[redacted]");
  }
  for (const [re, replacement] of PATTERNS) text = text.replace(re, replacement);
  text = text.replace(/\s+/g, " ").trim();
  if (!text) text = "Provider request failed.";
  if (typeof status === "number" && !/\bHTTP \d{3}\b/.test(text)) text = `HTTP ${status}: ${text}`;
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1)}…` : text;
}
