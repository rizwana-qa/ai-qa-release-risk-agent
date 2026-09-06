/**
 * Unit tests for the deterministic adapter and the securityFailureSeverities projection.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  adaptAgentFindingsToReleaseFindings,
  projectSecurityFailureSeverities,
  type SyntheticDatasets,
} from "../src/findingsAdapter.ts";
import { validateFindings } from "../src/releaseGate.ts";
import { loadDataset } from "../src/dataLoader.ts";
import { cloneValidAgentFindings } from "./agentFixtures.ts";

function realDatasets(): SyntheticDatasets {
  return {
    requirement: loadDataset("requirement"),
    existingTests: loadDataset("existing-tests"),
    knownDefects: loadDataset("known-defects"),
    riskRules: loadDataset("risk-rules"),
  };
}

/* -------------------------------------------------------------------------- */

describe("projectSecurityFailureSeverities", () => {
  it("projects the Phase 2 rule to ['critical','high']", () => {
    assert.deepEqual(projectSecurityFailureSeverities(loadDataset("risk-rules")), ["critical", "high"]);
  });

  it("returns severities in canonical order regardless of wording order", () => {
    const rr = { securityFailureRule: { conditions: [{ id: "SEC-1", text: "high or critical severity, open, security" }] } };
    assert.deepEqual(projectSecurityFailureSeverities(rr), ["critical", "high"]);
  });

  it("supports a single-severity rule", () => {
    const rr = { securityFailureRule: { conditions: [{ id: "SEC-1", text: "severity 'high', open, security = true" }] } };
    assert.deepEqual(projectSecurityFailureSeverities(rr), ["high"]);
  });

  it("throws when SEC-1 names no severities", () => {
    const rr = { securityFailureRule: { conditions: [{ id: "SEC-1", text: "an open security defect exists" }] } };
    assert.throws(() => projectSecurityFailureSeverities(rr), /names no severities/);
  });

  it("throws when the securityFailureRule is absent", () => {
    assert.throws(() => projectSecurityFailureSeverities({ foo: 1 }), /securityFailureRule/);
  });
});

/* -------------------------------------------------------------------------- */

describe("adaptAgentFindingsToReleaseFindings — happy path", () => {
  it("builds a ReleaseFindings object from the authoritative datasets", () => {
    const res = adaptAgentFindingsToReleaseFindings(cloneValidAgentFindings(), realDatasets());
    assert.equal(res.ok, true);
    if (!res.ok) return;

    const rf = res.releaseFindings;
    assert.equal(rf.acceptanceCriteria.length, 8);
    assert.equal(rf.tests.length, 11);
    assert.equal(rf.defects.length, 5);
    assert.deepEqual(rf.affectedAreas.slice().sort(), [
      "authentication", "authorization", "beneficiary-management", "money-transfer", "security", "validation",
    ]);
    assert.deepEqual(rf.riskRules.securityFailureSeverities, ["critical", "high"]);
    assert.equal(rf.riskRules.coverageRatioThreshold, 0.8);
    assert.deepEqual(rf.riskRules.criticalAreas.slice().sort(), [
      "authentication", "authorization", "money-transfer", "security",
    ]);
  });

  it("produces findings that pass the unchanged Phase 3 validator", () => {
    const res = adaptAgentFindingsToReleaseFindings(cloneValidAgentFindings(), realDatasets());
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(validateFindings(res.releaseFindings).ok, true);
  });

  it("is deterministic — identical inputs give a deep-equal result", () => {
    const a = adaptAgentFindingsToReleaseFindings(cloneValidAgentFindings(), realDatasets());
    const b = adaptAgentFindingsToReleaseFindings(cloneValidAgentFindings(), realDatasets());
    assert.deepEqual(a, b);
  });

  it("takes facts from the dataset, not from the agent's commentary", () => {
    // Agent claims (in notes) that defects are all resolved; the facts must still come from data.
    const f = cloneValidAgentFindings();
    for (const d of f.defectReview) { d.stillRelevant = false; d.notes = "resolved"; }
    const res = adaptAgentFindingsToReleaseFindings(f, realDatasets());
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.releaseFindings.defects.filter((d) => d.status === "open").length, 3);
  });
});

/* -------------------------------------------------------------------------- */

describe("adaptAgentFindingsToReleaseFindings — grounding checks fail safe", () => {
  it("rejects a provenance requirementId mismatch", () => {
    const f = cloneValidAgentFindings();
    f.dataProvenance.requirementId = "REQ-OTHER-999";
    const res = adaptAgentFindingsToReleaseFindings(f, realDatasets());
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.problems.join(" "), /grounding/);
  });

  it("rejects a provenance count mismatch", () => {
    const f = cloneValidAgentFindings();
    f.dataProvenance.existingTestCount = 999;
    const res = adaptAgentFindingsToReleaseFindings(f, realDatasets());
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.problems.join(" "), /existingTestCount/);
  });

  it("rejects a coverageAssessment reference to an unknown acceptance criterion", () => {
    const f = cloneValidAgentFindings();
    f.coverageAssessment[0].acceptanceCriterionId = "AC-99";
    const res = adaptAgentFindingsToReleaseFindings(f, realDatasets());
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.problems.join(" "), /AC-99/);
  });

  it("rejects a defectReview reference to an unknown defect", () => {
    const f = cloneValidAgentFindings();
    f.defectReview[0].defectId = "DEF-99";
    const res = adaptAgentFindingsToReleaseFindings(f, realDatasets());
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.problems.join(" "), /DEF-99/);
  });

  it("rejects malformed datasets", () => {
    const res = adaptAgentFindingsToReleaseFindings(cloneValidAgentFindings(), {
      requirement: { nope: true },
      existingTests: loadDataset("existing-tests"),
      knownDefects: loadDataset("known-defects"),
      riskRules: loadDataset("risk-rules"),
    });
    assert.equal(res.ok, false);
  });
});
