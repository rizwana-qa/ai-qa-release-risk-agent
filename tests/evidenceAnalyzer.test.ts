/**
 * Phase 2 — the rules-based (offline) analyzer restates submitted evidence into a
 * valid, grounded AgentFindings and makes no release decision.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeAssessmentInput } from "../api/inputNormalizer.ts";
import { analyzeEvidence } from "../api/evidenceAnalyzer.ts";
import { validateAgentFindings } from "../src/agentOutputValidation.ts";
import { adaptAgentFindingsToReleaseFindings } from "../src/findingsAdapter.ts";
import { FORBIDDEN_OUTPUT_KEYS } from "../src/agentContract.ts";
import { coachingPayload, healthyPayload } from "./customFixtures.ts";

function norm(p: unknown) {
  const r = normalizeAssessmentInput(p as any);
  if (!r.ok) throw new Error("fixture did not normalize: " + JSON.stringify(r));
  return r;
}

describe("analyzeEvidence", () => {
  it("produces AgentFindings that pass the unchanged validateAgentFindings()", () => {
    const r = norm(coachingPayload());
    const f = analyzeEvidence(r.datasets, r.context, r.coverageStats);
    const v = validateAgentFindings(f);
    assert.equal(v.ok, true, v.ok ? "" : JSON.stringify(v.problems));
  });

  it("carries no decision / verdict / recommendation key", () => {
    const r = norm(coachingPayload());
    const f = analyzeEvidence(r.datasets, r.context, r.coverageStats) as unknown as Record<string, unknown>;
    for (const k of FORBIDDEN_OUTPUT_KEYS) assert.ok(!(k in f), `must not contain "${k}"`);
  });

  it("echoes exact provenance and only real ids, so the adapter grounding passes", () => {
    const r = norm(coachingPayload());
    const f = analyzeEvidence(r.datasets, r.context, r.coverageStats);
    assert.equal(f.dataProvenance.requirementId, (r.datasets.requirement as any).requirement.requirementId);
    assert.equal(f.dataProvenance.acceptanceCriteriaCount, 6);
    assert.equal(f.dataProvenance.existingTestCount, 6);
    assert.equal(f.dataProvenance.knownDefectCount, 3);

    const adapted = adaptAgentFindingsToReleaseFindings(f, r.datasets);
    assert.equal(adapted.ok, true, adapted.ok ? "" : JSON.stringify(adapted.problems));
  });

  it("is deterministic — same normalized datasets give a deep-equal analysis", () => {
    const a = norm(coachingPayload());
    const b = norm(coachingPayload());
    assert.deepEqual(
      analyzeEvidence(a.datasets, a.context, a.coverageStats),
      analyzeEvidence(b.datasets, b.context, b.coverageStats),
    );
  });

  it("restates uncovered criteria and business rules as missing scenarios (nothing invented)", () => {
    const r = norm(coachingPayload());
    const f = analyzeEvidence(r.datasets, r.context, r.coverageStats);
    assert.ok(f.missingScenarios.some((s) => s.includes("AC6")), "uncovered AC6 -> missing scenario");
    assert.ok(f.missingScenarios.some((s) => s.includes("BR1")), "business rule -> traceability scenario");
    // every missing scenario mentions something from the submitted evidence
    for (const s of f.missingScenarios) assert.ok(/AC\d|BR\d/.test(s));
  });

  it("healthy evidence yields a low-severity 'no blocking risks' note (still non-empty for validation)", () => {
    const r = norm(healthyPayload());
    const f = analyzeEvidence(r.datasets, r.context, r.coverageStats);
    assert.ok(f.identifiedRisks.length >= 1);
    assert.equal(validateAgentFindings(f).ok, true);
  });
});
