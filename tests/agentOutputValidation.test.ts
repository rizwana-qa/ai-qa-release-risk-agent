/**
 * Unit tests for validateAgentFindings() — the structural gate on raw LLM output.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateAgentFindings } from "../src/agentOutputValidation.ts";
import { FORBIDDEN_OUTPUT_KEYS, type AgentFindings } from "../src/agentContract.ts";
import { cloneValidAgentFindings } from "./agentFixtures.ts";

describe("validateAgentFindings — accepts well-formed output", () => {
  it("accepts the valid fixture", () => {
    const v = validateAgentFindings(cloneValidAgentFindings());
    assert.equal(v.ok, true);
  });
});

describe("validateAgentFindings — rejects non-objects (fail safe)", () => {
  for (const [label, value] of [
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", '{"changeSummary":"x"}'],
    ["an array", []],
  ] as Array<[string, unknown]>) {
    it(`${label} -> not ok`, () => {
      const v = validateAgentFindings(value);
      assert.equal(v.ok, false);
      if (!v.ok) assert.ok(v.problems.length >= 1);
    });
  }
});

describe("validateAgentFindings — the LLM must not provide a decision", () => {
  for (const key of FORBIDDEN_OUTPUT_KEYS) {
    it(`rejects output containing a top-level "${key}" key`, () => {
      const bad = { ...cloneValidAgentFindings(), [key]: "GO" };
      const v = validateAgentFindings(bad);
      assert.equal(v.ok, false);
      if (!v.ok) assert.match(v.problems.join(" "), /forbidden key/);
    });
  }
});

describe("validateAgentFindings — rejects malformed fields", () => {
  const mutate: Array<[string, (f: any) => void]> = [
    ["schemaVersion not 1", (f) => { f.schemaVersion = 2; }],
    ["empty changeSummary", (f) => { f.changeSummary = "   "; }],
    ["missing releaseRiskExplanation", (f) => { delete f.releaseRiskExplanation; }],
    ["identifiedRisks empty", (f) => { f.identifiedRisks = []; }],
    ["identifiedRisks bad severity", (f) => { f.identifiedRisks[0].severity = "urgent"; }],
    ["coverageAssessment missing covered", (f) => { delete f.coverageAssessment[0].covered; }],
    ["coverageAssessment covered not boolean", (f) => { f.coverageAssessment[0].covered = "yes"; }],
    ["missingScenarios not string array", (f) => { f.missingScenarios = [1, 2]; }],
    ["defectReview entry missing defectId", (f) => { delete f.defectReview[0].defectId; }],
    ["defectReview stillRelevant not boolean", (f) => { f.defectReview[0].stillRelevant = "maybe"; }],
    ["regressionPriorities bad priority", (f) => { f.regressionPriorities[0].priority = "urgent"; }],
    ["dataProvenance not an object", (f) => { f.dataProvenance = "REQ-BEN-001"; }],
    ["dataProvenance count not an integer", (f) => { f.dataProvenance.existingTestCount = 11.5; }],
    ["dataProvenance negative count", (f) => { f.dataProvenance.knownDefectCount = -1; }],
  ];

  for (const [label, apply] of mutate) {
    it(`${label} -> not ok`, () => {
      const f = cloneValidAgentFindings() as any;
      apply(f);
      const v = validateAgentFindings(f);
      assert.equal(v.ok, false);
    });
  }
});

describe("validateAgentFindings — rejects incomplete output", () => {
  const requiredKeys: Array<keyof AgentFindings> = [
    "schemaVersion",
    "changeSummary",
    "identifiedRisks",
    "coverageAssessment",
    "missingScenarios",
    "defectReview",
    "regressionPriorities",
    "releaseRiskExplanation",
    "dataProvenance",
  ];

  for (const key of requiredKeys) {
    it(`missing "${key}" -> not ok`, () => {
      const f = cloneValidAgentFindings() as Partial<AgentFindings>;
      delete f[key];
      const v = validateAgentFindings(f);
      assert.equal(v.ok, false);
    });
  }
});
