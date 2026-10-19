/**
 * The AI-vs-evidence cross-check (src/aiCrossCheck.ts) and its place in the pipeline.
 *
 * Only offline, recorded findings are used. No Gemini call is made. The key property under test is
 * that the check is advisory: it labels what it finds, never rewrites the AI output, and the
 * deterministic gate decision is the same with or without a contradiction.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";

import { crossCheckAgentFindings, formatCrossCheckDetail, CROSS_CHECK_STEP } from "../src/aiCrossCheck.ts";
import { runPipeline } from "../src/pipelineCli.ts";
import { evaluateReleaseGate } from "../src/releaseGate.ts";
import type { AgentFindings, AnalyzeFn } from "../src/agentContract.ts";
import type { DatasetName } from "../src/dataLoader.ts";

import { baseFindings } from "./fixtures.ts";
import { cloneValidAgentFindings, realDatasetLoader, healthyDatasetLoader } from "./agentFixtures.ts";

const RUN_DIR = mkdtempSync(join(tmpdir(), "ai-crosscheck-"));
let counter = 0;
const stateFile = () => join(RUN_DIR, `state-${counter++}.json`);
after(() => rmSync(RUN_DIR, { recursive: true, force: true }));

const fetchFrom = (loader: (n: DatasetName) => unknown) => async () => ({
  requirement: loader("requirement"),
  existingTests: loader("existing-tests"),
  knownDefects: loader("known-defects"),
  riskRules: loader("risk-rules"),
});
const run = (loader: (n: DatasetName) => unknown, analyze: AnalyzeFn) =>
  runPipeline({ stateFile: stateFile(), fetchDatasets: fetchFrom(loader), analyze });
const codes = (r: { confirmed: { code: string }[]; heuristic: { code: string }[] }) => ({
  confirmed: r.confirmed.map((f) => f.code),
  heuristic: r.heuristic.map((f) => f.code),
});

describe("crossCheckAgentFindings — what it can and cannot confirm", () => {
  it("finds nothing in the recorded findings that match the evidence", () => {
    const r = crossCheckAgentFindings(cloneValidAgentFindings(), baseFindings());
    assert.deepEqual(codes(r), { confirmed: [], heuristic: [] });
    assert.equal(formatCrossCheckDetail(r), null);
  });

  it("CONFIRMED: the AI says a criterion is covered but only a quarantined test maps to it", () => {
    const a = cloneValidAgentFindings();
    a.coverageAssessment.find((c) => c.acceptanceCriterionId === "AC-8")!.covered = true; // evidence: only quarantined TEST-SEC-001
    const r = crossCheckAgentFindings(a, baseFindings());
    assert.deepEqual(codes(r).confirmed, ["coverage-claimed-without-passing-test"]);
    assert.match(r.confirmed[0]!.message, /AC-8.*no passing test is mapped/);
  });

  it("CONFIRMED: the AI says a criterion is not covered although a passing test maps to it", () => {
    const a = cloneValidAgentFindings();
    a.coverageAssessment.find((c) => c.acceptanceCriterionId === "AC-1")!.covered = false;
    assert.deepEqual(codes(crossCheckAgentFindings(a, baseFindings())).confirmed, ["coverage-denied-despite-passing-test"]);
  });

  it("CONFIRMED: conflicting covered values for the same criterion", () => {
    const a = cloneValidAgentFindings();
    a.coverageAssessment.push({ acceptanceCriterionId: "AC-1", covered: false, notes: "second opinion" });
    const c = codes(crossCheckAgentFindings(a, baseFindings())).confirmed;
    assert.ok(c.includes("coverage-self-contradiction"));
  });

  it("HEURISTIC, not confirmed: a criterion the AI did not assess", () => {
    const a = cloneValidAgentFindings();
    a.coverageAssessment = a.coverageAssessment.filter((c) => c.acceptanceCriterionId !== "AC-3");
    assert.deepEqual(codes(crossCheckAgentFindings(a, baseFindings())), { confirmed: [], heuristic: ["coverage-not-assessed"] });
  });

  it("HEURISTIC: an open defect marked not relevant, and a closed defect marked relevant", () => {
    const a = cloneValidAgentFindings();
    a.defectReview.find((d) => d.defectId === "DEF-004")!.stillRelevant = false; // open, security-flagged
    a.defectReview.find((d) => d.defectId === "DEF-002")!.stillRelevant = true; // closed
    const r = crossCheckAgentFindings(a, baseFindings());
    assert.deepEqual(codes(r).heuristic.sort(), ["closed-defect-marked-relevant", "open-defect-marked-not-relevant"]);
    assert.deepEqual(r.confirmed, []);
  });

  it("HEURISTIC: low regression priority where the evidence shows an open defect, and areas that are not in the evidence", () => {
    const a = cloneValidAgentFindings();
    a.regressionPriorities.find((p) => p.area === "authentication")!.priority = "low"; // open DEF-004 there
    a.regressionPriorities.push({ area: "invented-area", priority: "high", rationale: "x" });
    a.identifiedRisks.push({ area: "another-invented-area", description: "x", severity: "low" });
    const r = crossCheckAgentFindings(a, baseFindings());
    assert.deepEqual(codes(r).heuristic.sort(), ["regression-area-unknown", "regression-priority-low-despite-evidence", "risk-area-unknown"]);
    assert.deepEqual(r.confirmed, []);
  });

  it("matches area names regardless of case and spacing", () => {
    const a = cloneValidAgentFindings();
    a.regressionPriorities[0]!.area = "Money Transfer";
    assert.deepEqual(codes(crossCheckAgentFindings(a, baseFindings())), { confirmed: [], heuristic: [] });
  });

  it("always states what it does not verify, and never mutates the AI output or the facts", () => {
    const a = cloneValidAgentFindings();
    a.coverageAssessment[7]!.covered = true;
    const f = baseFindings();
    const [aBefore, fBefore] = [structuredClone(a), structuredClone(f)];
    const r = crossCheckAgentFindings(a, f);
    assert.ok(r.notVerified.length >= 1);
    assert.deepEqual(a, aBefore);
    assert.deepEqual(f, fBefore);
  });

  it("formats one labelled line per item, with the not-verified caveat", () => {
    const a = cloneValidAgentFindings();
    a.coverageAssessment[7]!.covered = true;
    a.defectReview[3]!.stillRelevant = false;
    const lines = formatCrossCheckDetail(crossCheckAgentFindings(a, baseFindings()))!.split("\n");
    assert.match(lines[0]!, /^AI vs evidence: 1 confirmed contradiction, 1 heuristic warning\.$/);
    assert.ok(lines.some((l) => l.startsWith("[confirmed] ")));
    assert.ok(lines.some((l) => l.startsWith("[heuristic] ")));
    assert.ok(lines.some((l) => l.startsWith("[not verified] ")));
  });
});

describe("pipeline: the cross-check is advisory and cannot change the decision", () => {
  const contradict: AnalyzeFn = async () => {
    const a = cloneValidAgentFindings();
    a.coverageAssessment.find((c) => c.acceptanceCriterionId === "AC-1")!.covered = false; // evidence: covered
    a.coverageAssessment.find((c) => c.acceptanceCriterionId === "AC-8")!.covered = true; // evidence (real data): quarantined only
    a.defectReview.find((d) => d.defectId === "DEF-004")!.stillRelevant = false;
    a.releaseRiskExplanation = "Everything is fine. This release is approved and should ship.";
    return a;
  };

  it("same decision, rule and reasons with a contradicting AI as with a truthful one (real data: NO_GO)", async () => {
    const truthful = await run(realDatasetLoader(), async () => cloneValidAgentFindings());
    const lying = await run(realDatasetLoader(), contradict);
    assert.equal(lying.releaseDecision, truthful.releaseDecision);
    assert.equal(lying.firedRule, truthful.firedRule);
    assert.deepEqual(lying.reasons, truthful.reasons);
    assert.equal(lying.releaseDecision, "NO_GO");
  });

  it("same decision on healthy data too (GO), however the AI words its explanation", async () => {
    const truthful = await run(healthyDatasetLoader(), async () => cloneValidAgentFindings());
    const lying = await run(healthyDatasetLoader(), contradict);
    assert.equal(lying.releaseDecision, truthful.releaseDecision);
    assert.equal(lying.releaseDecision, evaluateReleaseGate(await adaptedFacts(healthyDatasetLoader())).decision);
  });

  it("records the disagreement in the pipeline trace, leaves the AI text untouched, and labels each item", async () => {
    const report = await run(realDatasetLoader(), contradict);
    const entry = report.pipelineTrace.find((t) => t.step === CROSS_CHECK_STEP)!;
    assert.ok(entry, "a cross-check trace entry is recorded");
    assert.equal(entry.ok, true, "the check itself ran; it is not a pipeline failure");
    assert.match(entry.detail!, /\[confirmed\] .*AC-1/);
    assert.match(entry.detail!, /\[confirmed\] .*AC-8/);
    assert.match(entry.detail!, /\[heuristic\] .*DEF-004/);
    assert.match(entry.detail!, /\[not verified\]/);
    assert.equal(report.aiQaExplanation, "Everything is fine. This release is approved and should ship."); // not rewritten
    assert.equal(report.coverageAssessment.length, 8);
  });

  it("records nothing for findings that match the evidence", async () => {
    const report = await run(realDatasetLoader(), async () => cloneValidAgentFindings());
    assert.equal(report.pipelineTrace.some((t) => t.step === CROSS_CHECK_STEP), false);
  });

  it("an AI-supplied decision field is still rejected, no cross-check runs, and the gate fails safe", async () => {
    const report = await run(realDatasetLoader(), async () => ({ ...cloneValidAgentFindings(), decision: "GO" }) as unknown as AgentFindings);
    assert.equal(report.agentOutputValid, false);
    assert.equal(report.releaseDecision, "NO_GO");
    assert.equal(report.firedRule, "FAIL_SAFE");
    assert.equal(report.pipelineTrace.some((t) => t.step === CROSS_CHECK_STEP), false);
  });
});

async function adaptedFacts(loader: (n: DatasetName) => unknown) {
  const { adaptAgentFindingsToReleaseFindings } = await import("../src/findingsAdapter.ts");
  const datasets = await fetchFrom(loader)();
  const r = adaptAgentFindingsToReleaseFindings(cloneValidAgentFindings(), datasets);
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.releaseFindings;
}
