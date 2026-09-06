import type { IncomingMessage, ServerResponse } from "node:http";
import { SCENARIOS } from "../scenarioData.ts";
import { sendJson } from "../_vercelShared.ts";

export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, SCENARIOS);
}
