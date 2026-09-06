/**
 * The contract between the LLM reasoning layer (Gemini) and the deterministic pipeline.
 *
 * Responsibilities split (Version 1):
 *   - LLM     : analysis and reasoning over the synthetic QA data (the 7 steps).
 *   - MCP     : retrieving the synthetic QA data (the 4 Phase 4 tools).
 *   - This code: the shape the LLM must return, and the words it is told to follow.
 *
 * The LLM produces STRUCTURED FINDINGS plus a human-readable explanation. It does
 * NOT decide the release. `evaluateReleaseGate()` (Phase 3) is the sole owner of
 * the GO / NO_GO / CONDITIONAL decision.
 */

export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type PriorityLevel = "high" | "medium" | "low";

/** The seven analysis steps the agent must perform, in order. */
export const AGENT_ANALYSIS_STEPS = [
  "Understand the change",
  "Identify QA risks",
  "Review existing test coverage",
  "Identify missing scenarios",
  "Review known defects",
  "Prioritize regression testing",
  "Explain the release risk",
] as const;

/** Top-level keys that must NOT appear in agent output. The LLM may not emit a decision. */
export const FORBIDDEN_OUTPUT_KEYS = [
  "decision",
  "releaseDecision",
  "gateDecision",
  "goNoGo",
  "go_no_go",
  "verdict",
  "recommendation",
] as const;

export interface IdentifiedRisk {
  area: string;
  description: string;
  severity: FindingSeverity;
}

export interface CoverageAssessmentEntry {
  acceptanceCriterionId: string;
  covered: boolean;
  notes: string;
}

export interface DefectReviewEntry {
  defectId: string;
  stillRelevant: boolean;
  notes: string;
}

export interface RegressionPriorityEntry {
  area: string;
  priority: PriorityLevel;
  rationale: string;
}

/**
 * Facts the agent echoes back from the MCP tools so the adapter can confirm the
 * reasoning was grounded in the real dataset (and not fabricated). These are
 * cross-checked against the authoritative data; a mismatch fails safe.
 */
export interface AgentDataProvenance {
  requirementId: string;
  acceptanceCriteriaCount: number;
  existingTestCount: number;
  knownDefectCount: number;
  riskRulesScenario: string;
}

/** The structured output the LLM must return. Note: no release-decision field. */
export interface AgentFindings {
  schemaVersion: 1;
  /** Step 1. */
  changeSummary: string;
  /** Step 2. */
  identifiedRisks: IdentifiedRisk[];
  /** Step 3. */
  coverageAssessment: CoverageAssessmentEntry[];
  /** Step 4. */
  missingScenarios: string[];
  /** Step 5. */
  defectReview: DefectReviewEntry[];
  /** Step 6. */
  regressionPriorities: RegressionPriorityEntry[];
  /** Step 7 — human-readable narrative. */
  releaseRiskExplanation: string;
  dataProvenance: AgentDataProvenance;
}

/** Names of the four read-only MCP tools the agent must use to gather context. */
export const MCP_TOOL_NAMES = [
  "get_requirement",
  "get_existing_tests",
  "get_known_defects",
  "get_risk_rules",
] as const;

/** System prompt for the single LLM agent. */
export const AGENT_SYSTEM_PROMPT = [
  "You are a QA risk analyst for a single synthetic banking change:",
  '"Add a beneficiary and allow an authenticated customer to transfer money to the beneficiary after authentication."',
  "",
  "All data is synthetic. Use ONLY these read-only MCP tools to gather context:",
  MCP_TOOL_NAMES.map((t) => `  - ${t}`).join("\n"),
  "",
  "Perform these analysis steps, in order:",
  AGENT_ANALYSIS_STEPS.map((s, i) => `  ${i + 1}. ${s}`).join("\n"),
  "",
  "Then return ONE JSON object (and nothing else) with exactly these keys:",
  "  schemaVersion (number, 1), changeSummary (string), identifiedRisks (array of",
  "  {area, description, severity}), coverageAssessment (array of",
  "  {acceptanceCriterionId, covered, notes}), missingScenarios (array of strings),",
  "  defectReview (array of {defectId, stillRelevant, notes}), regressionPriorities",
  "  (array of {area, priority, rationale}), releaseRiskExplanation (string),",
  "  dataProvenance ({requirementId, acceptanceCriteriaCount, existingTestCount,",
  "  knownDefectCount, riskRulesScenario}).",
  "  severity is one of: critical, high, medium, low. priority is one of: high, medium, low.",
  "  dataProvenance values must be copied from what the tools actually returned.",
  "",
  "You do NOT decide whether to release. A separate deterministic rules engine makes",
  "the final GO / NO_GO / CONDITIONAL decision. Do NOT include any decision,",
  "recommendation, verdict, or gate outcome in your output. Explain the risk; do not rule on it.",
].join("\n");

/** Context handed to an analyze function. */
export interface AgentContext {
  systemPrompt: string;
  analysisSteps: readonly string[];
  toolNames: readonly string[];
  /**
   * The four synthetic datasets, already retrieved via MCP by the pipeline
   * before analyze() is called. The production LLM agent (Gemini) is sent
   * this copy directly — no separate tool-calling loop, since there is
   * nothing left for it to fetch — and it is also what deterministic
   * (test / offline) analyze implementations use to produce correct provenance.
   */
  datasets: {
    requirement: unknown;
    existingTests: unknown;
    knownDefects: unknown;
    riskRules: unknown;
  };
}

/**
 * A function that performs the LLM reasoning step and returns raw, untrusted
 * agent output (expected to be an {@link AgentFindings}-shaped object). Injected
 * so the pipeline can be tested deterministically without a live API call.
 */
export type AnalyzeFn = (context: AgentContext) => Promise<unknown>;
