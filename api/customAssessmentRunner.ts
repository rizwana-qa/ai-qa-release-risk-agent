/**
 * Runs a USER-SUBMITTED assessment through the EXISTING pipeline.
 *
 *   normalize (api/inputNormalizer)      -> data/*.json-shaped datasets  (never REQ-BEN-001)
 *   rules-based analysis (api/evidenceAnalyzer) -> grounded AgentFindings (no decision) — always
 *     computed up front as the guaranteed fallback, whether or not it ends up being used.
 *   AI analysis: live Gemini when GEMINI_API_KEY is set, sending it the same
 *     normalized datasets; if Gemini fails or produces findings that don't pass
 *     validate/adapt, silently redo those steps against the rules-based
 *     findings above instead — the UI only ever sees one clean outcome.
 *   pipelineCli.ts steps analyze..assemble as child processes             [unchanged]
 *     validate  -> validateAgentFindings()                                [unchanged]
 *     adapt     -> adaptAgentFindingsToReleaseFindings() + grounding      [unchanged]
 *     gate      -> evaluateReleaseGate()   ◄── SOLE decision authority    [unchanged]
 *     assemble  -> ReleaseReport                                          [unchanged]
 *
 * No risk / coverage / security / gate / decision logic lives here. Temporary
 * per-run files under `.pipeline-run/` are deleted when the run finishes.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { normalizeAssessmentInput, type RawAssessmentPayload } from "./inputNormalizer.ts";
import { analyzeEvidence } from "./evidenceAnalyzer.ts";
import { computeSummary } from "./pipelineRunner.ts";
import { EVALUATION_ORDER } from "../src/releaseGate.ts";
import { MCP_TOOL_NAMES } from "../src/agentContract.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUN_DIR = join(REPO_ROOT, ".pipeline-run");

export const CUSTOM_STAGES = [
  { key: "prepare-context", label: "Preparing release context" },
  { key: "prepare-evidence", label: "Preparing QA evidence" },
  { key: "ai-analysis", label: "AI QA analysis" },
  { key: "validate", label: "Validating findings" },
  { key: "gate", label: "Evaluating deterministic release gate" },
  { key: "assemble", label: "Assembling release report" },
] as const;

export interface CustomStageEvent {
  index: number;
  key: string;
  label: string;
  status: "running" | "done" | "failed";
  detail?: string;
}

export interface CustomAssessmentResult {
  report: unknown | null;
  summary: unknown | null;
  coverageStats: unknown;
  context: unknown;
  provenance: unknown;
  supportingDocuments: unknown;
  mode: "gemini" | "rules-based";
  meta: { pipelineStages: string[]; evaluationOrder: readonly string[]; mcpTools: readonly string[] };
}

export type CustomAssessmentOutcome =
  | { ok: true; result: CustomAssessmentResult }
  | { ok: false; status: 422; missing: string[]; problems: string[] };

/**
 * Bound on how long a single pipelineCli.ts step's child process may run.
 * Backstop for `runStep()`'s wait: `createGeminiAnalyzeFn()`'s own timeout
 * (see src/geminiAgent.ts) is what normally turns a hung Gemini call into a
 * fast, clean trace failure inside the "analyze" step's process — this timer
 * only fires, and kills the child, if a step's process fails to exit on its
 * own regardless of that.
 */
const STEP_TIMEOUT_MS = Number(process.env.PIPELINE_STEP_TIMEOUT_MS) || 30_000;

function runStep(step: string, stateFile: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/pipelineCli.ts", step, "--state", stateFile], {
      cwd: REPO_ROOT,
      env,
      stdio: "ignore",
    });
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      // A killed step is always a failure, never `code ?? 0`'s silent "success".
      resolve(1);
    }, STEP_TIMEOUT_MS);
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      resolve(code ?? 0);
    });
    child.on("error", () => {
      if (settled) return;
      clearTimeout(timer);
      resolve(1);
    });
  });
}

export interface RunOptions {
  onStage?: (event: CustomStageEvent) => void;
}

export async function runCustomAssessment(
  payload: RawAssessmentPayload,
  opts: RunOptions = {},
): Promise<CustomAssessmentOutcome> {
  const emit = (index: number, status: CustomStageEvent["status"], detail?: string) =>
    opts.onStage?.({ index, key: CUSTOM_STAGES[index]!.key, label: CUSTOM_STAGES[index]!.label, status, detail });

  // Stage 0 — normalize / completeness gate.
  emit(0, "running");
  const norm = normalizeAssessmentInput(payload);
  if (!norm.ok) {
    emit(0, "failed", "insufficient assessment context");
    return { ok: false, status: 422, missing: norm.missing, problems: norm.problems };
  }
  emit(0, "done");

  // Stage 1 — build the rules-based findings from the submitted evidence.
  emit(1, "running");
  const findings = analyzeEvidence(norm.datasets, norm.context, norm.coverageStats);
  emit(1, "done");

  mkdirSync(RUN_DIR, { recursive: true });
  const runId = randomUUID();
  const stateFile = join(RUN_DIR, `custom-${runId}.state.json`);
  const findingsFile = join(RUN_DIR, `custom-${runId}.findings.json`);
  const requirementId = (norm.datasets.requirement as any).requirement.requirementId as string;

  writeFileSync(stateFile, JSON.stringify({ scenario: requirementId, datasets: norm.datasets, trace: [] }), "utf8");
  writeFileSync(findingsFile, JSON.stringify(findings), "utf8");

  const hasKey = Boolean(process.env.GEMINI_API_KEY);
  let mode: "gemini" | "rules-based" = hasKey ? "gemini" : "rules-based";
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  const rulesEnv: NodeJS.ProcessEnv = { ...baseEnv, PIPELINE_AGENT_FINDINGS_FILE: findingsFile };
  // Live Gemini gets the same normalized datasets the fixture flow would send;
  // no PIPELINE_AGENT_FINDINGS_FILE means resolveAnalyze() calls Gemini directly.
  let env: NodeJS.ProcessEnv = hasKey ? baseEnv : rulesEnv;

  const readState = (): any => {
    try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch { return {}; }
  };
  const traceOk = (state: any, stepKey: string): boolean | undefined => {
    const e = Array.isArray(state?.trace) ? [...state.trace].reverse().find((t: any) => t?.step === stepKey) : undefined;
    return e ? e.ok !== false : undefined;
  };

  try {
    // Stages 2-3 (AI QA analysis, then validate+adapt) run as one retryable
    // batch: if a live Gemini call was attempted and failed to produce valid,
    // gate-ready findings, silently redo the batch against the rules-based
    // findings prepared above — the UI only ever sees one clean outcome, per
    // stage, never a visible retry.
    emit(2, "running");
    let c1 = await runStep("analyze", stateFile, env);
    let c2 = await runStep("validate", stateFile, env);
    let c3 = await runStep("adapt", stateFile, env);
    let s = readState();
    // A step whose child process was killed for exceeding STEP_TIMEOUT_MS may
    // leave no (or a stale) trace entry for that step, so the exit code —
    // never silently coerced to "success" by runStep() — is checked too.
    let ok =
      c1 === 0 &&
      c2 === 0 &&
      c3 === 0 &&
      traceOk(s, "ai-reasoning") !== false &&
      traceOk(s, "validate-structured-findings") !== false &&
      traceOk(s, "deterministic-adapter") !== false;

    if (hasKey && !ok) {
      mode = "rules-based";
      env = rulesEnv;
      c1 = await runStep("analyze", stateFile, env);
      c2 = await runStep("validate", stateFile, env);
      c3 = await runStep("adapt", stateFile, env);
      s = readState();
      ok =
        c1 === 0 &&
        c2 === 0 &&
        c3 === 0 &&
        traceOk(s, "ai-reasoning") !== false &&
        traceOk(s, "validate-structured-findings") !== false &&
        traceOk(s, "deterministic-adapter") !== false;
    }
    emit(2, traceOk(s, "ai-reasoning") === false ? "failed" : "done");
    emit(3, "running");
    const validateOrAdaptBad = traceOk(s, "validate-structured-findings") === false || traceOk(s, "deterministic-adapter") === false;
    emit(3, validateOrAdaptBad ? "failed" : "done");

    // Stage 4 — deterministic release gate (always runs; fail-safes to NO_GO on invalid input).
    emit(4, "running");
    await runStep("gate", stateFile, env);
    const s3 = readState();
    emit(4, "done", s3?.gate ? `${s3.gate.decision} (${s3.gate.firedRule})` : undefined);

    // Stage 5 — assemble.
    emit(5, "running");
    await runStep("assemble", stateFile, env);
    emit(5, "done");

    const state = readState();
    return {
      ok: true,
      result: {
        report: state.report ?? null,
        summary: computeSummary(state),
        coverageStats: norm.coverageStats,
        context: norm.context,
        provenance: norm.provenance,
        supportingDocuments: norm.context.supportingDocuments,
        mode,
        meta: {
          pipelineStages: CUSTOM_STAGES.map((s) => s.label),
          evaluationOrder: EVALUATION_ORDER,
          mcpTools: MCP_TOOL_NAMES,
        },
      },
    };
  } finally {
    try { rmSync(stateFile, { force: true }); } catch { /* ignore */ }
    try { rmSync(findingsFile, { force: true }); } catch { /* ignore */ }
  }
}
