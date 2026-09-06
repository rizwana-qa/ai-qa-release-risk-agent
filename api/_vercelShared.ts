/**
 * Shared logic for the Vercel serverless handlers (api/vercel/*.ts).
 *
 * Named with a leading underscore so Vercel's file-based routing does not
 * treat this module itself as a route — it has no default export and isn't
 * meant to be requested directly.
 *
 * Reuses the EXISTING in-process pipeline (`runPipeline()` in
 * src/pipelineCli.ts) instead of the spawn-based orchestration in
 * api/pipelineRunner.ts / api/customAssessmentRunner.ts, because a
 * serverless function cannot rely on child processes or a shared local
 * filesystem across requests the way the local/Render server does. Every
 * step function, the Gemini integration (with its DEF-01 bounded timeout),
 * the validator, the adapter, and evaluateReleaseGate() are exactly the same
 * code — only the transport (one in-process call vs. six spawned processes)
 * differs. No business logic, gate rule, or fallback rule is changed here.
 */

import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

import { runPipeline, type ReleaseReport } from "../src/pipelineCli.ts";
import { createGeminiAnalyzeFn } from "../src/geminiAgent.ts";
import { EVALUATION_ORDER } from "../src/releaseGate.ts";
import { MCP_TOOL_NAMES } from "../src/agentContract.ts";
import { normalizeAssessmentInput, type RawAssessmentPayload } from "./inputNormalizer.ts";
import { analyzeEvidence } from "./evidenceAnalyzer.ts";
import { getMeta, computeSummary, type AssessmentResult, type AssessmentSummary } from "./pipelineRunner.ts";

const SAMPLE_FINDINGS_FILE = fileURLToPath(
  new URL("../workflows/sample-agent-findings.json", import.meta.url),
);

/* --------------------------- tiny HTTP helpers --------------------------- */
/* Generic request/response plumbing, duplicated in miniature from
 * api/server.ts (not imported from it, so nothing here depends on that
 * file's server.listen()/static-file wiring). No business logic. */

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(text);
}

export function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let data = "";
    let bytes = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return;
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) { tooLarge = true; data = ""; return; }
      data += c;
    });
    req.on("end", () => resolve(tooLarge ? null : data));
    req.on("error", () => resolve(""));
  });
}

export function parseJsonBody(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export { MAX_BODY_BYTES };

const FAILURE_STEPS = ["ai-reasoning", "validate-structured-findings", "deterministic-adapter"];

function batchFailed(trace: ReleaseReport["pipelineTrace"]): boolean {
  return trace.some((t) => FAILURE_STEPS.includes(t.step) && t.ok === false);
}

function readInternalState(stateFile: string): unknown {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

function scratchStateFile(prefix: string): string {
  return join(tmpdir(), `${prefix}-${randomUUID()}.json`);
}

/**
 * The fixed REQ-BEN-001 fixture assessment, in-process. Mirrors
 * api/pipelineRunner.ts's runAssessment(): try live Gemini when a key is
 * present, silently fall back to the recorded findings fixture if the
 * analyze/validate/adapt batch didn't succeed.
 */
export async function runFixtureAssessmentInProcess(): Promise<AssessmentResult> {
  const hasKey = Boolean(process.env.GEMINI_API_KEY);
  let mode: "gemini" | "recorded" = hasKey ? "gemini" : "recorded";
  const stateFile = scratchStateFile("vercel-fixture");

  const recordedAnalyze = async () => JSON.parse(readFileSync(SAMPLE_FINDINGS_FILE, "utf8")) as unknown;
  const liveAnalyze = hasKey ? createGeminiAnalyzeFn() : recordedAnalyze;

  try {
    let report = await runPipeline({ stateFile, analyze: liveAnalyze });
    let state = readInternalState(stateFile);

    if (hasKey && batchFailed(report.pipelineTrace)) {
      mode = "recorded";
      report = await runPipeline({ stateFile, analyze: recordedAnalyze });
      state = readInternalState(stateFile);
    }

    return { report, summary: computeSummary(state), mode, meta: getMeta() };
  } finally {
    try { rmSync(stateFile, { force: true }); } catch { /* ignore */ }
  }
}

export interface CustomAssessmentResultShape {
  report: unknown | null;
  summary: AssessmentSummary | null;
  coverageStats: unknown;
  context: unknown;
  provenance: unknown;
  supportingDocuments: unknown;
  mode: "gemini" | "rules-based";
  meta: { pipelineStages: string[]; evaluationOrder: readonly string[]; mcpTools: readonly string[] };
}

export type CustomAssessmentOutcome =
  | { ok: true; result: CustomAssessmentResultShape }
  | { ok: false; status: 422; missing: string[]; problems: string[] };

const CUSTOM_STAGE_LABELS = [
  "Preparing release context",
  "Preparing QA evidence",
  "AI QA analysis",
  "Validating findings",
  "Evaluating deterministic release gate",
  "Assembling release report",
];

/**
 * A user-submitted assessment, in-process. Mirrors
 * api/customAssessmentRunner.ts's runCustomAssessment(): the rules-based
 * findings are always computed up front as the guaranteed fallback; live
 * Gemini is tried when a key is present, and the whole batch is silently
 * redone against the rules-based findings if it didn't succeed.
 */
export async function runCustomAssessmentInProcess(
  payload: RawAssessmentPayload,
): Promise<CustomAssessmentOutcome> {
  const norm = normalizeAssessmentInput(payload);
  if (!norm.ok) return { ok: false, status: 422, missing: norm.missing, problems: norm.problems };

  const findings = analyzeEvidence(norm.datasets, norm.context, norm.coverageStats);
  const requirementId = (norm.datasets.requirement as { requirement: { requirementId: string } }).requirement
    .requirementId;
  const stateFile = scratchStateFile("vercel-custom");

  const hasKey = Boolean(process.env.GEMINI_API_KEY);
  let mode: "gemini" | "rules-based" = hasKey ? "gemini" : "rules-based";
  const rulesAnalyze = async () => findings as unknown;
  const liveAnalyze = hasKey ? createGeminiAnalyzeFn() : rulesAnalyze;
  const fetchDatasets = async () => norm.datasets;

  try {
    let report = await runPipeline({ stateFile, scenario: requirementId, fetchDatasets, analyze: liveAnalyze });
    let state = readInternalState(stateFile);

    if (hasKey && batchFailed(report.pipelineTrace)) {
      mode = "rules-based";
      report = await runPipeline({ stateFile, scenario: requirementId, fetchDatasets, analyze: rulesAnalyze });
      state = readInternalState(stateFile);
    }

    return {
      ok: true,
      result: {
        report,
        summary: computeSummary(state),
        coverageStats: norm.coverageStats,
        context: norm.context,
        provenance: norm.provenance,
        supportingDocuments: norm.context.supportingDocuments,
        mode,
        meta: { pipelineStages: CUSTOM_STAGE_LABELS, evaluationOrder: EVALUATION_ORDER, mcpTools: MCP_TOOL_NAMES },
      },
    };
  } finally {
    try { rmSync(stateFile, { force: true }); } catch { /* ignore */ }
  }
}
