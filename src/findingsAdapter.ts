/**
 * Deterministic adapter: (validated agent findings + the four synthetic datasets)
 * -> a Phase 3 `ReleaseFindings` object for `evaluateReleaseGate()`.
 *
 * Design:
 *   - The FACTS the gate consumes (acceptance criteria, defects, tests, risk
 *     levels) are taken from the AUTHORITATIVE datasets, never from the LLM.
 *   - The agent findings are checked for GROUNDING against those datasets
 *     (provenance counts + referential ids). A mismatch fails safe.
 *   - `securityFailureSeverities` is projected deterministically from the Phase 2
 *     `securityFailureRule` (formalizing the value Phase 4 hard-coded in tests).
 *   - Pure: no I/O, no randomness, no time. Same inputs -> same output.
 */

import { type ReleaseFindings, type Severity, validateFindings } from "./releaseGate.ts";
import { type AgentFindings } from "./agentContract.ts";

export type AdapterResult =
  | { ok: true; releaseFindings: ReleaseFindings }
  | { ok: false; problems: string[] };

/** Datasets as returned by the four MCP tools / the data loader. */
export interface SyntheticDatasets {
  requirement: unknown;
  existingTests: unknown;
  knownDefects: unknown;
  riskRules: unknown;
}

const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low"];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Formalized projection of the Phase 2 rule "critical or high severity security
 * defects can trigger the security failure condition".
 *
 * Reads the `securityFailureRule` SEC-1 condition from risk-rules and returns the
 * severities it names, in canonical order. Throws if the rule is absent or names
 * no severities — a genuine compatibility problem, surfaced rather than guessed.
 */
export function projectSecurityFailureSeverities(riskRules: unknown): Severity[] {
  if (!isRecord(riskRules) || !isRecord(riskRules.securityFailureRule)) {
    throw new Error("risk rules: missing 'securityFailureRule'.");
  }
  const conditions = riskRules.securityFailureRule.conditions;
  if (!Array.isArray(conditions)) {
    throw new Error("risk rules: 'securityFailureRule.conditions' is not an array.");
  }
  const sec1 = conditions.find((c) => isRecord(c) && c.id === "SEC-1");
  if (!isRecord(sec1) || typeof sec1.text !== "string") {
    throw new Error("risk rules: missing 'SEC-1' condition text in 'securityFailureRule'.");
  }
  const named = SEVERITY_ORDER.filter((sev) => new RegExp(`\\b${sev}\\b`, "i").test(sec1.text as string));
  if (named.length === 0) {
    throw new Error("risk rules: 'SEC-1' condition names no severities.");
  }
  return named;
}

/** Pull a required nested value or record a problem. */
function req<T>(value: T | undefined, label: string, problems: string[]): T | undefined {
  if (value === undefined || value === null) {
    problems.push(`dataset: missing ${label}.`);
    return undefined;
  }
  return value;
}

export function adaptAgentFindingsToReleaseFindings(
  agent: AgentFindings,
  datasets: SyntheticDatasets,
): AdapterResult {
  const problems: string[] = [];

  const requirementDoc = isRecord(datasets.requirement) ? datasets.requirement : undefined;
  const requirement = isRecord(requirementDoc?.requirement) ? requirementDoc.requirement : undefined;
  const testsDoc = isRecord(datasets.existingTests) ? datasets.existingTests : undefined;
  const defectsDoc = isRecord(datasets.knownDefects) ? datasets.knownDefects : undefined;
  const riskRules = isRecord(datasets.riskRules) ? datasets.riskRules : undefined;

  if (!requirement) problems.push("dataset: requirement.requirement is missing or malformed.");
  if (!testsDoc || !Array.isArray(testsDoc.tests)) problems.push("dataset: existing-tests.tests is missing or malformed.");
  if (!defectsDoc || !Array.isArray(defectsDoc.defects)) problems.push("dataset: known-defects.defects is missing or malformed.");
  if (!riskRules) problems.push("dataset: risk-rules is missing or malformed.");
  if (problems.length > 0) return { ok: false, problems };

  const acList = Array.isArray(requirement!.acceptanceCriteria) ? requirement!.acceptanceCriteria : [];
  const testList = (testsDoc!.tests as unknown[]);
  const defectList = (defectsDoc!.defects as unknown[]);

  // --- authoritative ReleaseFindings, built from the datasets only ---
  const affectedAreas = req(requirement!.affectedAreas as string[] | undefined, "requirement.affectedAreas", problems);

  const acceptanceCriteria = acList.map((ac) => {
    const r = isRecord(ac) ? ac : {};
    return { id: r.id as string, area: r.area as string, critical: r.critical as boolean };
  });

  const tests = testList.map((t) => {
    const r = isRecord(t) ? t : {};
    return {
      testId: r.testId as string,
      area: r.area as string,
      testType: r.testType as "unit" | "integration" | "e2e",
      coverageType: r.coverageType as "positive" | "negative" | "boundary",
      status: r.status as "active" | "quarantined",
      covers: Array.isArray(r.covers) ? (r.covers as string[]) : [],
    };
  });

  const defects = defectList.map((d) => {
    const r = isRecord(d) ? d : {};
    return {
      defectId: r.defectId as string,
      severity: r.severity as Severity,
      status: r.status as "open" | "closed",
      area: r.area as string,
      security: r.security as boolean,
    };
  });

  const critRule = isRecord(riskRules!.criticalAcceptanceCriteriaRule) ? riskRules!.criticalAcceptanceCriteriaRule : undefined;
  const covRule = isRecord(riskRules!.insufficientCoverageRule) ? riskRules!.insufficientCoverageRule : undefined;
  const cov3 = Array.isArray(covRule?.conditions)
    ? covRule.conditions.find((c) => isRecord(c) && c.id === "COV-3")
    : undefined;

  const riskLevelsByArea = req(riskRules!.riskLevelsByArea as Record<string, "low" | "medium" | "high"> | undefined, "risk-rules.riskLevelsByArea", problems);
  const criticalAreas = req(critRule?.criticalAreas as string[] | undefined, "risk-rules.criticalAcceptanceCriteriaRule.criticalAreas", problems);
  const coverageRatioThreshold = req(
    isRecord(cov3) ? (cov3.illustrativeThreshold as number | undefined) : undefined,
    "risk-rules.insufficientCoverageRule COV-3 threshold",
    problems,
  );

  let securityFailureSeverities: Severity[] | undefined;
  try {
    securityFailureSeverities = projectSecurityFailureSeverities(riskRules);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }

  if (problems.length > 0) return { ok: false, problems };

  // --- grounding checks: the agent must have analysed THIS dataset ---
  const dp = agent.dataProvenance;
  const requirementId = requirement!.requirementId as string;
  const scenario = riskRules!.scenario as string;

  if (dp.requirementId !== requirementId) {
    problems.push(`grounding: agent requirementId "${dp.requirementId}" != dataset "${requirementId}".`);
  }
  if (dp.acceptanceCriteriaCount !== acceptanceCriteria.length) {
    problems.push(`grounding: agent acceptanceCriteriaCount ${dp.acceptanceCriteriaCount} != dataset ${acceptanceCriteria.length}.`);
  }
  if (dp.existingTestCount !== tests.length) {
    problems.push(`grounding: agent existingTestCount ${dp.existingTestCount} != dataset ${tests.length}.`);
  }
  if (dp.knownDefectCount !== defects.length) {
    problems.push(`grounding: agent knownDefectCount ${dp.knownDefectCount} != dataset ${defects.length}.`);
  }
  if (dp.riskRulesScenario !== scenario) {
    problems.push(`grounding: agent riskRulesScenario "${dp.riskRulesScenario}" != dataset "${scenario}".`);
  }

  const acIds = new Set(acceptanceCriteria.map((a) => a.id));
  const defectIds = new Set(defects.map((d) => d.defectId));
  for (const c of agent.coverageAssessment) {
    if (!acIds.has(c.acceptanceCriterionId)) {
      problems.push(`grounding: coverageAssessment references unknown acceptance criterion "${c.acceptanceCriterionId}".`);
    }
  }
  for (const d of agent.defectReview) {
    if (!defectIds.has(d.defectId)) {
      problems.push(`grounding: defectReview references unknown defect "${d.defectId}".`);
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  const releaseFindings: ReleaseFindings = {
    affectedAreas: affectedAreas!,
    acceptanceCriteria,
    defects,
    tests,
    riskRules: {
      riskLevelsByArea: riskLevelsByArea!,
      criticalAreas: criticalAreas!,
      coverageRatioThreshold: coverageRatioThreshold!,
      securityFailureSeverities: securityFailureSeverities!,
    },
  };

  // Final guard: reuse the Phase 3 structural validator unchanged.
  const structural = validateFindings(releaseFindings);
  if (!structural.ok) {
    return { ok: false, problems: structural.problems.map((p) => `adapted findings invalid: ${p}`) };
  }

  return { ok: true, releaseFindings };
}
