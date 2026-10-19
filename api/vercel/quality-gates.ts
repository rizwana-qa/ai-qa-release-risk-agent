import type { IncomingMessage, ServerResponse } from "node:http";
import { getQualityGates } from "../qualityGates.ts";
import { sendJson } from "../_vercelShared.ts";

/** Same payload as the local /api/quality-gates: read-only gate documentation. */
export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, getQualityGates());
}
