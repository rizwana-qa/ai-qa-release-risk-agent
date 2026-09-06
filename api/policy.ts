/**
 * Fixed QA release-risk policy for user-submitted assessments.
 *
 * The user supplies EVIDENCE (release context, acceptance criteria, tests,
 * defects). They never supply POLICY. `buildPolicy()` produces a `risk-rules`
 * document in the exact shape of `data/risk-rules.json`, derived only from the
 * set of areas the user's evidence touches. The deterministic gate rules
 * themselves live in `src/releaseGate.ts` and cannot be influenced by any input.
 */

export type AreaRisk = "high" | "medium";

/** Input-length / count limits enforced by the normalizer. */
export const LIMITS = {
  text: 20_000,
  shortText: 4_000,
  name: 200,
  label: 60,
  area: 120,
  title: 500,
  acceptanceCriteria: 200,
  businessRules: 200,
  testCases: 500,
  knownDefects: 500,
  supportingDocuments: 50,
  fileBytes: 25 * 1024 * 1024,
} as const;

const HIGH_RISK_AREA = /(secur|auth|authz|access.?control|privac|complian|gdpr|hipaa|pci|payment|billing|credential|encrypt|pii|token|session|permission|identity)/i;

/** Classify a normalized area slug as high or medium inherent risk. */
export function classifyAreaRisk(area: string): AreaRisk {
  return HIGH_RISK_AREA.test(area) ? "high" : "medium";
}

/** Normalize a free-text area name to a stable slug. */
export function slugifyArea(raw: unknown): string {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "general";
}

/**
 * Build the risk-rules document for exactly `areas`. Structure mirrors
 * `data/risk-rules.json` so the existing adapter / gate consume it unchanged.
 */
export function buildPolicy(areas: readonly string[], scenarioId: string): Record<string, unknown> {
  const uniqueAreas = [...new Set(areas)].filter(Boolean);
  const riskLevelsByArea: Record<string, AreaRisk> = {};
  for (const a of uniqueAreas) riskLevelsByArea[a] = classifyAreaRisk(a);
  const criticalAreas = uniqueAreas.filter((a) => riskLevelsByArea[a] === "high");

  return {
    schemaVersion: "1.0",
    synthetic: true,
    disclaimer:
      "Fixed QA release-risk policy applied to a user-submitted assessment. Risk levels are derived from area classification. Users cannot modify the deterministic release gate rules.",
    servedByTool: "get_risk_rules",
    scenario: scenarioId,
    areas: uniqueAreas,
    riskLevelsByArea,
    riskLevelOrdering: ["low", "medium", "high"],
    changeRiskLevelRule: {
      description:
        "The overall risk level of a change is the highest riskLevelsByArea value among the requirement's affectedAreas.",
    },
    criticalAcceptanceCriteriaRule: {
      description:
        "An acceptance criterion is treated as critical when its 'critical' flag is true, OR when its area is one of the listed criticalAreas.",
      criticalAreas,
    },
    insufficientCoverageRule: {
      description: "Coverage for the change is 'insufficient' if ANY of the following conditions is true.",
      conditions: [
        { id: "COV-1", text: "A critical acceptance criterion has zero active mapped tests (a test whose status is 'active')." },
        { id: "COV-2", text: "A high-risk affected area has no active test with coverageType 'negative'." },
        {
          id: "COV-3",
          text: "The active acceptance-criterion coverage ratio (criteria with at least one active test, divided by total criteria) is below the illustrative threshold.",
          illustrativeThreshold: 0.8,
        },
      ],
    },
    securityFailureRule: {
      description: "A 'security failure' exists if ANY of the following is true.",
      conditions: [
        { id: "SEC-1", text: "There is a defect with status 'open', security = true, and severity 'critical' or 'high'." },
        { id: "SEC-2", text: "An acceptance criterion whose area is 'security' has zero active mapped tests." },
      ],
    },
    regressionPriorityRule: {
      description: "Rank affected areas for regression testing by the following ordered factors; earlier factors dominate.",
      factors: [
        "Inherent area risk from riskLevelsByArea (high before medium before low).",
        "Area has one or more open defects.",
        "Area has a critical acceptance criterion that has no active coverage.",
        "Area is security-sensitive.",
      ],
    },
    releaseGateRules: {
      note:
        "These deterministic rules are the final release decision authority. They are enforced by evaluateReleaseGate() in code and cannot be altered by user input.",
      decisions: ["GO", "NO_GO", "CONDITIONAL"],
      evaluationOrder: ["GATE-1", "GATE-2", "GATE-3", "GATE-4", "GATE-5"],
      rules: [
        { id: "GATE-1", condition: "At least one defect with status 'open' and severity 'critical'.", decision: "NO_GO" },
        { id: "GATE-2", condition: "securityFailureRule evaluates to true.", decision: "NO_GO" },
        { id: "GATE-3", condition: "At least one critical acceptance criterion with zero active mapped tests.", decision: "NO_GO" },
        { id: "GATE-4", condition: "changeRiskLevel is 'high' AND insufficientCoverageRule evaluates to true.", decision: "CONDITIONAL" },
        { id: "GATE-5", condition: "None of the above conditions are met.", decision: "GO" },
      ],
    },
  };
}
