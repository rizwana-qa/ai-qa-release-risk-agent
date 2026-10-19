/**
 * The offline (rules-based) fallback: its narrative reads the coverage threshold from the rules
 * dataset instead of hard-coding one, and the pipeline fails safe, then falls back, when the live
 * analysis step cannot produce usable findings. Offline only: no Gemini call is made.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";

import { normalizeAssessmentInput } from "../api/inputNormalizer.ts";
import { analyzeEvidence, coverageThreshold } from "../api/evidenceAnalyzer.ts";
import { runPipeline } from "../src/pipelineCli.ts";
import { loadDataset } from "../src/dataLoader.ts";
import { cloneValidAgentFindings } from "./agentFixtures.ts";
import { thinPayload, thinTest } from "./customFixtures.ts";

const RUN_DIR = mkdtempSync(join(tmpdir(), "fallback-analysis-"));
let n = 0;
const stateFile = () => join(RUN_DIR, `state-${n++}.json`);
after(() => rmSync(RUN_DIR, { recursive: true, force: true }));

function normalised(payload: unknown, threshold?: unknown) {
  const r = normalizeAssessmentInput(payload as any);
  if (!r.ok) throw new Error("fixture did not normalize");
  const datasets: any = structuredClone(r.datasets);
  if (threshold !== undefined) {
    const cov3 = datasets.riskRules.insufficientCoverageRule.conditions.find((c: any) => c.id === "COV-3");
    if (threshold === null) delete cov3.illustrativeThreshold;
    else cov3.illustrativeThreshold = threshold;
  }
  return { ...r, datasets };
}
const narrative = (r: ReturnType<typeof normalised>) => analyzeEvidence(r.datasets, r.context, r.coverageStats).releaseRiskExplanation;

// One of three criteria covered: 33% coverage.
const partial = () => thinPayload({ testCases: [thinTest("Passed", ["AC1"])] });

describe("fallback narrative: the threshold comes from the rules configuration", () => {
  it("reads the configured value (0.8 in the shipped rules) and words it as a percentage", () => {
    const r = normalised(partial());
    assert.equal(coverageThreshold(r.datasets), 0.8);
    assert.match(narrative(r), /Active coverage is 33% of acceptance criteria, below the 80% threshold\./);
  });

  it("follows a different configured value instead of a hard-coded 80%", () => {
    const text = narrative(normalised(partial(), 0.5));
    assert.match(text, /below the 50% threshold\./);
    assert.doesNotMatch(text, /80%/);
    assert.match(narrative(normalised(partial(), 0.375)), /below the 37\.5% threshold\./);
  });

  it("makes no threshold statement when coverage meets the configured value", () => {
    assert.doesNotMatch(narrative(normalised(partial(), 0.3)), /threshold/);
  });

  it("states no threshold, and invents none, when the configuration has none or an unusable one", () => {
    for (const bad of [null, 0, 1.5, "0.8", -1]) {
      const r = normalised(partial(), bad);
      assert.equal(coverageThreshold(r.datasets), null, String(bad));
      assert.doesNotMatch(narrative(r), /below the .* threshold/, String(bad));
    }
  });

  it("matches the value the adapter and gate use: the shipped fixture's COV-3 threshold", () => {
    const fixture = loadDataset("risk-rules") as any;
    const cov3 = fixture.insufficientCoverageRule.conditions.find((c: any) => c.id === "COV-3");
    assert.equal(coverageThreshold({ riskRules: fixture } as any), cov3.illustrativeThreshold);
  });
});

describe("failed live analysis fails safe, and the fallback run is selected and decided by the gate", () => {
  const fetchReal = async () => ({
    requirement: loadDataset("requirement"),
    existingTests: loadDataset("existing-tests"),
    knownDefects: loadDataset("known-defects"),
    riskRules: loadDataset("risk-rules"),
  });

  it("a provider failure leaves no usable findings: the report fails safe to NO_GO and the batch reads as failed", async () => {
    const report = await runPipeline({ stateFile: stateFile(), fetchDatasets: fetchReal, analyze: async () => { throw new Error("503 unavailable"); } });
    assert.equal(report.releaseDecision, "NO_GO");
    assert.equal(report.firedRule, "FAIL_SAFE");
    assert.equal(report.pipelineTrace.find((t) => t.step === "ai-reasoning")!.ok, false);
    assert.equal(report.aiQaExplanation, null);
  });

  it("schema-invalid or non-object output also fails safe", async () => {
    for (const bad of [{ schemaVersion: 1 }, "text", null, []]) {
      const report = await runPipeline({ stateFile: stateFile(), fetchDatasets: fetchReal, analyze: async () => bad });
      assert.equal(report.releaseDecision, "NO_GO", JSON.stringify(bad));
      assert.equal(report.firedRule, "FAIL_SAFE");
      assert.equal(report.agentOutputValid, false);
    }
  });

  it("re-running against the rules-based findings after a failed live attempt gives the gate's normal decision", async () => {
    const failed = await runPipeline({ stateFile: stateFile(), fetchDatasets: fetchReal, analyze: async () => { throw new Error("timeout"); } });
    assert.equal(failed.firedRule, "FAIL_SAFE");
    const r = normalised(partial());
    const fetchCustom = async () => r.datasets as any;
    const fallback = await runPipeline({
      stateFile: stateFile(),
      scenario: (r.datasets.requirement as any).requirement.requirementId,
      fetchDatasets: fetchCustom,
      analyze: async () => analyzeEvidence(r.datasets, r.context, r.coverageStats),
    });
    assert.equal(fallback.agentOutputValid, true);
    assert.equal(fallback.releaseDecision, "GO");
    assert.equal(fallback.firedRule, "GATE-5");
    assert.equal(fallback.pipelineTrace.some((t) => t.step === "ai-evidence-crosscheck"), false, "findings derived from the evidence cannot contradict it");
  });

  it("valid recorded findings still reach the gate unchanged", async () => {
    const report = await runPipeline({ stateFile: stateFile(), fetchDatasets: fetchReal, analyze: async () => cloneValidAgentFindings() });
    assert.equal(report.agentOutputValid, true);
    assert.equal(report.releaseDecision, "NO_GO");
    assert.equal(report.firedRule, "GATE-2");
  });
});
