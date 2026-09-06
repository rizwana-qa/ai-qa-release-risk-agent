/**
 * Minimal local HTTP server for the demo dashboard.
 *
 * Serves the static `web/` frontend and a small JSON/SSE API that invokes the
 * EXISTING pipeline (`src/pipelineCli.ts` steps) via `api/pipelineRunner.ts`.
 * No database, no auth, no framework, no new dependencies — Node built-ins only.
 * Binds to the loopback interface only (both 127.0.0.1 and ::1), so the workspace
 * is reachable whether the browser resolves "localhost" to IPv4 or IPv6.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

import { SCENARIOS, getScenario } from "./scenarioData.ts";
import { runAssessment, getMeta } from "./pipelineRunner.ts";
import { normalizeAssessmentInput } from "./inputNormalizer.ts";
import { runCustomAssessment } from "./customAssessmentRunner.ts";
import * as runRegistry from "./runRegistry.ts";

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
/**
 * Loopback addresses to listen on. Windows resolves "localhost" to ::1 (IPv6)
 * first, so a server bound only to 127.0.0.1 leaves the browser's fetch() calls
 * failing with "Failed to fetch" even though the page itself loaded. Bind both.
 * Set HOST to pin a single interface.
 */
const HOSTS = process.env.HOST ? [process.env.HOST] : ["127.0.0.1", "::1"];
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const STATIC_FILES: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/styles.css": "styles.css",
  "/app.js": "app.js",
  "/components.js": "components.js",
  "/workspace.js": "workspace.js",
  "/upload.js": "upload.js",
  "/format.js": "format.js",
  "/icons.js": "icons.js",
};

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  json: "application/json; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": MIME.json!,
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function sendStatic(res: ServerResponse, fileName: string): void {
  try {
    const buf = readFileSync(join(WEB_DIR, fileName));
    const ext = fileName.split(".").pop() ?? "";
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(buf);
  } catch {
    sendJson(res, 404, { error: `asset not found: ${fileName}` });
  }
}

/** Resolves to the raw body text, or null when it exceeded MAX_BODY_BYTES. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let data = "";
    let bytes = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return; // keep draining the socket, but stop buffering
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) { tooLarge = true; data = ""; return; }
      data += c;
    });
    req.on("end", () => resolve(tooLarge ? null : data));
    req.on("error", () => resolve(""));
  });
}

function parseJsonBody(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  // static
  const staticName = STATIC_FILES[path];
  if (staticName) return sendStatic(res, staticName);

  // api
  if (path === "/api/health") return sendJson(res, 200, { ok: true, synthetic: true });

  if (path === "/api/scenarios") return sendJson(res, 200, SCENARIOS);

  if (path === "/api/meta") return sendJson(res, 200, getMeta());

  if (path === "/api/scenario") {
    const scenario = getScenario(url.searchParams.get("id") ?? "");
    return scenario
      ? sendJson(res, 200, scenario)
      : sendJson(res, 404, { error: "unknown scenario id" });
  }

  if (path === "/api/assess" && req.method === "POST") {
    await readBody(req);
    const id = url.searchParams.get("id") ?? SCENARIOS[0]!.id;
    if (!SCENARIOS.some((s) => s.id === id)) return sendJson(res, 404, { error: "unknown scenario id" });
    const result = await runAssessment();
    return sendJson(res, 200, result);
  }

  if (path === "/api/assess/stream") {
    const id = url.searchParams.get("id") ?? SCENARIOS[0]!.id;
    if (!SCENARIOS.some((s) => s.id === id)) return sendJson(res, 404, { error: "unknown scenario id" });

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    try {
      const result = await runAssessment({ onStage: (event) => send({ type: "stage", ...event }) });
      send({ type: "result", ...result });
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    send({ type: "end" });
    res.end();
    return;
  }

  /* -------------------- user-submitted custom assessment -------------------- */

  if (path === "/api/assess/custom" && req.method === "POST") {
    const raw = await readBody(req);
    if (raw === null) {
      return sendJson(res, 413, { ok: false, error: `request body exceeds ${MAX_BODY_BYTES} bytes` });
    }
    const body = parseJsonBody(raw);
    if (!body) return sendJson(res, 400, { ok: false, error: "expected a JSON object body" });

    // Validate completeness up front so an incomplete request never starts a run.
    const norm = normalizeAssessmentInput(body);
    if (!norm.ok) return sendJson(res, 422, { ok: false, missing: norm.missing, problems: norm.problems });

    if (url.searchParams.get("blocking") === "1") {
      const outcome = await runCustomAssessment(body);
      if (!outcome.ok) return sendJson(res, outcome.status, { ok: false, missing: outcome.missing, problems: outcome.problems });
      return sendJson(res, 200, { ok: true, ...outcome.result });
    }

    const runId = runRegistry.put(body);
    return sendJson(res, 200, { ok: true, runId, mode: "rules-based" });
  }

  if (path === "/api/assess/custom/stream") {
    const runId = url.searchParams.get("runId") ?? "";
    const payload = runRegistry.take(runId);
    if (payload === undefined) return sendJson(res, 404, { ok: false, error: "unknown or expired runId" });

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    try {
      const outcome = await runCustomAssessment(payload as Record<string, unknown>, {
        onStage: (event) => send({ type: "stage", ...event }),
      });
      if (outcome.ok) send({ type: "result", ...outcome.result });
      else send({ type: "needs-input", missing: outcome.missing, problems: outcome.problems });
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    send({ type: "end" });
    res.end();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

export function createDemoServer() {
  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      } catch {
        /* response already sent */
      }
    });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  let announced = false;

  const announce = () => {
    if (announced) return;
    announced = true;
    const hasKey = Boolean(process.env.GEMINI_API_KEY);
    process.stdout.write(
      `\n  AI QA Release Risk & Test Strategy Agent\n` +
        `  Workspace:  http://localhost:${PORT}  (also http://127.0.0.1:${PORT})\n` +
        (hasKey
          ? `  AI analysis: Gemini 3.6 Flash (falls back to rules-based if a call fails)\n\n`
          : `  QA analysis mode: Rules based (set GEMINI_API_KEY for live Gemini analysis)\n\n`),
    );
  };

  for (const host of HOSTS) {
    const server = createDemoServer();
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        process.stderr.write(
          `\n  Port ${PORT} is already in use. Stop the other process, or run with PORT=<number>.\n\n`,
        );
        process.exit(1);
      }
      // IPv6 loopback unavailable (IPv6 disabled on the host) — keep serving on the others.
      if (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT" || err.code === "EINVAL") return;
      throw err;
    });
    server.listen(PORT, host, announce);
  }
}
