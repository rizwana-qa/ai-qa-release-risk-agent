/**
 * Rules-based (offline) QA analysis.
 *
 * Produces a `validateAgentFindings`-valid `AgentFindings` from the normalized
 * datasets by RESTATING the user's own submitted evidence — it invents nothing,
 * makes no GO / NO_GO / CONDITIONAL judgment, and echoes exact provenance so the
 * existing adapter's grounding checks pass.
 *
 * Used when no `GEMINI_API_KEY` is available, or when a live Gemini call
 * fails to produce valid, gate-ready findings. Technical Details reports
 * "Execution Mode: Rules based" so this is never presented as live AI.
 */

import type { AgentFindings, FindingSeverity, PriorityLevel } from "../src/agentContract.ts";
import type { NormalizedDatasets, AssessmentContext, CoverageStats } from "./inputNormalizer.ts";

const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** Grammatically correct singular/plural for a restated count — never a
 * literal "(s)" placeholder left unresolved in user-facing report text. */
function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return n === 1 ? singular : pluralForm;
}

/**
 * A one-line summary should read as a summary, not a mid-clause slice — cut
 * at the last sentence boundary within the limit when there is one, so it
 * never ends abruptly with neither a start nor an outcome.
 */
function summarize(text: string, maxLen = 240): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  const window = trimmed.slice(0, maxLen);
  const lastSentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"));
  if (lastSentenceEnd > maxLen * 0.4) return window.slice(0, lastSentenceEnd + 1);
  const lastSpace = window.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? window.slice(0, lastSpace) : window).trimEnd() + "…";
}

interface DbAc { id: string; area: string; critical: boolean; text: string }
interface DbTest { testId: string; area: string; status: string; covers: string[] }
interface DbDefect { defectId: string; severity: string; status: string; area: string; security: boolean }
interface DbCov { acceptanceCriterionId: string; area: string; covered: boolean; activeTests: string[]; mappedTests: string[] }

export function analyzeEvidence(
  datasets: NormalizedDatasets,
  context: AssessmentContext,
  coverageStats: CoverageStats,
): AgentFindings {
  const req = (datasets.requirement as any).requirement;
  const acs: DbAc[] = req.acceptanceCriteria;
  const tests: DbTest[] = (datasets.existingTests as any).tests;
  const covMap: DbCov[] = (datasets.existingTests as any).coverageByAcceptanceCriterion;
  const defects: DbDefect[] = (datasets.knownDefects as any).defects;
  const criticalAreas = new Set<string>((datasets.riskRules as any).criticalAcceptanceCriteriaRule.criticalAreas);

  const isCritical = (ac: DbAc) => ac.critical || criticalAreas.has(ac.area);
  const coveredIds = new Set(covMap.filter((c) => c.covered).map((c) => c.acceptanceCriterionId));
  const uncoveredCritical = acs.filter((ac) => isCritical(ac) && !coveredIds.has(ac.id));
  const openDefects = defects.filter((d) => d.status === "open");
  const openCritical = openDefects.filter((d) => d.severity === "critical");
  const openSecurity = openDefects.filter((d) => d.security && (d.severity === "critical" || d.severity === "high"));

  /* ---- identified risks: dedup by area, restatements only ---- */
  const riskByArea = new Map<string, { area: string; description: string; severity: FindingSeverity }>();
  for (const d of openDefects) {
    const sameArea = openDefects.filter((x) => x.area === d.area);
    const ids = sameArea.map((x) => x.defectId).join(", ");
    const sev = (d.security ? "critical" : d.severity) as FindingSeverity;
    const cur = riskByArea.get(d.area);
    if (!cur || (SEV_RANK[sev] ?? 0) > (SEV_RANK[cur.severity] ?? 0)) {
      riskByArea.set(d.area, {
        area: d.area,
        description: `${plural(sameArea.length, "Open defect", "Open defects")} in this area: ${ids}${d.security ? " (security-related)" : ""}.`,
        severity: sev,
      });
    }
  }
  for (const ac of uncoveredCritical) {
    if (!riskByArea.has(ac.area)) {
      riskByArea.set(ac.area, {
        area: ac.area,
        description: `Critical acceptance criterion ${ac.id} has no active (passing) test coverage.`,
        severity: "high",
      });
    }
  }
  let identifiedRisks = [...riskByArea.values()].sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0));
  if (identifiedRisks.length === 0) {
    identifiedRisks = [{
      area: req.affectedAreas[0] ?? "general",
      description: "No blocking risks were identified from the submitted evidence for the stated scope.",
      severity: "low",
    }];
  }

  /* ---- coverage assessment: one per criterion ---- */
  const coverageAssessment = covMap.map((c) => ({
    acceptanceCriterionId: c.acceptanceCriterionId,
    covered: Boolean(c.covered),
    notes: `${c.activeTests.length} ${plural(c.activeTests.length, "passing test", "passing tests")} of ${c.mappedTests.length} linked.`,
  }));

  /* ---- missing scenarios: uncovered criteria + business rules ---- */
  const missingScenarios: string[] = [];
  for (const c of covMap) {
    if (!c.covered) {
      const ac = acs.find((a) => a.id === c.acceptanceCriterionId);
      if (ac) missingScenarios.push(`Add a passing test for ${ac.id} (${ac.area}): ${ac.text}`);
    }
  }
  for (const br of context.businessRules) {
    missingScenarios.push(`Confirm test evidence traces to business rule ${br.id}: ${br.text}`);
  }
  const missingCapped = missingScenarios.slice(0, 12);

  /* ---- defect review: relevance from status ---- */
  const defectReview = defects.map((d) => ({
    defectId: d.defectId,
    stillRelevant: d.status === "open",
    notes: `${d.severity} severity, ${d.area}${d.security ? ", security-related" : ""}, status ${d.status}.`,
  }));

  /* ---- regression priorities: per affected area ---- */
  const areasWithOpenDefect = new Set(openDefects.map((d) => d.area));
  const areasWithUncoveredCritical = new Set(uncoveredCritical.map((a) => a.area));
  const riskLevels: Record<string, string> = (datasets.riskRules as any).riskLevelsByArea;
  const regressionPriorities = req.affectedAreas.map((area: string) => {
    let priority: PriorityLevel = "low";
    let rationale = `Inherent ${riskLevels[area] ?? "medium"} risk area; no open defects or coverage gaps recorded.`;
    if (areasWithOpenDefect.has(area)) {
      priority = "high";
      rationale = `This area has one or more open defects in the submitted evidence.`;
    } else if (areasWithUncoveredCritical.has(area)) {
      priority = "high";
      rationale = `Area has a critical acceptance criterion with no active test coverage.`;
    } else if ((riskLevels[area] ?? "medium") === "high") {
      priority = "medium";
      rationale = `High inherent risk area; regression recommended alongside the change.`;
    }
    return { area, priority, rationale };
  });

  /* ---- risk explanation: composed from the facts, no invented narrative ---- */
  const parts: string[] = [
    `This assessment is based on ${acs.length} ${plural(acs.length, "acceptance criterion", "acceptance criteria")}, ${tests.length} ${plural(tests.length, "test case")} ` +
      `(${coverageStats.passed} passing, ${coverageStats.failed} failed, ${coverageStats.blocked} blocked), and ${defects.length} known ${plural(defects.length, "defect")}.`,
  ];
  if (openCritical.length) {
    parts.push(`${openCritical.length} open critical ${plural(openCritical.length, "defect")} ${plural(openCritical.length, "remains", "remain")} unresolved.`);
  }
  if (openSecurity.length) {
    parts.push(`${openSecurity.length} open security-flagged ${plural(openSecurity.length, "defect")} at critical/high severity ${plural(openSecurity.length, "was", "were")} reported.`);
  }
  if (uncoveredCritical.length) {
    parts.push(`${uncoveredCritical.length} critical ${plural(uncoveredCritical.length, "acceptance criterion", "acceptance criteria")} ${plural(uncoveredCritical.length, "has", "have")} no active (passing) test coverage: ${uncoveredCritical.map((a) => a.id).join(", ")}.`);
  }
  if (coverageStats.coveragePercent < 80) {
    parts.push(`Active coverage is ${coverageStats.coveragePercent}% of acceptance criteria, below the 80% threshold.`);
  }
  parts.push(
    "The deterministic release gate evaluated these facts to produce the decision shown above. " +
      "This analysis was generated in rules-based mode from your submitted evidence; set GEMINI_API_KEY for a full LLM QA analysis.",
  );

  return {
    schemaVersion: 1,
    changeSummary: summarize(context.releaseScope || req.description || "Release assessment"),
    identifiedRisks,
    coverageAssessment,
    missingScenarios: missingCapped,
    defectReview,
    regressionPriorities,
    releaseRiskExplanation: parts.join(" "),
    dataProvenance: {
      requirementId: req.requirementId,
      acceptanceCriteriaCount: acs.length,
      existingTestCount: tests.length,
      knownDefectCount: defects.length,
      riskRulesScenario: (datasets.riskRules as any).scenario,
    },
  };
}
