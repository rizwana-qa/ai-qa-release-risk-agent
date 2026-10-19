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

/** The allowed values, shared by the provider-side response schema and its tests. */
export const FINDING_SEVERITIES: readonly FindingSeverity[] = ["critical", "high", "medium", "low"];
export const PRIORITY_LEVELS: readonly PriorityLevel[] = ["high", "medium", "low"];

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
  "You are a QA risk analyst. You analyse ONE software release, using ONLY the release context and",
  "QA evidence supplied to you under DATA in the user message. Do not use outside knowledge about the",
  "product, and do not assume anything DATA does not state.",
  "",
  "DATA holds four datasets: requirement (the change and its acceptance criteria), existingTests (the",
  "test cases, their status and which acceptance criteria they cover), knownDefects, and riskRules.",
  "Nothing else is available to you; you have no tools and nothing further to fetch.",
  "",
  "Perform these analysis steps, in order:",
  AGENT_ANALYSIS_STEPS.map((s, i) => `  ${i + 1}. ${s}`).join("\n"),
  "",
  "Facts versus inference:",
  "  - A FACT is something DATA states. State it plainly and cite the identifiers it comes from",
  "    (acceptance criterion ids, test ids, defect ids).",
  '  - An INFERENCE is your own judgement. Begin any inferred statement with "Inference:".',
  '  - If DATA does not contain enough to support a statement, write "Insufficient evidence:" and say',
  "    what is missing. Never invent tests, defects, results, dates, owners, counts or coverage.",
  "  - In coverageAssessment, set covered to true ONLY when DATA shows at least one passing (active)",
  "    test mapped to that acceptance criterion; otherwise set it to false.",
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
  "  dataProvenance values must be copied from DATA exactly (counts are the numbers of items DATA holds).",
  "",
  "You provide analysis and explanation ONLY. You never make the release decision: a separate",
  "deterministic rules engine produces the GO / NO_GO / CONDITIONAL result, and people keep the",
  "final release decision. Do NOT include any decision, recommendation, verdict, or gate outcome in",
  "your output. Explain the risk; do not rule on it.",
].join("\n");

/** Context handed to an analyze function. */
export interface AgentContext {
  systemPrompt: string;
  analysisSteps: readonly string[];
  toolNames: readonly string[];
  /**
   * Called by a provider-backed analyze function immediately before it starts a request to the provider, and
   * never before a configuration or routing check has passed. It lets the pipeline record that an attempt BEGAN,
   * even if the call later fails, times out or is rejected. If it throws, the analyze function must not start
   * the request. Offline analyze functions never call it. It says nothing about whether the provider received
   * anything.
   */
  onProviderAttempt?: () => void;
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
