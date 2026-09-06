import type { IncomingMessage, ServerResponse } from "node:http";
import { getMeta } from "../pipelineRunner.ts";
import { sendJson } from "../_vercelShared.ts";

/**
 * Same payload as the local /api/meta, plus `streaming: false` so the
 * frontend (web/app.js) knows to use the existing blocking-result code path
 * instead of opening an EventSource — this deployment has no SSE routes.
 * getMeta() itself is untouched; the extra field is added only here.
 */
export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { ...getMeta(), streaming: false });
}
