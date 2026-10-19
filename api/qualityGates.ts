/**
 * Read-only description of the quality gates, for the "Quality Gates" page.
 *
 * This module evaluates nothing and holds no thresholds of its own. Rule ids,
 * conditions, decisions and evaluation order are READ from `src/releaseGate.ts`
 * (`GATE_RULES`, `EVALUATION_ORDER`); the COV-/SEC- sub-conditions and the
 * coverage threshold are READ from the fixed policy (`buildPolicy`), the same
 * document shape the gate's adapter consumes. Only explanatory prose (titles,
 * purpose, evidence, where each fact is established) is written here, and
 * `tests/qualityGates.test.ts` fails if that prose drifts from the rule set.
 */

import { EVALUATION_ORDER, GATE_RULES, SECURITY_AREA } from "../src/releaseGate.ts";
import { HIGH_RISK_AREA_PATTERN, buildPolicy } from "./policy.ts";

export interface GateDoc {
  id: string;
  title: string;
  condition: string;
  decision: string;
  purpose: string;
  evidence: string[];
  riskRelationship: string;
  consequence: string;
  source: string;
}

export interface SubRuleDoc {
  id: string;
  text: string;
  threshold?: number;
}

export interface QualityGatesDoc {
  decisions: string[];
  evaluationOrder: readonly string[];
  evaluationNote: string;
  gates: GateDoc[];
  failSafe: { id: string; decision: string; condition: string; source: string };
  coverageRule: { description: string; conditions: SubRuleDoc[] };
  securityRule: { description: string; conditions: SubRuleDoc[] };
  flow: Array<{ label: string; text: string }>;
  riskDerivation: Array<{ label: string; text: string; source: string }>;
  evidenceSources: Array<{ label: string; text: string }>;
  limitations: string[];
}

/** Explanatory prose only, keyed by the gate id that `GATE_RULES` defines. */
const PROSE: Record<string, Pick<GateDoc, "title" | "purpose" | "evidence" | "riskRelationship" | "consequence" | "source">> = {
  "GATE-1": {
    title: "Critical Defect Open",
    purpose: "Blocks a release while a known defect rated critical is still open.",
    evidence: ["Known defects: status and severity"],
    riskRelationship: "Independent of the change risk level.",
    consequence: "NO_GO. Evaluation stops here; later gates are not consulted.",
    source: "src/releaseGate.ts, evaluateReleaseGate (GATE-1 block)",
  },
  "GATE-2": {
    title: "Security Failure",
    purpose: "Blocks a release when a serious security defect is open or a security acceptance criterion has no active test.",
    evidence: ["Known defects: status, severity, security flag", "Acceptance criteria in the security area", "Test cases: status and the criteria they cover"],
    riskRelationship: "Independent of the change risk level.",
    consequence: "NO_GO. The failing SEC conditions are listed as reasons.",
    source: "src/releaseGate.ts, securityFailure() and evaluateReleaseGate (GATE-2 block)",
  },
  "GATE-3": {
    title: "Critical Criterion Without Coverage",
    purpose: "Blocks a release when a critical acceptance criterion has no active test at all.",
    evidence: ["Acceptance criteria: critical flag and area", "Test cases: status and the criteria they cover", "Critical areas from the risk rules"],
    riskRelationship: "Does not use the change risk level. Critical areas can mark criteria as critical; for submitted evidence the critical areas are the high-risk areas.",
    consequence: "NO_GO. The uncovered criterion ids are listed as reasons.",
    source: "src/releaseGate.ts, criticalAcceptanceCriteria() and evaluateReleaseGate (GATE-3 block)",
  },
  "GATE-4": {
    title: "High-Risk Change With Insufficient Coverage",
    purpose: "Lets a high-risk change proceed only on conditions when test coverage is insufficient.",
    evidence: ["Affected areas and their inherent risk levels", "Acceptance criteria, test cases and defects (through the COV conditions)"],
    riskRelationship: "Applies only when the change risk level is high. Insufficient coverage alone does not trigger it.",
    consequence: "CONDITIONAL. The COV conditions that failed are listed as reasons.",
    source: "src/releaseGate.ts, changeRiskLevel(), insufficientCoverage() and evaluateReleaseGate (GATE-4 block)",
  },
  "GATE-6": {
    title: "Minimum Evidence",
    purpose: "Stops a release from being GO when no acceptance criterion has a passing test mapped to it. It is a minimum evidence floor, not proof of verification.",
    evidence: ["Test cases: only a passed status counts, and the test must be mapped to an acceptance criterion", "Acceptance criteria"],
    riskRelationship: "Independent of the change risk level. It adds no coverage threshold; it is the zero point of the coverage ratio.",
    consequence: "CONDITIONAL. Additional verification and review are required. It is evaluated after GATE-4 and before GATE-5, so GATE-1 to GATE-3 (NO_GO) and an existing GATE-4 result take precedence.",
    source: "src/releaseGate.ts, minimumEvidence() and evaluateReleaseGate (GATE-6 block)",
  },
  "GATE-5": {
    title: "No Blocking Condition",
    purpose: "Default outcome when none of GATE-1 to GATE-4 and GATE-6 matched.",
    evidence: ["The results of the earlier gates"],
    riskRelationship: "The reason text names the change risk level; the level does not change this outcome.",
    consequence: "GO. A GO means no rule blocked the release on the evidence supplied; it does not mean every criterion is verified. If coverage is below the illustrative threshold but the change is not high risk, the reasons say so and still list the COV conditions.",
    source: "src/releaseGate.ts, evaluateReleaseGate (GATE-5 return)",
  },
};

export function getQualityGates(): QualityGatesDoc {
  const policy = buildPolicy([], "quality-gates") as any;
  const rules = policy.releaseGateRules;
  const cov = policy.insufficientCoverageRule;
  const sec = policy.securityFailureRule;

  return {
    decisions: [...rules.decisions],
    evaluationOrder: EVALUATION_ORDER,
    evaluationNote:
      "Gates are checked strictly in this order and the first one whose condition holds decides the outcome; later gates are not evaluated. The gate function has no other inputs and no randomness.",
    gates: GATE_RULES.map((g) => ({
      id: g.id,
      condition: g.condition,
      decision: g.decision,
      ...(PROSE[g.id] ?? { title: g.id, purpose: "", evidence: [], riskRelationship: "", consequence: "", source: "src/releaseGate.ts" }),
    })),
    failSafe: {
      id: "FAIL_SAFE",
      decision: "NO_GO",
      condition: "The findings are missing, structurally invalid, or evaluating them throws an unexpected error.",
      source: "src/releaseGate.ts, validateFindings() and the catch in evaluateReleaseGate",
    },
    coverageRule: { description: cov.description, conditions: cov.conditions.map(toSubRule) },
    securityRule: { description: sec.description, conditions: sec.conditions.map(toSubRule) },
    flow: [
      { label: "Evidence", text: "Acceptance criteria, test cases and defects come from the fixture datasets or from what you submit." },
      { label: "AI analysis", text: "The QA agent explains the risk. It is advisory and its output is rejected if it contains a decision." },
      { label: "Validation and adaptation", text: "The agent output is validated and cross-checked against the datasets. The gate input is built from dataset facts, not from AI claims. A mismatch fails safe." },
      { label: "Deterministic gate", text: "evaluateReleaseGate() checks the gates in order and the first match decides." },
      { label: "Report", text: "The report carries the gate's decision, the rule that fired and its reasons." },
    ],
    riskDerivation: [
      {
        label: "Change risk level",
        text: "The highest inherent risk level among the affected areas (low, medium or high). It is a category, not a numeric score; no weights or formulas are involved.",
        source: "src/releaseGate.ts, changeRiskLevel()",
      },
      {
        label: "Area risk level for submitted evidence",
        text: `Each area is high risk when its name matches this pattern, otherwise medium: ${HIGH_RISK_AREA_PATTERN.source.replace(/^\(|\)$/g, "").split("|").join(", ")}. An area is never assigned low risk here.`,
        source: "api/policy.ts, classifyAreaRisk()",
      },
      {
        label: "Area risk level for the regression fixture",
        text: "Taken from the fixed risk-rules dataset for the fixture (riskLevelsByArea).",
        source: "data/risk-rules.json",
      },
      {
        label: "Critical acceptance criterion",
        text: "A criterion flagged critical, or one whose area is listed as a critical area. For submitted evidence, every high-risk area is a critical area.",
        source: "src/releaseGate.ts, criticalAcceptanceCriteria(); api/policy.ts, buildPolicy()",
      },
    ],
    evidenceSources: [
      { label: "Acceptance criteria and affected areas", text: "The requirement dataset, or the context and criteria you submit." },
      { label: "Test cases", text: "The existing-tests dataset, or the test cases you submit. A test counts as active only when its status is active; for submitted evidence only a passed result is mapped to active, and every other status is treated as quarantined." },
      { label: "Defects", text: "The known-defects dataset, or the defects you submit (status, severity, security flag, area)." },
      { label: "Rules", text: "The risk-rules dataset for the fixture, or a fixed policy for submitted evidence. Submitted evidence can never change the rules." },
      { label: "AI analysis", text: "Advisory only. The gate's facts come from the datasets above, not from the AI's statements, and the AI output is rejected if it contains a decision." },
    ],
    limitations: [
      `The coverage threshold in COV-3 is labelled illustrative in the rules (${cov.conditions.find((c: any) => c.id === "COV-3")?.illustrativeThreshold}); no setting in this application changes it.`,
      "Gates have no separate severity rating: each gate's only consequence is the decision it returns.",
      "There is no numeric risk score. Risk influences the outcome only through the change risk level in GATE-4.",
      "The conditions needed to move a CONDITIONAL decision to GO are not defined beyond the reasons the gate lists.",
      "GATE-6 is a floor, not proof: it needs one passing test mapped to one acceptance criterion. It does not show that any other criterion, or any business rule, is verified. No gate evaluates business rules.",
      "When some coverage exists but is below the illustrative COV-3 threshold and the change is not high risk, GATE-5 still returns GO and its reasons list COV-3. A GO does not establish that every criterion has been verified.",
      "Failed or blocked tests do not change the decision once GATE-6 is satisfied; they remain visible in the report.",
      "Only a recognised passed result counts as passing. For submitted evidence any other status text (for example OK) is treated as not passing.",
      `SEC-2 only looks at acceptance criteria whose area is exactly "${SECURITY_AREA}".`,
    ],
  };
}

function toSubRule(c: any): SubRuleDoc {
  return {
    id: String(c.id),
    text: String(c.text),
    ...(typeof c.illustrativeThreshold === "number" ? { threshold: c.illustrativeThreshold } : {}),
  };
}
