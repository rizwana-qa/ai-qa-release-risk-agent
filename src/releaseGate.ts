/**
 * Deterministic release gate.
 *
 * This module is a PURE decision function. It has no I/O, no randomness, no time
 * dependence, no external services, no AI/LLM calls, no MCP calls, and no n8n
 * integration. Given the same `findings` it always returns the same result.
 *
 * The language model in later phases may *explain* the reasoning, but the final
 * GO / NO_GO / CONDITIONAL decision is produced here, by code.
 *
 * Rule precedence (evaluated strictly in this order; the first match wins):
 *
 *   GATE-1  Critical defect open .......................... NO_GO
 *   GATE-2  Security failure ............................... NO_GO
 *   GATE-3  Critical acceptance criterion with no coverage . NO_GO
 *   GATE-4  High-risk change + insufficient coverage ....... CONDITIONAL
 *   GATE-5  Otherwise ..................................... GO
 *
 * Fail-safe: if `findings` is missing, not an object, or structurally invalid,
 * the gate returns NO_GO with `firedRule: "FAIL_SAFE"`. Missing data is never
 * treated as safe.
 */

/* -------------------------------------------------------------------------- */
/* Domain types                                                              */
/* -------------------------------------------------------------------------- */

export type RiskLevel = "low" | "medium" | "high";
export type Severity = "critical" | "high" | "medium" | "low";
export type DefectStatus = "open" | "closed";
export type TestType = "unit" | "integration" | "e2e";
export type CoverageType = "positive" | "negative" | "boundary";
export type TestStatus = "active" | "quarantined";
export type Decision = "GO" | "NO_GO" | "CONDITIONAL";

export interface AcceptanceCriterion {
  id: string;
  area: string;
  /** Explicitly marked critical by the requirement author. */
  critical: boolean;
}

export interface Defect {
  defectId: string;
  severity: Severity;
  status: DefectStatus;
  area: string;
  /** True when the defect is security-relevant. */
  security: boolean;
}

export interface TestCase {
  testId: string;
  area: string;
  testType: TestType;
  coverageType: CoverageType;
  status: TestStatus;
  /** Acceptance-criterion ids this test exercises. */
  covers: string[];
}

export interface RiskRules {
  /** Inherent risk level for each area name. */
  riskLevelsByArea: Record<string, RiskLevel>;
  /** Areas whose acceptance criteria are always treated as critical. */
  criticalAreas: string[];
  /** COV-3 threshold: minimum acceptable active AC-coverage ratio (0 < x <= 1). */
  coverageRatioThreshold: number;
  /** SEC-1 severities: an open security defect at one of these severities is a failure. */
  securityFailureSeverities: Severity[];
}

export interface ReleaseFindings {
  /** Areas touched by the change. Each must have an entry in riskLevelsByArea. */
  affectedAreas: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  defects: Defect[];
  tests: TestCase[];
  riskRules: RiskRules;
}

export interface GateResult {
  decision: Decision;
  /** "GATE-1".."GATE-5", or "FAIL_SAFE" for invalid input. */
  firedRule: string;
  /** Human-readable justification lines, in evaluation order. */
  reasons: string[];
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                 */
/* -------------------------------------------------------------------------- */

export const EVALUATION_ORDER = [
  "GATE-1",
  "GATE-2",
  "GATE-3",
  "GATE-4",
  "GATE-5",
] as const;

/** Documentation of each rule; kept next to the implementation for traceability. */
export const GATE_RULES: ReadonlyArray<{ id: string; condition: string; decision: Decision }> = [
  { id: "GATE-1", condition: "At least one defect with status 'open' and severity 'critical'.", decision: "NO_GO" },
  { id: "GATE-2", condition: "securityFailure() is true (SEC-1 open security defect, or SEC-2 uncovered security AC).", decision: "NO_GO" },
  { id: "GATE-3", condition: "At least one critical acceptance criterion with zero active test coverage.", decision: "NO_GO" },
  { id: "GATE-4", condition: "changeRiskLevel() is 'high' AND insufficientCoverage() is true.", decision: "CONDITIONAL" },
  { id: "GATE-5", condition: "None of the above.", decision: "GO" },
];

const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high"];
const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];
const DEFECT_STATUSES: readonly DefectStatus[] = ["open", "closed"];
const TEST_TYPES: readonly TestType[] = ["unit", "integration", "e2e"];
const COVERAGE_TYPES: readonly CoverageType[] = ["positive", "negative", "boundary"];
const TEST_STATUSES: readonly TestStatus[] = ["active", "quarantined"];

/** Canonical area name whose acceptance criteria drive the SEC-2 check. */
export const SECURITY_AREA = "security";

/* -------------------------------------------------------------------------- */
/* Helper predicates                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Overall risk level of the change: the highest inherent risk among the
 * affected areas. Always derived from `affectedAreas` + `riskLevelsByArea`;
 * there is deliberately no caller-supplied override (which could weaken the gate).
 */
export function changeRiskLevel(findings: ReleaseFindings): RiskLevel {
  let max: RiskLevel = "low";
  for (const area of findings.affectedAreas) {
    const level = findings.riskRules.riskLevelsByArea[area];
    if (RISK_LEVELS.indexOf(level) > RISK_LEVELS.indexOf(max)) {
      max = level;
    }
  }
  return max;
}

/**
 * The acceptance criteria treated as critical: those explicitly flagged
 * `critical`, plus any whose area is listed in `riskRules.criticalAreas`.
 */
export function criticalAcceptanceCriteria(findings: ReleaseFindings): AcceptanceCriterion[] {
  const criticalAreas = new Set(findings.riskRules.criticalAreas);
  return findings.acceptanceCriteria.filter(
    (ac) => ac.critical === true || criticalAreas.has(ac.area),
  );
}

/** Number of active (non-quarantined) tests that cover a given acceptance criterion. */
function activeCoverageCount(findings: ReleaseFindings, acceptanceCriterionId: string): number {
  return findings.tests.filter(
    (t) => t.status === "active" && t.covers.includes(acceptanceCriterionId),
  ).length;
}

/**
 * Coverage is "insufficient" when ANY of the documented conditions hold:
 *   COV-1  a critical acceptance criterion has zero active tests
 *   COV-2  a high-risk affected area has no active negative test
 *   COV-3  the active AC-coverage ratio is below `coverageRatioThreshold`
 *
 * (COV-1 overlaps GATE-3; it is kept here so the predicate matches the
 * documented rule set even when called on its own.)
 */
export function insufficientCoverage(findings: ReleaseFindings): { insufficient: boolean; reasons: string[] } {
  const reasons: string[] = [];

  const cov1 = criticalAcceptanceCriteria(findings).filter(
    (ac) => activeCoverageCount(findings, ac.id) === 0,
  );
  if (cov1.length > 0) {
    reasons.push(`COV-1: critical acceptance criteria without active coverage: ${cov1.map((a) => a.id).join(", ")}.`);
  }

  const highRiskAreas = findings.affectedAreas.filter(
    (area) => findings.riskRules.riskLevelsByArea[area] === "high",
  );
  const cov2 = highRiskAreas.filter(
    (area) => !findings.tests.some(
      (t) => t.area === area && t.status === "active" && t.coverageType === "negative",
    ),
  );
  if (cov2.length > 0) {
    reasons.push(`COV-2: high-risk areas without an active negative test: ${cov2.join(", ")}.`);
  }

  const total = findings.acceptanceCriteria.length;
  const covered = findings.acceptanceCriteria.filter(
    (ac) => activeCoverageCount(findings, ac.id) > 0,
  ).length;
  const ratio = total === 0 ? 0 : covered / total;
  if (ratio < findings.riskRules.coverageRatioThreshold) {
    reasons.push(
      `COV-3: active acceptance-criterion coverage ratio ${ratio.toFixed(2)} is below threshold ${findings.riskRules.coverageRatioThreshold}.`,
    );
  }

  return { insufficient: reasons.length > 0, reasons };
}

/**
 * A "security failure" exists when ANY of the documented conditions hold:
 *   SEC-1  an open, security-flagged defect at a qualifying severity
 *   SEC-2  a security-area acceptance criterion with zero active tests
 */
export function securityFailure(findings: ReleaseFindings): { failed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const qualifying = new Set(findings.riskRules.securityFailureSeverities);

  const sec1 = findings.defects.filter(
    (d) => d.status === "open" && d.security === true && qualifying.has(d.severity),
  );
  if (sec1.length > 0) {
    reasons.push(`SEC-1: open security-flagged defect(s) at qualifying severity: ${sec1.map((d) => d.defectId).join(", ")}.`);
  }

  const sec2 = findings.acceptanceCriteria.filter(
    (ac) => ac.area === SECURITY_AREA && activeCoverageCount(findings, ac.id) === 0,
  );
  if (sec2.length > 0) {
    reasons.push(`SEC-2: security acceptance criteria without active coverage: ${sec2.map((a) => a.id).join(", ")}.`);
  }

  return { failed: reasons.length > 0, reasons };
}

/* -------------------------------------------------------------------------- */
/* Input validation (fail-safe)                                              */
/* -------------------------------------------------------------------------- */

type ValidationResult =
  | { ok: true; findings: ReleaseFindings }
  | { ok: false; problems: string[] };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

/**
 * Structurally validate arbitrary input. Returns typed findings on success, or a
 * list of problems on failure. Anything it cannot vouch for is a problem — it
 * never fills in defaults.
 */
export function validateFindings(input: unknown): ValidationResult {
  const problems: string[] = [];

  if (!isRecord(input)) {
    return { ok: false, problems: [`findings: expected an object, received ${input === null ? "null" : typeof input}.`] };
  }

  // affectedAreas
  const affectedAreas = input.affectedAreas;
  if (!Array.isArray(affectedAreas) || affectedAreas.length === 0 || !affectedAreas.every(isNonEmptyString)) {
    problems.push("affectedAreas: expected a non-empty array of non-empty strings.");
  }

  // acceptanceCriteria
  const acceptanceCriteria = input.acceptanceCriteria;
  if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0) {
    problems.push("acceptanceCriteria: expected a non-empty array.");
  } else {
    acceptanceCriteria.forEach((ac, i) => {
      if (!isRecord(ac)) { problems.push(`acceptanceCriteria[${i}]: expected an object.`); return; }
      if (!isNonEmptyString(ac.id)) problems.push(`acceptanceCriteria[${i}].id: expected a non-empty string.`);
      if (!isNonEmptyString(ac.area)) problems.push(`acceptanceCriteria[${i}].area: expected a non-empty string.`);
      if (typeof ac.critical !== "boolean") problems.push(`acceptanceCriteria[${i}].critical: expected a boolean.`);
    });
  }

  // defects
  const defects = input.defects;
  if (!Array.isArray(defects)) {
    problems.push("defects: expected an array.");
  } else {
    defects.forEach((d, i) => {
      if (!isRecord(d)) { problems.push(`defects[${i}]: expected an object.`); return; }
      if (!isNonEmptyString(d.defectId)) problems.push(`defects[${i}].defectId: expected a non-empty string.`);
      if (!SEVERITIES.includes(d.severity as Severity)) problems.push(`defects[${i}].severity: expected one of ${SEVERITIES.join(", ")}.`);
      if (!DEFECT_STATUSES.includes(d.status as DefectStatus)) problems.push(`defects[${i}].status: expected one of ${DEFECT_STATUSES.join(", ")}.`);
      if (!isNonEmptyString(d.area)) problems.push(`defects[${i}].area: expected a non-empty string.`);
      if (typeof d.security !== "boolean") problems.push(`defects[${i}].security: expected a boolean.`);
    });
  }

  // tests
  const tests = input.tests;
  if (!Array.isArray(tests)) {
    problems.push("tests: expected an array.");
  } else {
    tests.forEach((t, i) => {
      if (!isRecord(t)) { problems.push(`tests[${i}]: expected an object.`); return; }
      if (!isNonEmptyString(t.testId)) problems.push(`tests[${i}].testId: expected a non-empty string.`);
      if (!isNonEmptyString(t.area)) problems.push(`tests[${i}].area: expected a non-empty string.`);
      if (!TEST_TYPES.includes(t.testType as TestType)) problems.push(`tests[${i}].testType: expected one of ${TEST_TYPES.join(", ")}.`);
      if (!COVERAGE_TYPES.includes(t.coverageType as CoverageType)) problems.push(`tests[${i}].coverageType: expected one of ${COVERAGE_TYPES.join(", ")}.`);
      if (!TEST_STATUSES.includes(t.status as TestStatus)) problems.push(`tests[${i}].status: expected one of ${TEST_STATUSES.join(", ")}.`);
      if (!Array.isArray(t.covers) || !t.covers.every(isNonEmptyString)) problems.push(`tests[${i}].covers: expected an array of non-empty strings.`);
    });
  }

  // riskRules
  const riskRules = input.riskRules;
  if (!isRecord(riskRules)) {
    problems.push("riskRules: expected an object.");
  } else {
    const rlba = riskRules.riskLevelsByArea;
    if (!isRecord(rlba) || Object.keys(rlba).length === 0) {
      problems.push("riskRules.riskLevelsByArea: expected a non-empty object of area -> risk level.");
    } else {
      for (const [area, level] of Object.entries(rlba)) {
        if (!RISK_LEVELS.includes(level as RiskLevel)) {
          problems.push(`riskRules.riskLevelsByArea.${area}: expected one of ${RISK_LEVELS.join(", ")}.`);
        }
      }
    }
    if (!Array.isArray(riskRules.criticalAreas) || !riskRules.criticalAreas.every(isNonEmptyString)) {
      problems.push("riskRules.criticalAreas: expected an array of non-empty strings.");
    }
    if (typeof riskRules.coverageRatioThreshold !== "number" ||
        Number.isNaN(riskRules.coverageRatioThreshold) ||
        riskRules.coverageRatioThreshold <= 0 ||
        riskRules.coverageRatioThreshold > 1) {
      problems.push("riskRules.coverageRatioThreshold: expected a number in (0, 1].");
    }
    if (!Array.isArray(riskRules.securityFailureSeverities) ||
        riskRules.securityFailureSeverities.length === 0 ||
        !riskRules.securityFailureSeverities.every((s) => SEVERITIES.includes(s as Severity))) {
      problems.push("riskRules.securityFailureSeverities: expected a non-empty array of severities.");
    }
  }

  // Cross-field: every affected area must have an inherent risk level.
  if (Array.isArray(affectedAreas) && isRecord(riskRules) && isRecord(riskRules.riskLevelsByArea)) {
    const rlba = riskRules.riskLevelsByArea as Record<string, unknown>;
    for (const area of affectedAreas) {
      if (isNonEmptyString(area) && !(area in rlba)) {
        problems.push(`affectedAreas: "${area}" has no entry in riskRules.riskLevelsByArea.`);
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, findings: input as unknown as ReleaseFindings };
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate the deterministic release gate.
 *
 * @param input Arbitrary, untrusted input. Expected to conform to
 *              {@link ReleaseFindings}; anything else fails safe to NO_GO.
 */
export function evaluateReleaseGate(input: unknown): GateResult {
  try {
    const validation = validateFindings(input);
    if (!validation.ok) {
      return {
        decision: "NO_GO",
        firedRule: "FAIL_SAFE",
        reasons: [
          "Findings are missing or malformed; failing safe to NO_GO (missing data is not treated as safe).",
          ...validation.problems,
        ],
      };
    }

    const findings = validation.findings;

    // GATE-1 — Critical defect open.
    const openCriticalDefects = findings.defects.filter(
      (d) => d.status === "open" && d.severity === "critical",
    );
    if (openCriticalDefects.length > 0) {
      return {
        decision: "NO_GO",
        firedRule: "GATE-1",
        reasons: [`GATE-1: open critical defect(s): ${openCriticalDefects.map((d) => d.defectId).join(", ")}.`],
      };
    }

    // GATE-2 — Security failure.
    const security = securityFailure(findings);
    if (security.failed) {
      return {
        decision: "NO_GO",
        firedRule: "GATE-2",
        reasons: ["GATE-2: security failure.", ...security.reasons],
      };
    }

    // GATE-3 — Critical acceptance criterion with no coverage.
    const uncoveredCritical = criticalAcceptanceCriteria(findings).filter(
      (ac) => activeCoverageCount(findings, ac.id) === 0,
    );
    if (uncoveredCritical.length > 0) {
      return {
        decision: "NO_GO",
        firedRule: "GATE-3",
        reasons: [`GATE-3: critical acceptance criterion/criteria with no active coverage: ${uncoveredCritical.map((a) => a.id).join(", ")}.`],
      };
    }

    // GATE-4 — High-risk change + insufficient coverage.
    const risk = changeRiskLevel(findings);
    const coverage = insufficientCoverage(findings);
    if (risk === "high" && coverage.insufficient) {
      return {
        decision: "CONDITIONAL",
        firedRule: "GATE-4",
        reasons: ["GATE-4: change risk level is 'high' and coverage is insufficient.", ...coverage.reasons],
      };
    }

    // GATE-5 — Otherwise.
    return {
      decision: "GO",
      firedRule: "GATE-5",
      reasons: [`GATE-5: no blocking condition met (change risk level: ${risk}; coverage adequate).`],
    };
  } catch (err) {
    // Any unexpected error also fails safe.
    return {
      decision: "NO_GO",
      firedRule: "FAIL_SAFE",
      reasons: [
        "Unexpected error while evaluating the release gate; failing safe to NO_GO.",
        err instanceof Error ? err.message : String(err),
      ],
    };
  }
}
