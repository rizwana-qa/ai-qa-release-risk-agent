import type { IncomingMessage, ServerResponse } from "node:http";
import { SCENARIOS } from "../scenarioData.ts";
import { runFixtureAssessmentInProcess } from "../_vercelShared.ts";
import { sendJson, readBody } from "../_vercelShared.ts";

/**
 * Vercel equivalent of the local POST /api/assess — always runs the fixed
 * REQ-BEN-001 scenario and returns the full result directly (no SSE route
 * exists in this deployment; see api/vercel/meta.ts's streaming:false).
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return sendJson(res, 404, { error: "not found" });

  await readBody(req); // body is unused, same as the local route
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const id = url.searchParams.get("id") ?? SCENARIOS[0]!.id;
  if (!SCENARIOS.some((s) => s.id === id)) return sendJson(res, 404, { error: "unknown scenario id" });

  const result = await runFixtureAssessmentInProcess();
  sendJson(res, 200, result);
}
