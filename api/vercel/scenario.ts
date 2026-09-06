import type { IncomingMessage, ServerResponse } from "node:http";
import { getScenario } from "../scenarioData.ts";
import { sendJson } from "../_vercelShared.ts";

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const scenario = getScenario(url.searchParams.get("id") ?? "");
  if (!scenario) return sendJson(res, 404, { error: "unknown scenario id" });
  sendJson(res, 200, scenario);
}
