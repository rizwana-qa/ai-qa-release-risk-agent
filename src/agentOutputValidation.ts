/**
 * Structural validation of raw LLM agent output.
 *
 * Runs BEFORE the adapter and the gate. It never fills in defaults and never
 * guesses: anything it cannot vouch for is a problem, and a problem means the
 * pipeline fails safe (NO_GO) rather than proceeding.
 */

import {
  type AgentFindings,
  type FindingSeverity,
  type PriorityLevel,
  FORBIDDEN_OUTPUT_KEYS,
} from "./agentContract.ts";

export type AgentOutputValidation =
  | { ok: true; findings: AgentFindings }
  | { ok: false; problems: string[] };

const SEVERITIES: readonly FindingSeverity[] = ["critical", "high", "medium", "low"];
const PRIORITIES: readonly PriorityLevel[] = ["high", "medium", "low"];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}
function isString(x: unknown): x is string {
  return typeof x === "string";
}
function isNonNegativeInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0;
}

export function validateAgentFindings(input: unknown): AgentOutputValidation {
  const problems: string[] = [];

  if (!isRecord(input)) {
    return { ok: false, problems: [`agent output: expected an object, received ${input === null ? "null" : typeof input}.`] };
  }

  // The LLM must not emit a decision of any kind.
  for (const key of FORBIDDEN_OUTPUT_KEYS) {
    if (key in input) {
      problems.push(`agent output: forbidden key "${key}" — the language model must not provide a release decision.`);
    }
  }

  if (input.schemaVersion !== 1) {
    problems.push('agent output: "schemaVersion" must be the number 1.');
  }
  if (!isNonEmptyString(input.changeSummary)) {
    problems.push('agent output: "changeSummary" must be a non-empty string.');
  }
  if (!isNonEmptyString(input.releaseRiskExplanation)) {
    problems.push('agent output: "releaseRiskExplanation" must be a non-empty string.');
  }

  // identifiedRisks
  if (!Array.isArray(input.identifiedRisks) || input.identifiedRisks.length === 0) {
    problems.push('agent output: "identifiedRisks" must be a non-empty array.');
  } else {
    input.identifiedRisks.forEach((r, i) => {
      if (!isRecord(r)) { problems.push(`identifiedRisks[${i}]: expected an object.`); return; }
      if (!isNonEmptyString(r.area)) problems.push(`identifiedRisks[${i}].area: expected a non-empty string.`);
      if (!isNonEmptyString(r.description)) problems.push(`identifiedRisks[${i}].description: expected a non-empty string.`);
      if (!SEVERITIES.includes(r.severity as FindingSeverity)) problems.push(`identifiedRisks[${i}].severity: expected one of ${SEVERITIES.join(", ")}.`);
    });
  }

  // coverageAssessment
  if (!Array.isArray(input.coverageAssessment) || input.coverageAssessment.length === 0) {
    problems.push('agent output: "coverageAssessment" must be a non-empty array.');
  } else {
    input.coverageAssessment.forEach((c, i) => {
      if (!isRecord(c)) { problems.push(`coverageAssessment[${i}]: expected an object.`); return; }
      if (!isNonEmptyString(c.acceptanceCriterionId)) problems.push(`coverageAssessment[${i}].acceptanceCriterionId: expected a non-empty string.`);
      if (typeof c.covered !== "boolean") problems.push(`coverageAssessment[${i}].covered: expected a boolean.`);
      if (!isString(c.notes)) problems.push(`coverageAssessment[${i}].notes: expected a string.`);
    });
  }

  // missingScenarios
  if (!Array.isArray(input.missingScenarios) || !input.missingScenarios.every(isNonEmptyString)) {
    problems.push('agent output: "missingScenarios" must be an array of non-empty strings.');
  }

  // defectReview
  if (!Array.isArray(input.defectReview)) {
    problems.push('agent output: "defectReview" must be an array.');
  } else {
    input.defectReview.forEach((d, i) => {
      if (!isRecord(d)) { problems.push(`defectReview[${i}]: expected an object.`); return; }
      if (!isNonEmptyString(d.defectId)) problems.push(`defectReview[${i}].defectId: expected a non-empty string.`);
      if (typeof d.stillRelevant !== "boolean") problems.push(`defectReview[${i}].stillRelevant: expected a boolean.`);
      if (!isString(d.notes)) problems.push(`defectReview[${i}].notes: expected a string.`);
    });
  }

  // regressionPriorities
  if (!Array.isArray(input.regressionPriorities) || input.regressionPriorities.length === 0) {
    problems.push('agent output: "regressionPriorities" must be a non-empty array.');
  } else {
    input.regressionPriorities.forEach((p, i) => {
      if (!isRecord(p)) { problems.push(`regressionPriorities[${i}]: expected an object.`); return; }
      if (!isNonEmptyString(p.area)) problems.push(`regressionPriorities[${i}].area: expected a non-empty string.`);
      if (!PRIORITIES.includes(p.priority as PriorityLevel)) problems.push(`regressionPriorities[${i}].priority: expected one of ${PRIORITIES.join(", ")}.`);
      if (!isString(p.rationale)) problems.push(`regressionPriorities[${i}].rationale: expected a string.`);
    });
  }

  // dataProvenance
  const dp = input.dataProvenance;
  if (!isRecord(dp)) {
    problems.push('agent output: "dataProvenance" must be an object.');
  } else {
    if (!isNonEmptyString(dp.requirementId)) problems.push("dataProvenance.requirementId: expected a non-empty string.");
    if (!isNonEmptyString(dp.riskRulesScenario)) problems.push("dataProvenance.riskRulesScenario: expected a non-empty string.");
    if (!isNonNegativeInt(dp.acceptanceCriteriaCount)) problems.push("dataProvenance.acceptanceCriteriaCount: expected a non-negative integer.");
    if (!isNonNegativeInt(dp.existingTestCount)) problems.push("dataProvenance.existingTestCount: expected a non-negative integer.");
    if (!isNonNegativeInt(dp.knownDefectCount)) problems.push("dataProvenance.knownDefectCount: expected a non-negative integer.");
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, findings: input as unknown as AgentFindings };
}
