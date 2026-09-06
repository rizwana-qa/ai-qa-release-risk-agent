/**
 * Pipeline CLI — the seam the n8n workflow drives.
 *
 * This file is ORCHESTRATION / PLUMBING ONLY. It contains no QA risk logic and
 * no release-decision logic. Every step delegates to an existing Phase 2-5
 * component:
 *
 *   fetch-data  -> fetchDatasetsViaMcp()            (Phase 4 MCP layer)
 *   analyze     -> createGeminiAnalyzeFn()          (Phase 5 AI reasoning)
 *   validate    -> validateAgentFindings()          (Phase 5)
 *   adapt       -> adaptAgentFindingsToReleaseFindings()  (Phase 5 adapter)
 *   gate        -> evaluateReleaseGate()            (Phase 3 — SOLE decision owner)
 *   assemble    -> copies fields into a report object (no logic)
 *
 * Each step reads and writes one JSON state file so n8n can run the steps as
 * separate nodes. Steps never exit non-zero for pipeline-logic failures: they
 * record the problem in the trace and let the gate step fail safe (NO_GO).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { fetchDatasetsViaMcp, type FetchedDatasets } from "./mcpDataClient.ts";
import { createGeminiAnalyzeFn } from "./geminiAgent.ts";
import { validateAgentFindings } from "./agentOutputValidation.ts";
import { adaptAgentFindingsToReleaseFindings } from "./findingsAdapter.ts";
import { evaluateReleaseGate } from "./releaseGate.ts";
import {
  AGENT_SYSTEM_PROMPT,
  AGENT_ANALYSIS_STEPS,
  MCP_TOOL_NAMES,
  type AnalyzeFn,
  type AgentFindings,
} from "./agentContract.ts";

export const PIPELINE_STEPS = ["fetch-data", "analyze", "validate", "adapt", "gate", "assemble"] as const;
export type PipelineStepName = (typeof PIPELINE_STEPS)[number];

const DEFAULT_STATE_FILE = ".pipeline-run/state.json";

interface TraceEntry {
  step: string;
  ok: boolean;
  detail?: string;
}

interface PipelineState {
  scenario: "REQ-BEN-001";
  datasets?: FetchedDatasets;
  agentRaw?: unknown;
  agentValidation?: { ok: boolean; problems?: string[] };
  agentFindings?: AgentFindings;
  adapterResult?: { ok: boolean; problems?: string[]; releaseFindings?: unknown };
  gate?: { decision: string; firedRule: string; reasons: string[] };
  report?: unknown;
  trace: TraceEntry[];
}

export interface ReleaseReport {
  scenario: string;
  decisionAuthority: string;
  releaseDecision: string | null;
  firedRule: string | null;
  reasons: string[];
  aiQaExplanation: string | null;
  changeSummary: string | null;
  identifiedRisks: unknown[];
  coverageAssessment: unknown[];
  missingScenarios: unknown[];
  defectReview: unknown[];
  regressionPriorities: unknown[];
  dataProvenance: unknown;
  agentOutputValid: boolean | null;
  adapterOk: boolean | null;
  pipelineTrace: TraceEntry[];
}

/* ------------------------------- state io -------------------------------- */

function emptyState(): PipelineState {
  return { scenario: "REQ-BEN-001", trace: [] };
}

function readState(file: string): PipelineState {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PipelineState;
  } catch {
    return emptyState();
  }
}

function writeState(file: string, state: PipelineState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

/* --------------------------------- steps -------------------------------- */

async function stepFetchData(
  state: PipelineState,
  fetchDatasets: () => Promise<FetchedDatasets>,
): Promise<void> {
  try {
    state.datasets = await fetchDatasets();
    state.trace.push({ step: "retrieve-qa-data-mcp", ok: true, detail: "4 MCP tools" });
  } catch (err) {
    state.trace.push({ step: "retrieve-qa-data-mcp", ok: false, detail: msg(err) });
  }
}

async function stepAnalyze(state: PipelineState, analyze: AnalyzeFn): Promise<void> {
  if (!state.datasets) {
    state.trace.push({ step: "ai-reasoning", ok: false, detail: "no datasets" });
    return;
  }
  try {
    state.agentRaw = await analyze({
      systemPrompt: AGENT_SYSTEM_PROMPT,
      analysisSteps: AGENT_ANALYSIS_STEPS,
      toolNames: MCP_TOOL_NAMES,
      datasets: state.datasets,
    });
    state.trace.push({ step: "ai-reasoning", ok: true });
  } catch (err) {
    state.trace.push({ step: "ai-reasoning", ok: false, detail: msg(err) });
  }
}

function stepValidate(state: PipelineState): void {
  const v = validateAgentFindings(state.agentRaw);
  if (v.ok) {
    state.agentFindings = v.findings;
    state.agentValidation = { ok: true };
    state.trace.push({ step: "validate-structured-findings", ok: true });
  } else {
    state.agentValidation = { ok: false, problems: v.problems };
    state.trace.push({ step: "validate-structured-findings", ok: false, detail: `${v.problems.length} problem(s)` });
  }
}

function stepAdapt(state: PipelineState): void {
  if (!state.agentFindings || !state.datasets) {
    state.adapterResult = { ok: false, problems: ["no valid agent findings or datasets to adapt"] };
    state.trace.push({ step: "deterministic-adapter", ok: false, detail: "skipped" });
    return;
  }
  const r = adaptAgentFindingsToReleaseFindings(state.agentFindings, state.datasets);
  if (r.ok) {
    state.adapterResult = { ok: true, releaseFindings: r.releaseFindings };
    state.trace.push({ step: "deterministic-adapter", ok: true });
  } else {
    state.adapterResult = { ok: false, problems: r.problems };
    state.trace.push({ step: "deterministic-adapter", ok: false, detail: `${r.problems.length} problem(s)` });
  }
}

/** The ONLY place a decision is produced — by calling evaluateReleaseGate(). */
function stepGate(state: PipelineState): void {
  const input = state.adapterResult?.ok
    ? state.adapterResult.releaseFindings
    : { __invalidPipeline: "no adapted release findings available" };
  const gate = evaluateReleaseGate(input);
  state.gate = { decision: gate.decision, firedRule: gate.firedRule, reasons: gate.reasons };
  state.trace.push({ step: "deterministic-release-gate", ok: true, detail: `${gate.decision} (${gate.firedRule})` });
}

/**
 * Keep only the most recent trace entry per step name (in that step's
 * original position), so a step that was silently retried — e.g. a failed
 * live-Gemini attempt recovered by re-running against the recorded/rules-based
 * fallback — is shown once, with its final outcome, not twice.
 */
function dedupeTrace(trace: TraceEntry[]): TraceEntry[] {
  const latest = new Map<string, TraceEntry>();
  for (const t of trace) latest.set(t.step, t);
  return trace.map((t) => latest.get(t.step)!).filter((t, i, arr) => arr.findIndex((x) => x.step === t.step) === i);
}

/** Copies fields into the report shape. No logic, no rules. */
function stepAssemble(state: PipelineState): ReleaseReport {
  const af = (state.agentFindings ?? {}) as Partial<AgentFindings>;
  const report: ReleaseReport = {
    scenario: state.scenario,
    decisionAuthority: "evaluateReleaseGate() (deterministic) — the AI agent explains the risk, it does not decide",
    releaseDecision: state.gate?.decision ?? null,
    firedRule: state.gate?.firedRule ?? null,
    reasons: state.gate?.reasons ?? [],
    aiQaExplanation: af.releaseRiskExplanation ?? null,
    changeSummary: af.changeSummary ?? null,
    identifiedRisks: af.identifiedRisks ?? [],
    coverageAssessment: af.coverageAssessment ?? [],
    missingScenarios: af.missingScenarios ?? [],
    defectReview: af.defectReview ?? [],
    regressionPriorities: af.regressionPriorities ?? [],
    dataProvenance: af.dataProvenance ?? null,
    agentOutputValid: state.agentValidation?.ok ?? null,
    adapterOk: state.adapterResult?.ok ?? null,
    pipelineTrace: dedupeTrace(state.trace),
  };
  state.report = report;
  return report;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* --------------------------- analyze resolution ------------------------- */

/**
 * Resolve the analyze function for a step run:
 *   - explicit override (tests / embedding), else
 *   - PIPELINE_AGENT_FINDINGS_FILE env -> read that JSON file (offline demo), else
 *   - the live Gemini agent (needs GEMINI_API_KEY).
 */
function resolveAnalyze(override?: AnalyzeFn): AnalyzeFn {
  if (override) return override;
  const fixtureFile = process.env.PIPELINE_AGENT_FINDINGS_FILE;
  if (fixtureFile) {
    return async () => JSON.parse(readFileSync(fixtureFile, "utf8")) as unknown;
  }
  return createGeminiAnalyzeFn();
}

/* ------------------------------ public run ----------------------------- */

export interface RunPipelineOptions {
  stateFile?: string;
  analyze?: AnalyzeFn;
  fetchDatasets?: () => Promise<FetchedDatasets>;
}

/** Run all six steps in order (used by `pipeline run` and by tests). */
export async function runPipeline(options: RunPipelineOptions = {}): Promise<ReleaseReport> {
  const stateFile = options.stateFile ?? DEFAULT_STATE_FILE;
  const analyze = resolveAnalyze(options.analyze);
  const fetchDatasets = options.fetchDatasets ?? fetchDatasetsViaMcp;

  const state = emptyState();
  await stepFetchData(state, fetchDatasets);
  await stepAnalyze(state, analyze);
  stepValidate(state);
  stepAdapt(state);
  stepGate(state);
  const report = stepAssemble(state);
  writeState(stateFile, state);
  return report;
}

/* -------------------------------- CLI ---------------------------------- */

function parseArgs(argv: string[]): { step: string; stateFile: string } {
  const step = argv[0] ?? "";
  let stateFile = DEFAULT_STATE_FILE;
  const i = argv.indexOf("--state");
  if (i >= 0 && argv[i + 1]) stateFile = argv[i + 1] as string;
  return { step, stateFile };
}

export async function main(argv: string[]): Promise<void> {
  const { step, stateFile } = parseArgs(argv);

  if (step === "run") {
    const report = await runPipeline({ stateFile });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  if (!PIPELINE_STEPS.includes(step as PipelineStepName)) {
    process.stderr.write(
      `Usage: node src/pipelineCli.ts <${PIPELINE_STEPS.join("|")}|run> [--state <file>]\n`,
    );
    process.exit(2);
  }

  const state = readState(stateFile);
  if (!Array.isArray(state.trace)) state.trace = [];

  switch (step as PipelineStepName) {
    case "fetch-data":
      await stepFetchData(state, fetchDatasetsViaMcp);
      break;
    case "analyze":
      await stepAnalyze(state, resolveAnalyze());
      break;
    case "validate":
      stepValidate(state);
      break;
    case "adapt":
      stepAdapt(state);
      break;
    case "gate":
      stepGate(state);
      break;
    case "assemble": {
      const report = stepAssemble(state);
      writeState(stateFile, state);
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return;
    }
  }

  writeState(stateFile, state);
  process.stdout.write(JSON.stringify({ step, trace: state.trace.at(-1) ?? null }, null, 2) + "\n");
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error("[pipelineCli] fatal:", err);
    process.exit(1);
  });
}
