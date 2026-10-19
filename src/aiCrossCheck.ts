/**
 * Deterministic cross-check of the AI's findings against the authoritative evidence.
 *
 * It compares only statements that can be checked reliably against the adapted release
 * facts (`ReleaseFindings`, built from the datasets, never from the AI):
 *
 *   confirmed  - the AI states something the evidence contradicts outright
 *                (for example "covered" for a criterion that has no passing mapped test).
 *   heuristic  - the AI's statement is suspicious or incomplete but is a judgement, so it
 *                is a warning, not a proven contradiction.
 *   notVerified - what this check does NOT look at.
 *
 * It never rewrites AI output, never changes a decision (`evaluateReleaseGate()` does not
 * call it and ignores it), and does not claim to find every contradiction: free-text
 * narrative is not checked.
 */

import { criticalAcceptanceCriteria, type ReleaseFindings } from "./releaseGate.ts";
import type { AgentFindings } from "./agentContract.ts";

export interface CrossCheckFinding {
  kind: "confirmed" | "heuristic";
  code: string;
  message: string;
}

export interface CrossCheckResult {
  confirmed: CrossCheckFinding[];
  heuristic: CrossCheckFinding[];
  notVerified: string[];
}

/** Stable name of the pipeline-trace step that carries the result. */
export const CROSS_CHECK_STEP = "ai-evidence-crosscheck";

const NOT_VERIFIED = [
  "The change summary, risk explanation, missing scenarios and free-text notes are not checked against the evidence.",
  "A statement that raises no warning is not thereby confirmed.",
];

const norm = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function crossCheckAgentFindings(agent: AgentFindings, facts: ReleaseFindings): CrossCheckResult {
  const confirmed: CrossCheckFinding[] = [];
  const heuristic: CrossCheckFinding[] = [];
  const add = (kind: CrossCheckFinding["kind"], code: string, message: string) =>
    (kind === "confirmed" ? confirmed : heuristic).push({ kind, code, message });

  // Authoritative per-criterion coverage: tests that are active (passing) and map to the criterion.
  const mapped = (id: string) => facts.tests.filter((t) => t.covers.includes(id));
  const passing = (id: string) => mapped(id).filter((t) => t.status === "active");
  const areas = new Set([...facts.affectedAreas, ...facts.acceptanceCriteria.map((a) => a.area), ...facts.defects.map((d) => d.area)].map(norm));

  /* ---- coverage claims versus the evidence ---- */
  const claims = new Map<string, boolean[]>();
  for (const c of agent.coverageAssessment) {
    claims.set(c.acceptanceCriterionId, [...(claims.get(c.acceptanceCriterionId) ?? []), c.covered]);
  }
  for (const ac of facts.acceptanceCriteria) {
    const said = claims.get(ac.id);
    if (!said) {
      add("heuristic", "coverage-not-assessed", `The AI did not assess ${ac.id}; the evidence has ${passing(ac.id).length} passing and ${mapped(ac.id).length} mapped test(s) for it.`);
      continue;
    }
    if (new Set(said).size > 1) {
      add("confirmed", "coverage-self-contradiction", `The AI gave conflicting covered values for ${ac.id}.`);
    }
    const actual = passing(ac.id).length > 0;
    for (const covered of new Set(said)) {
      if (covered && !actual) {
        add("confirmed", "coverage-claimed-without-passing-test", `The AI says ${ac.id} is covered, but no passing test is mapped to it (${mapped(ac.id).length} mapped test(s), 0 passing).`);
      } else if (!covered && actual) {
        add("confirmed", "coverage-denied-despite-passing-test", `The AI says ${ac.id} is not covered, but ${passing(ac.id).length} passing test(s) are mapped to it.`);
      }
    }
  }

  /* ---- defect relevance (a judgement, so heuristic) ---- */
  const defectById = new Map(facts.defects.map((d) => [d.defectId, d]));
  for (const r of agent.defectReview) {
    const d = defectById.get(r.defectId);
    if (!d) continue; // unknown ids are already rejected by the adapter's grounding checks
    if (d.status === "open" && !r.stillRelevant) {
      add("heuristic", "open-defect-marked-not-relevant", `The AI marks ${d.defectId} as no longer relevant, but the evidence shows it is open (${d.severity}${d.security ? ", security-flagged" : ""}).`);
    } else if (d.status === "closed" && r.stillRelevant) {
      add("heuristic", "closed-defect-marked-relevant", `The AI marks ${d.defectId} as still relevant, but the evidence shows it is closed.`);
    }
  }

  /* ---- regression priorities versus evidence-derived signals (judgement, so heuristic) ---- */
  const uncoveredCriticalAreas = new Set(criticalAcceptanceCriteria(facts).filter((ac) => passing(ac.id).length === 0).map((ac) => norm(ac.area)));
  const openDefectAreas = new Set(facts.defects.filter((d) => d.status === "open").map((d) => norm(d.area)));
  for (const p of agent.regressionPriorities) {
    const key = norm(p.area);
    if (!areas.has(key)) {
      add("heuristic", "regression-area-unknown", `The AI lists regression area "${p.area}", which does not appear in the evidence.`);
    } else if (p.priority === "low" && (openDefectAreas.has(key) || uncoveredCriticalAreas.has(key))) {
      add("heuristic", "regression-priority-low-despite-evidence", `The AI gives "${p.area}" low regression priority, but the evidence shows ${openDefectAreas.has(key) ? "an open defect" : "an uncovered critical criterion"} there.`);
    }
  }
  for (const r of agent.identifiedRisks) {
    if (!areas.has(norm(r.area))) {
      add("heuristic", "risk-area-unknown", `The AI reports a risk in "${r.area}", which does not appear in the evidence.`);
    }
  }

  return { confirmed, heuristic, notVerified: NOT_VERIFIED };
}

/**
 * The text stored in the pipeline trace entry `ai-evidence-crosscheck`, one item per line, or
 * null when there is nothing to report. First line is a summary; items carry a bracketed label.
 */
export function formatCrossCheckDetail(r: CrossCheckResult): string | null {
  if (r.confirmed.length === 0 && r.heuristic.length === 0) return null;
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
  return [
    `AI vs evidence: ${n(r.confirmed.length, "confirmed contradiction")}, ${n(r.heuristic.length, "heuristic warning")}.`,
    ...r.confirmed.map((f) => `[confirmed] ${f.message}`),
    ...r.heuristic.map((f) => `[heuristic] ${f.message}`),
    ...r.notVerified.map((t) => `[not verified] ${t}`),
  ].join("\n");
}
