import type { IncomingMessage, ServerResponse } from "node:http";
import { runCustomAssessmentInProcess, sendJson, readBody, parseJsonBody, MAX_BODY_BYTES } from "../_vercelShared.ts";
import type { RawAssessmentPayload } from "../inputNormalizer.ts";

/**
 * Vercel equivalent of the local POST /api/assess/custom. Always runs and
 * returns the full result directly (the `runId` + separate SSE-stream
 * two-request handshake the local server uses cannot rely on shared
 * in-memory state across serverless invocations, so this deployment skips
 * straight to the same blocking result the local `?blocking=1` mode already
 * produces — same validation, same fallback rule, same response shape).
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return sendJson(res, 404, { error: "not found" });

  const raw = await readBody(req);
  if (raw === null) return sendJson(res, 413, { ok: false, error: `request body exceeds ${MAX_BODY_BYTES} bytes` });

  const body = parseJsonBody(raw);
  if (!body) return sendJson(res, 400, { ok: false, error: "expected a JSON object body" });

  const outcome = await runCustomAssessmentInProcess(body as RawAssessmentPayload);
  if (!outcome.ok) {
    return sendJson(res, outcome.status, { ok: false, missing: outcome.missing, problems: outcome.problems });
  }
  sendJson(res, 200, { ok: true, ...outcome.result });
}
