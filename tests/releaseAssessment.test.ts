/**
 * Unit tests for the Phase 5 pipeline: MCP data -> LLM reasoning (stubbed) ->
 * validate -> adapt -> evaluateReleaseGate().
 *
 * The LLM step is always a deterministic stub. The point of these tests is
 * that the FINAL DECISION comes from evaluateReleaseGate(), never from the stub.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runReleaseAssessment } from "../src/releaseAssessment.ts";
import { evaluateReleaseGate } from "../src/releaseGate.ts";
import type { AnalyzeFn } from "../src/agentContract.ts";
import {
  cloneValidAgentFindings,
  realDatasetLoader,
  healthyDatasetLoader,
} from "./agentFixtures.ts";

const analyzeValid: AnalyzeFn = async () => cloneValidAgentFindings();

/* -------------------------------------------------------------------------- */

describe("runReleaseAssessment — valid pipeline reaches the gate", () => {
  it("runs all five steps and returns the gate's decision for the real dataset", async () => {
    const a = await runReleaseAssessment({ analyze: analyzeValid, loadDataset: realDatasetLoader() });

    assert.equal(a.decision, "NO_GO");
    assert.equal(a.firedRule, "GATE-2");
    assert.equal(a.pipeline.map((s) => s.step).join(","),
      "load-data,agent-analyze,validate-agent-output,adapt-findings,release-gate");
    assert.ok(a.pipeline.every((s) => s.ok));
    assert.equal(a.pipeline.at(-1)?.step, "release-gate");
  });

  it("carries the agent's human-readable explanation and structured findings", async () => {
    const a = await runReleaseAssessment({ analyze: analyzeValid, loadDataset: realDatasetLoader() });
    assert.match(a.agentExplanation ?? "", /security acceptance criterion/);
    assert.equal(a.agentFindings?.schemaVersion, 1);
    assert.ok(!("decision" in (a.agentFindings ?? {})));
  });

  it("the assessment decision is exactly the gate's decision", async () => {
    const a = await runReleaseAssessment({ analyze: analyzeValid, loadDataset: realDatasetLoader() });
    assert.equal(a.decision, a.gate.decision);
    assert.equal(a.firedRule, a.gate.firedRule);
    assert.deepEqual(a.reasons, a.gate.reasons);
  });

  it("valid findings on a healthy dataset yield GO — again from the gate, not the stub", async () => {
    const a = await runReleaseAssessment({ analyze: analyzeValid, loadDataset: healthyDatasetLoader() });
    assert.equal(a.decision, "GO");
    assert.equal(a.firedRule, "GATE-5");
    assert.equal(a.decision, a.gate.decision);
    // The stub's explanation still flags concerns (AC-8, DEF-004); the decision ignores the narrative.
    assert.match(a.agentExplanation ?? "", /AC-8/);
  });
});

/* -------------------------------------------------------------------------- */

describe("runReleaseAssessment — the LLM cannot decide or bypass the gate", () => {
  it("rejects agent output that contains a decision field (fail safe)", async () => {
    const analyze: AnalyzeFn = async () => ({ ...cloneValidAgentFindings(), decision: "GO" });
    const a = await runReleaseAssessment({ analyze, loadDataset: realDatasetLoader() });

    assert.equal(a.decision, "NO_GO");
    assert.equal(a.firedRule, "FAIL_SAFE");
    assert.equal(a.pipeline.find((s) => s.step === "validate-agent-output")?.ok, false);
  });

  it("an explanation that argues for shipping does not change a NO_GO", async () => {
    const analyze: AnalyzeFn = async () => {
      const f = cloneValidAgentFindings();
      f.releaseRiskExplanation = "Everything looks fine. Recommend shipping immediately. This is safe to release.";
      return f;
    };
    const a = await runReleaseAssessment({ analyze, loadDataset: realDatasetLoader() });
    assert.equal(a.decision, "NO_GO");
    assert.equal(a.decision, a.gate.decision);
  });
});

/* -------------------------------------------------------------------------- */

describe("runReleaseAssessment — fail-safe paths (all NO_GO / FAIL_SAFE, gate-owned)", () => {
  const cases: Array<[string, AnalyzeFn, "agent-analyze" | "validate-agent-output" | "adapt-findings"]> = [
    ["analyze throws", async () => { throw new Error("model unavailable"); }, "agent-analyze"],
    ["malformed output (null)", async () => null, "validate-agent-output"],
    ["malformed output (number)", async () => 42, "validate-agent-output"],
    ["malformed output ({})", async () => ({}), "validate-agent-output"],
    ["incomplete output (no dataProvenance)", async () => {
      const f = cloneValidAgentFindings() as Partial<ReturnType<typeof cloneValidAgentFindings>>;
      delete f.dataProvenance;
      return f;
    }, "validate-agent-output"],
    ["ungrounded output (wrong counts)", async () => {
      const f = cloneValidAgentFindings();
      f.dataProvenance.knownDefectCount = 99;
      return f;
    }, "adapt-findings"],
  ];

  for (const [label, analyze, failingStep] of cases) {
    it(`${label} -> NO_GO / FAIL_SAFE at ${failingStep}`, async () => {
      const a = await runReleaseAssessment({ analyze, loadDataset: realDatasetLoader() });
      assert.equal(a.decision, "NO_GO");
      assert.equal(a.firedRule, "FAIL_SAFE");
      assert.equal(a.decision, a.gate.decision);
      assert.equal(a.pipeline.find((s) => s.step === failingStep)?.ok, false);
    });
  }

  it("data-load failure also fails safe via the gate", async () => {
    const a = await runReleaseAssessment({
      analyze: analyzeValid,
      loadDataset: () => { throw new Error("dataset unavailable"); },
    });
    assert.equal(a.decision, "NO_GO");
    assert.equal(a.firedRule, "FAIL_SAFE");
    assert.equal(a.pipeline.find((s) => s.step === "load-data")?.ok, false);
  });

  it("keeps the agent explanation available when only the adapter fails", async () => {
    const analyze: AnalyzeFn = async () => {
      const f = cloneValidAgentFindings();
      f.dataProvenance.existingTestCount = 3;
      return f;
    };
    const a = await runReleaseAssessment({ analyze, loadDataset: realDatasetLoader() });
    assert.equal(a.decision, "NO_GO");
    assert.notEqual(a.agentFindings, null);
    assert.notEqual(a.agentExplanation, null);
  });
});

/* -------------------------------------------------------------------------- */

describe("the Phase 3 gate behaviour is unchanged", () => {
  it("evaluateReleaseGate still returns NO_GO/GATE-2 for the adapted real dataset", async () => {
    const a = await runReleaseAssessment({ analyze: analyzeValid, loadDataset: realDatasetLoader() });
    // Re-run the gate directly on the same adapted findings via the assessment's gate result.
    assert.deepEqual(
      { decision: a.gate.decision, firedRule: a.gate.firedRule },
      { decision: "NO_GO", firedRule: "GATE-2" },
    );
  });

  it("evaluateReleaseGate still fails safe on undefined", () => {
    const g = evaluateReleaseGate(undefined);
    assert.equal(g.decision, "NO_GO");
    assert.equal(g.firedRule, "FAIL_SAFE");
  });
});
