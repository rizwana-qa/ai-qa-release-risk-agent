/**
 * Unit tests for the deterministic release gate.
 *
 * Runner: Node's built-in test runner (`node --test`) with native TypeScript
 * support. No external test framework or dependency.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateReleaseGate,
  validateFindings,
  changeRiskLevel,
  criticalAcceptanceCriteria,
  insufficientCoverage,
  securityFailure,
  EVALUATION_ORDER,
  GATE_RULES,
  type ReleaseFindings,
} from "../src/releaseGate.ts";

import {
  baseFindings,
  healthyFindings,
  setDefectStatus,
  setDefectSeverity,
  setTestStatus,
  setTestArea,
} from "./fixtures.ts";

/* -------------------------------------------------------------------------- */
/* Rule outcomes                                                             */
/* -------------------------------------------------------------------------- */

describe("evaluateReleaseGate — rule outcomes", () => {
  it("GATE-1: an open critical defect -> NO_GO", () => {
    const f = healthyFindings();
    setDefectStatus(f, "DEF-003", "open"); // DEF-003 severity is 'critical'

    const result = evaluateReleaseGate(f);
    assert.equal(result.decision, "NO_GO");
    assert.equal(result.firedRule, "GATE-1");
    assert.match(result.reasons.join(" "), /DEF-003/);
  });

  it("GATE-2: an open security-flagged high defect (SEC-1) -> NO_GO", () => {
    const f = healthyFindings();
    setDefectStatus(f, "DEF-004", "open"); // high + security + open

    const result = evaluateReleaseGate(f);
    assert.equal(result.decision, "NO_GO");
    assert.equal(result.firedRule, "GATE-2");
    assert.match(result.reasons.join(" "), /SEC-1/);
    assert.match(result.reasons.join(" "), /DEF-004/);
  });

  it("GATE-2: an uncovered security acceptance criterion (SEC-2) -> NO_GO", () => {
    const f = healthyFindings();
    setTestStatus(f, "TEST-SEC-001", "quarantined"); // AC-8 (security) loses active coverage

    const result = evaluateReleaseGate(f);
    assert.equal(result.decision, "NO_GO");
    assert.equal(result.firedRule, "GATE-2"); // GATE-2 precedes GATE-3
    assert.match(result.reasons.join(" "), /SEC-2/);
    assert.match(result.reasons.join(" "), /AC-8/);
  });

  it("GATE-2: the faithful Phase 2 dataset -> NO_GO (SEC-1 and SEC-2)", () => {
    const result = evaluateReleaseGate(baseFindings());
    assert.equal(result.decision, "NO_GO");
    assert.equal(result.firedRule, "GATE-2");
    assert.match(result.reasons.join(" "), /SEC-1/);
    assert.match(result.reasons.join(" "), /SEC-2/);
  });

  it("GATE-3: a critical (non-security) acceptance criterion with no coverage -> NO_GO", () => {
    const f = healthyFindings();
    setTestStatus(f, "TEST-XFER-001", "quarantined"); // AC-5 (money-transfer, critical) loses its only active test

    const result = evaluateReleaseGate(f);
    assert.equal(result.decision, "NO_GO");
    assert.equal(result.firedRule, "GATE-3");
    assert.match(result.reasons.join(" "), /AC-5/);
  });

  it("GATE-4: high-risk change + insufficient coverage (COV-2) -> CONDITIONAL", () => {
    const f = healthyFindings();
    setTestArea(f, "TEST-XFER-003", "validation"); // money-transfer high-risk area left with no active negative test

    const result = evaluateReleaseGate(f);
    assert.equal(result.decision, "CONDITIONAL");
    assert.equal(result.firedRule, "GATE-4");
    assert.match(result.reasons.join(" "), /COV-2/);
    assert.match(result.reasons.join(" "), /money-transfer/);
  });

  it("GATE-4: high-risk change + insufficient coverage (COV-3 ratio) -> CONDITIONAL", () => {
    const f = healthyFindings();
    // Drop coverage of two non-critical criteria: AC-1 and AC-3 -> 6/8 = 0.75 < 0.8
    setTestStatus(f, "TEST-BEN-001", "quarantined");
    setTestStatus(f, "TEST-BEN-002", "quarantined");
    setTestStatus(f, "TEST-VAL-001", "quarantined");
    setTestStatus(f, "TEST-VAL-002", "quarantined");

    const result = evaluateReleaseGate(f);
    assert.equal(result.decision, "CONDITIONAL");
    assert.equal(result.firedRule, "GATE-4");
    assert.match(result.reasons.join(" "), /COV-3/);
  });

  it("GATE-5: a normal, adequately covered change -> GO", () => {
    const result = evaluateReleaseGate(healthyFindings());
    assert.equal(result.decision, "GO");
    assert.equal(result.firedRule, "GATE-5");
  });
});

/* -------------------------------------------------------------------------- */
/* Precedence                                                                */
/* -------------------------------------------------------------------------- */

describe("evaluateReleaseGate — rule precedence", () => {
  it("documents a single, ordered precedence chain", () => {
    assert.deepEqual([...EVALUATION_ORDER], ["GATE-1", "GATE-2", "GATE-3", "GATE-4", "GATE-5"]);
    assert.deepEqual(GATE_RULES.map((r) => r.id), [...EVALUATION_ORDER]);
  });

  it("fires the earliest satisfied rule as blockers are removed one at a time", () => {
    // Start from the Phase 2 data and additionally open the critical defect:
    // GATE-1, GATE-2, GATE-3 and GATE-4 conditions all hold simultaneously.
    const f = baseFindings();
    setDefectStatus(f, "DEF-003", "open");
    assert.equal(evaluateReleaseGate(f).firedRule, "GATE-1");

    // Remove the GATE-1 condition -> GATE-2 (security failure) is next.
    setDefectStatus(f, "DEF-003", "closed");
    assert.equal(evaluateReleaseGate(f).firedRule, "GATE-2");

    // Remove the GATE-2 conditions, but leave a critical AC uncovered -> GATE-3.
    setDefectStatus(f, "DEF-004", "closed");        // clears SEC-1
    setTestStatus(f, "TEST-SEC-001", "active");     // clears SEC-2 (AC-8 covered)
    setTestStatus(f, "TEST-XFER-001", "quarantined"); // AC-5 critical, now uncovered
    assert.equal(evaluateReleaseGate(f).firedRule, "GATE-3");

    // Restore AC-5 coverage -> only "high risk + insufficient coverage" remains -> GATE-4.
    setTestStatus(f, "TEST-XFER-001", "active");
    // money-transfer (high) still has no active negative test in-area (COV-2).
    const g4 = evaluateReleaseGate(f);
    assert.equal(g4.decision, "CONDITIONAL");
    assert.equal(g4.firedRule, "GATE-4");

    // Fix the last gap -> GATE-5 GO.
    setTestArea(f, "TEST-XFER-003", "money-transfer");
    const g5 = evaluateReleaseGate(f);
    assert.equal(g5.decision, "GO");
    assert.equal(g5.firedRule, "GATE-5");
  });

  it("NO_GO outranks CONDITIONAL when both a NO_GO and a CONDITIONAL rule would apply", () => {
    const f = healthyFindings();
    setDefectStatus(f, "DEF-003", "open");            // GATE-1 NO_GO
    setTestArea(f, "TEST-XFER-003", "validation");    // GATE-4 CONDITIONAL condition also true

    const result = evaluateReleaseGate(f);
    assert.equal(result.decision, "NO_GO");
    assert.equal(result.firedRule, "GATE-1");
  });
});

/* -------------------------------------------------------------------------- */
/* Fail-safe: malformed / missing input                                      */
/* -------------------------------------------------------------------------- */

describe("evaluateReleaseGate — fail-safe on malformed input", () => {
  const malformed: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "not findings"],
    ["an array", []],
    ["an empty object", {}],
    ["wrong-typed affectedAreas", { ...baseFindings(), affectedAreas: "authentication" }],
    ["empty acceptanceCriteria", { ...baseFindings(), acceptanceCriteria: [] }],
    ["a defect with an invalid severity", (() => {
      const f = baseFindings() as unknown as { defects: Array<Record<string, unknown>> };
      f.defects[0].severity = "sev-9";
      return f;
    })()],
    ["a test with an invalid status", (() => {
      const f = baseFindings() as unknown as { tests: Array<Record<string, unknown>> };
      f.tests[0].status = "disabled";
      return f;
    })()],
    ["riskRules not an object", { ...baseFindings(), riskRules: "n/a" }],
    ["coverageRatioThreshold out of range", (() => {
      const f = baseFindings();
      f.riskRules.coverageRatioThreshold = 1.5;
      return f;
    })()],
  ];

  for (const [label, input] of malformed) {
    it(`${label} -> NO_GO / FAIL_SAFE`, () => {
      const result = evaluateReleaseGate(input);
      assert.equal(result.decision, "NO_GO");
      assert.equal(result.firedRule, "FAIL_SAFE");
      assert.ok(result.reasons.length >= 1);
    });
  }
});

describe("evaluateReleaseGate — fail-safe on missing required findings", () => {
  const requiredKeys: Array<keyof ReleaseFindings> = [
    "affectedAreas",
    "acceptanceCriteria",
    "defects",
    "tests",
    "riskRules",
  ];

  for (const key of requiredKeys) {
    it(`missing "${key}" -> NO_GO / FAIL_SAFE`, () => {
      const f = baseFindings() as Partial<ReleaseFindings>;
      delete f[key];

      const result = evaluateReleaseGate(f);
      assert.equal(result.decision, "NO_GO");
      assert.equal(result.firedRule, "FAIL_SAFE");
      assert.match(result.reasons.join(" "), new RegExp(key));
    });
  }

  it('missing "riskLevelsByArea" inside riskRules -> NO_GO / FAIL_SAFE', () => {
    const f = baseFindings() as unknown as { riskRules: Record<string, unknown> };
    delete f.riskRules.riskLevelsByArea;

    const result = evaluateReleaseGate(f);
    assert.equal(result.decision, "NO_GO");
    assert.equal(result.firedRule, "FAIL_SAFE");
    assert.match(result.reasons.join(" "), /riskLevelsByArea/);
  });

  it("an affected area with no inherent risk level -> NO_GO / FAIL_SAFE", () => {
    const f = baseFindings();
    f.affectedAreas.push("payments"); // no entry in riskLevelsByArea

    const result = evaluateReleaseGate(f);
    assert.equal(result.decision, "NO_GO");
    assert.equal(result.firedRule, "FAIL_SAFE");
    assert.match(result.reasons.join(" "), /payments/);
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism & purity                                                      */
/* -------------------------------------------------------------------------- */

describe("evaluateReleaseGate — determinism and purity", () => {
  it("returns an identical result for identical input across repeated calls", () => {
    const a = evaluateReleaseGate(baseFindings());
    const b = evaluateReleaseGate(baseFindings());
    const c = evaluateReleaseGate(baseFindings());
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
  });

  it("does not mutate the input findings", () => {
    const f = baseFindings();
    const snapshot = JSON.stringify(f);
    evaluateReleaseGate(f);
    assert.equal(JSON.stringify(f), snapshot);
  });
});

/* -------------------------------------------------------------------------- */
/* Helper predicates                                                         */
/* -------------------------------------------------------------------------- */

describe("helper predicate: changeRiskLevel", () => {
  it("is the highest inherent risk among affected areas", () => {
    assert.equal(changeRiskLevel(baseFindings()), "high");
  });

  it("is 'medium' when only medium-risk areas are affected", () => {
    const f = baseFindings();
    f.affectedAreas = ["beneficiary-management", "validation"];
    assert.equal(changeRiskLevel(f), "medium");
  });

  it("is 'low' when only low-risk areas are affected", () => {
    const f = baseFindings();
    f.riskRules.riskLevelsByArea["docs"] = "low";
    f.affectedAreas = ["docs"];
    assert.equal(changeRiskLevel(f), "low");
  });
});

describe("helper predicate: criticalAcceptanceCriteria", () => {
  it("selects criteria flagged critical or belonging to a critical area", () => {
    const ids = criticalAcceptanceCriteria(baseFindings()).map((ac) => ac.id).sort();
    assert.deepEqual(ids, ["AC-2", "AC-4", "AC-5", "AC-6", "AC-8"]);
  });
});

describe("helper predicate: insufficientCoverage", () => {
  it("is true for the Phase 2 dataset (AC-8 gap) and false for the healthy variant", () => {
    assert.equal(insufficientCoverage(baseFindings()).insufficient, true);
    assert.equal(insufficientCoverage(healthyFindings()).insufficient, false);
  });
});

describe("helper predicate: securityFailure", () => {
  it("reports both SEC-1 and SEC-2 for the Phase 2 dataset", () => {
    const s = securityFailure(baseFindings());
    assert.equal(s.failed, true);
    assert.equal(s.reasons.length, 2);
  });

  it("reports SEC-1 only when the security defect is open but AC-8 is covered", () => {
    const f = healthyFindings();
    setDefectStatus(f, "DEF-004", "open");
    const s = securityFailure(f);
    assert.equal(s.failed, true);
    assert.match(s.reasons.join(" "), /SEC-1/);
    assert.doesNotMatch(s.reasons.join(" "), /SEC-2/);
  });

  it("is false for the healthy variant", () => {
    assert.equal(securityFailure(healthyFindings()).failed, false);
  });

  it("ignores low-severity security defects (below the configured severities)", () => {
    const f = healthyFindings();
    // DEF-005 is open + security + low; must not, on its own, be a security failure.
    setDefectStatus(f, "DEF-005", "open");
    assert.equal(securityFailure(f).failed, false);
    // Raising it to 'high' makes it qualify.
    setDefectSeverity(f, "DEF-005", "high");
    assert.equal(securityFailure(f).failed, true);
  });
});

/* -------------------------------------------------------------------------- */
/* validateFindings                                                          */
/* -------------------------------------------------------------------------- */

describe("validateFindings", () => {
  it("accepts the Phase 2 dataset", () => {
    const v = validateFindings(baseFindings());
    assert.equal(v.ok, true);
  });

  it("collects multiple problems for deeply malformed input", () => {
    const v = validateFindings({ affectedAreas: [], acceptanceCriteria: [], defects: null, tests: null, riskRules: null });
    assert.equal(v.ok, false);
    if (!v.ok) assert.ok(v.problems.length >= 4);
  });
});
