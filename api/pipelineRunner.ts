/**
 * Runs the EXISTING assessment pipeline for the demo API.
 *
 * It drives the six existing `src/pipelineCli.ts` steps as separate child
 * processes — exactly the seam the n8n workflow uses — so the browser can show
 * real per-stage progress. It re-implements NOTHING:
 *
 *   - the decision comes from `evaluateReleaseGate()` inside the `gate` step;
 *   - the three executive-summary values are produced by calling the EXISTING
 *     exported predicates `changeRiskLevel()`, `insufficientCoverage()`,
 *     `securityFailure()` on the adapter's `releaseFindings`.
 *
 * No risk / coverage / security / gate / precedence / decision logic lives here.
 */

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  changeRiskLevel,
  insufficientCoverage,
  securityFailure,
  EVALUATION_ORDER,
  type ReleaseFindings,
} from "../src/releaseGate.ts";
import { MCP_TOOL_NAMES } from "../src/agentContract.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE_FINDINGS = "workflows/sample-agent-findings.json";

/** UI stage -> the existing pipelineCli.ts step, and the trace key it writes. */
export const PIPELINE_STAGES = [
  { key: "retrieve-qa-data-mcp", cli: "fetch-data", label: "Retrieve QA data (MCP)" },
  { key: "ai-reasoning", cli: "analyze", label: "AI QA analysis" },
  { key: "validate-structured-findings", cli: "validate", label: "Validate structured findings" },
  { key: "deterministic-adapter", cli: "adapt", label: "Adapt findings for the release gate" },
  { key: "deterministic-release-gate", cli: "gate", label: "Evaluate deterministic release gate" },
  { key: "assemble", cli: "assemble", label: "Assemble release report" },
] as const;

export interface StageEvent {
  index: number;
  key: string;
  label: string;
  status: "running" | "done" | "failed";
  detail?: string;
}

export interface AssessmentSummary {
  changeRisk: string; // "low" | "medium" | "high"
  testCoverage: "sufficient" | "insufficient";
  coverageReasons: string[];
  securityRisk: "passed" | "failed";
  securityReasons: string[];
}

export interface AssessmentMeta {
  mcpTools: readonly string[];
  stages: Array<{ key: string; label: string }>;
  evaluationOrder: readonly string[];
  mcpRetrieval: string[];
}

export interface AssessmentResult {
  report: unknown | null;
  summary: AssessmentSummary | null;
  mode: "gemini" | "recorded";
  meta: AssessmentMeta;
}

export function getMeta(): AssessmentMeta {
  return {
    mcpTools: MCP_TOOL_NAMES,
    stages: PIPELINE_STAGES.map((s) => ({ key: s.key, label: s.label })),
    evaluationOrder: EVALUATION_ORDER,
    mcpRetrieval: ["Requirement", "Existing Tests", "Known Defects", "Risk Rules"],
  };
}

/**
 * Executive-summary values. Pure: it only forwards the results of the existing
 * gate predicates. Returns null when the adapter did not produce findings.
 */
export function computeSummary(state: any): AssessmentSummary | null {
  const ar = state?.adapterResult;
  if (!ar?.ok || !ar.releaseFindings) return null;
  try {
    const rf = ar.releaseFindings as ReleaseFindings;
    const cov = insufficientCoverage(rf);
    const sec = securityFailure(rf);
    return {
      changeRisk: changeRiskLevel(rf),
      testCoverage: cov.insufficient ? "insufficient" : "sufficient",
      coverageReasons: cov.reasons,
      securityRisk: sec.failed ? "failed" : "passed",
      securityReasons: sec.reasons,
    };
  } catch {
    return null;
  }
}

/**
 * Bound on how long a single pipelineCli.ts step's child process may run.
 * Backstop for `runStep()`'s wait: `createGeminiAnalyzeFn()`'s own timeout
 * (see src/geminiAgent.ts) is what normally turns a hung Gemini call into a
 * fast, clean trace failure inside the "analyze" step's process — this timer
 * only fires, and kills the child, if a step's process fails to exit on its
 * own regardless of that. Exported so the kill-on-timeout behavior itself can
 * be exercised directly in tests without depending on a real network hang.
 */
export const STEP_TIMEOUT_MS = Number(process.env.PIPELINE_STEP_TIMEOUT_MS) || 30_000;

export function runStep(
  cli: string,
  stateFile: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number = STEP_TIMEOUT_MS,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/pipelineCli.ts", cli, "--state", stateFile], {
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
    }, timeoutMs);
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

export interface RunAssessmentOptions {
  onStage?: (event: StageEvent) => void;
}

function readTrace(stateFile: string): Array<{ step?: string; ok?: boolean; detail?: string }> {
  try {
    const st = JSON.parse(readFileSync(stateFile, "utf8"));
    return Array.isArray(st.trace) ? st.trace : [];
  } catch {
    return [];
  }
}

function traceEntry(trace: Array<{ step?: string; ok?: boolean; detail?: string }>, step: string) {
  return [...trace].reverse().find((t) => t?.step === step);
}

/** Run one pipelineCli.ts step and emit its stage event from the resulting trace entry. */
async function runAndEmit(
  index: number,
  stateFile: string,
  env: NodeJS.ProcessEnv,
  onStage: RunAssessmentOptions["onStage"],
): Promise<void> {
  const stage = PIPELINE_STAGES[index]!;
  const code = await runStep(stage.cli, stateFile, env);
  const entry = traceEntry(readTrace(stateFile), stage.key);
  const status: "done" | "failed" = code === 0 && entry?.ok !== false ? "done" : "failed";
  onStage?.({ index, key: stage.key, label: stage.label, status, detail: entry?.detail });
}

export async function runAssessment(opts: RunAssessmentOptions = {}): Promise<AssessmentResult> {
  const hasKey = Boolean(process.env.GEMINI_API_KEY);
  let mode: "gemini" | "recorded" = hasKey ? "gemini" : "recorded";

  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  const recordedEnv: NodeJS.ProcessEnv = { ...baseEnv, PIPELINE_AGENT_FINDINGS_FILE: baseEnv.PIPELINE_AGENT_FINDINGS_FILE ?? SAMPLE_FINDINGS };
  // Live Gemini only when a key is present; otherwise use the recorded fixture from the start.
  let env: NodeJS.ProcessEnv = hasKey ? baseEnv : recordedEnv;

  mkdirSync(join(REPO_ROOT, ".pipeline-run"), { recursive: true });
  const stateFile = join(
    REPO_ROOT,
    ".pipeline-run",
    `api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );

  // Stage 0 — fetch-data. Unaffected by Gemini vs. recorded.
  opts.onStage?.({ index: 0, key: PIPELINE_STAGES[0]!.key, label: PIPELINE_STAGES[0]!.label, status: "running" });
  await runAndEmit(0, stateFile, env, opts.onStage);

  // Stages 1-3 (analyze, validate, adapt) run as a single retryable batch: if a
  // live Gemini call was attempted and failed to produce valid, gate-ready
  // findings, silently redo the batch against the recorded fixture instead —
  // "safely fall back … rather than breaking the application" — before
  // reporting any of these three stages as done/failed to the UI.
  opts.onStage?.({ index: 1, key: PIPELINE_STAGES[1]!.key, label: PIPELINE_STAGES[1]!.label, status: "running" });
  let codes: number[] = [];
  for (const i of [1, 2, 3]) codes.push(await runStep(PIPELINE_STAGES[i]!.cli, stateFile, env));
  let trace = readTrace(stateFile);
  // A step whose child process was killed for exceeding STEP_TIMEOUT_MS may
  // leave no (or a stale) trace entry for that step, so the exit code — never
  // silently coerced to "success" by runStep() — is checked too.
  const batchOk = (t: typeof trace, cs: number[]) =>
    cs.every((c) => c === 0) &&
    traceEntry(t, "ai-reasoning")?.ok !== false &&
    traceEntry(t, "validate-structured-findings")?.ok !== false &&
    traceEntry(t, "deterministic-adapter")?.ok !== false;

  if (hasKey && !batchOk(trace, codes)) {
    mode = "recorded";
    env = recordedEnv;
    codes = [];
    for (const i of [1, 2, 3]) codes.push(await runStep(PIPELINE_STAGES[i]!.cli, stateFile, env));
    trace = readTrace(stateFile);
  }
  for (const i of [1, 2, 3]) {
    const stage = PIPELINE_STAGES[i]!;
    const entry = traceEntry(trace, stage.key);
    opts.onStage?.({ index: i, key: stage.key, label: stage.label, status: entry?.ok === false ? "failed" : "done", detail: entry?.detail });
    if (i < 3) opts.onStage?.({ index: i + 1, key: PIPELINE_STAGES[i + 1]!.key, label: PIPELINE_STAGES[i + 1]!.label, status: "running" });
  }

  // Stages 4-5 (gate, assemble). env is irrelevant here — neither step calls analyze().
  opts.onStage?.({ index: 4, key: PIPELINE_STAGES[4]!.key, label: PIPELINE_STAGES[4]!.label, status: "running" });
  await runAndEmit(4, stateFile, env, opts.onStage);
  opts.onStage?.({ index: 5, key: PIPELINE_STAGES[5]!.key, label: PIPELINE_STAGES[5]!.label, status: "running" });
  await runAndEmit(5, stateFile, env, opts.onStage);

  let report: unknown | null = null;
  let summary: AssessmentSummary | null = null;
  try {
    const st = JSON.parse(readFileSync(stateFile, "utf8"));
    report = st.report ?? null;
    summary = computeSummary(st);
  } catch {
    /* leave report/summary null -> UI shows an error state, never GO */
  }
  try {
    rmSync(stateFile, { force: true });
  } catch {
    /* ignore */
  }

  return { report, summary, mode, meta: getMeta() };
}
