/**
 * The Phase 5 pipeline:
 *
 *   MCP data  ->  LLM reasoning (analyze)  ->  validate agent output
 *             ->  deterministic adapter        ->  evaluateReleaseGate()
 *
 * `evaluateReleaseGate()` (Phase 3, unchanged) is the SOLE owner of the final
 * GO / NO_GO / CONDITIONAL decision. Every path here — including every failure
 * path — takes its decision from that function and nowhere else.
 */

import {
  evaluateReleaseGate,
  type GateResult,
  type Decision,
} from "./releaseGate.ts";
import {
  AGENT_SYSTEM_PROMPT,
  AGENT_ANALYSIS_STEPS,
  MCP_TOOL_NAMES,
  type AnalyzeFn,
  type AgentContext,
  type AgentFindings,
} from "./agentContract.ts";
import { validateAgentFindings } from "./agentOutputValidation.ts";
import {
  adaptAgentFindingsToReleaseFindings,
  type SyntheticDatasets,
} from "./findingsAdapter.ts";
import { loadDataset as defaultLoadDataset, type DatasetName } from "./dataLoader.ts";

export interface PipelineStep {
  step: "load-data" | "agent-analyze" | "validate-agent-output" | "adapt-findings" | "release-gate";
  ok: boolean;
  detail?: string;
}

export interface ReleaseAssessment {
  /** Always `gate.decision`. Never derived from the language model. */
  decision: Decision;
  /** Always `gate.firedRule`. */
  firedRule: string;
  /** Always `gate.reasons`. */
  reasons: string[];
  /** The full deterministic gate result. */
  gate: GateResult;
  /** Human-readable QA risk explanation from the LLM, or null if the agent step never produced valid output. */
  agentExplanation: string | null;
  /** Validated structured agent findings, or null on the fail-safe path. */
  agentFindings: AgentFindings | null;
  /** Ordered trace of what happened. */
  pipeline: PipelineStep[];
}

export interface RunOptions {
  /** The LLM reasoning step. Injected for deterministic testing. */
  analyze: AnalyzeFn;
  /** Data source. Defaults to reading the synthetic files via the Phase 4 loader. */
  loadDataset?: (name: DatasetName) => unknown;
}

/** Build the fail-safe assessment: the gate itself produces the NO_GO. */
function failSafe(pipeline: PipelineStep[], problems: string[], agentFindings: AgentFindings | null): ReleaseAssessment {
  // Passing malformed input makes evaluateReleaseGate return NO_GO / FAIL_SAFE.
  const gate = evaluateReleaseGate({ __invalid: "agent pipeline could not produce valid findings" });
  return {
    decision: gate.decision,
    firedRule: gate.firedRule,
    reasons: [...gate.reasons, ...problems],
    gate,
    agentExplanation: agentFindings?.releaseRiskExplanation ?? null,
    agentFindings,
    pipeline,
  };
}

export async function runReleaseAssessment(options: RunOptions): Promise<ReleaseAssessment> {
  const load = options.loadDataset ?? defaultLoadDataset;
  const pipeline: PipelineStep[] = [];

  // 1. Load the four synthetic datasets (authoritative ground truth).
  let datasets: SyntheticDatasets;
  try {
    datasets = {
      requirement: load("requirement"),
      existingTests: load("existing-tests"),
      knownDefects: load("known-defects"),
      riskRules: load("risk-rules"),
    };
    pipeline.push({ step: "load-data", ok: true });
  } catch (err) {
    pipeline.push({ step: "load-data", ok: false, detail: err instanceof Error ? err.message : String(err) });
    return failSafe(pipeline, [`load-data failed: ${err instanceof Error ? err.message : String(err)}`], null);
  }

  // 2. LLM reasoning step.
  const context: AgentContext = {
    systemPrompt: AGENT_SYSTEM_PROMPT,
    analysisSteps: AGENT_ANALYSIS_STEPS,
    toolNames: MCP_TOOL_NAMES,
    datasets,
  };
  let rawAgentOutput: unknown;
  try {
    rawAgentOutput = await options.analyze(context);
    pipeline.push({ step: "agent-analyze", ok: true });
  } catch (err) {
    pipeline.push({ step: "agent-analyze", ok: false, detail: err instanceof Error ? err.message : String(err) });
    return failSafe(pipeline, [`agent-analyze failed: ${err instanceof Error ? err.message : String(err)}`], null);
  }

  // 3. Validate the raw agent output.
  const validation = validateAgentFindings(rawAgentOutput);
  if (!validation.ok) {
    pipeline.push({ step: "validate-agent-output", ok: false, detail: `${validation.problems.length} ${validation.problems.length === 1 ? "problem" : "problems"}` });
    return failSafe(pipeline, validation.problems.map((p) => `validate-agent-output: ${p}`), null);
  }
  pipeline.push({ step: "validate-agent-output", ok: true });
  const findings = validation.findings;

  // 4. Deterministic adapter -> ReleaseFindings.
  const adapted = adaptAgentFindingsToReleaseFindings(findings, datasets);
  if (!adapted.ok) {
    pipeline.push({ step: "adapt-findings", ok: false, detail: `${adapted.problems.length} ${adapted.problems.length === 1 ? "problem" : "problems"}` });
    return failSafe(pipeline, adapted.problems.map((p) => `adapt-findings: ${p}`), findings);
  }
  pipeline.push({ step: "adapt-findings", ok: true });

  // 5. The deterministic gate owns the decision.
  const gate = evaluateReleaseGate(adapted.releaseFindings);
  pipeline.push({ step: "release-gate", ok: true, detail: `${gate.decision} (${gate.firedRule})` });

  return {
    decision: gate.decision,
    firedRule: gate.firedRule,
    reasons: gate.reasons,
    gate,
    agentExplanation: findings.releaseRiskExplanation,
    agentFindings: findings,
    pipeline,
  };
}
