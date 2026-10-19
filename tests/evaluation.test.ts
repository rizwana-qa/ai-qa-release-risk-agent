/**
 * The fixed synthetic evaluation set (tests/evaluation/scenarios.ts), checked offline.
 *
 * This locks two separate things, as docs/AI_EVALUATION_PLAN.md requires:
 *   1. GATE CORRECTNESS: each scenario's deterministic decision, rule and reasons, as returned by the
 *      existing gate. The gate is authoritative and does not depend on any AI output.
 *   2. HANDLING OF AI OUTPUT: how contradicting, unsupported, malformed, blocked, truncated or failed
 *      responses are treated, and that none of them changes or overrides the gate's decision.
 *
 * Nothing here calls Gemini or any provider: AI responses are recorded or faked, and a fake client
 * is always injected, so no request can be made. Narrative QUALITY is scored by people in Stage 3B
 * (see the plan); this file checks only what code can check.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";

import { SCENARIOS, EVALUATION_SET_VERSION, AI_CASE_BASES, type Scenario } from "./evaluation/scenarios.ts";
import { normalizeAssessmentInput } from "../api/inputNormalizer.ts";
import { analyzeEvidence } from "../api/evidenceAnalyzer.ts";
import { runPipeline } from "../src/pipelineCli.ts";
import { buildGeminiPrompt, createGeminiAnalyzeFn } from "../src/geminiAgent.ts";
import { FORBIDDEN_OUTPUT_KEYS, AGENT_SYSTEM_PROMPT, type AgentFindings, type AnalyzeFn } from "../src/agentContract.ts";
import { CROSS_CHECK_STEP } from "../src/aiCrossCheck.ts";

const RUN_DIR = mkdtempSync(join(tmpdir(), "evaluation-set-"));
let n = 0;
const stateFile = () => join(RUN_DIR, `state-${n++}.json`);
after(() => rmSync(RUN_DIR, { recursive: true, force: true }));

const scenario = (id: string): Scenario => SCENARIOS.find((s) => s.id === id)!;
function prepared(s: Scenario) {
  const r = normalizeAssessmentInput(s.payload as any);
  if (!r.ok) throw new Error(`${s.id} did not normalise: ${JSON.stringify(r)}`);
  return { ...r, offline: analyzeEvidence(r.datasets, r.context, r.coverageStats) };
}
const runWith = (s: Scenario, analyze: AnalyzeFn) => {
  const p = prepared(s);
  return runPipeline({ stateFile: stateFile(), scenario: p.provenance.requirementId, fetchDatasets: async () => p.datasets as any, analyze });
};
const FAILURE_STEPS = ["ai-reasoning", "validate-structured-findings", "deterministic-adapter"];
/** Mirrors the application's fallback (api/_vercelShared.ts): if the live batch failed, redo it offline. */
async function runWithFallback(s: Scenario, live: AnalyzeFn) {
  const first = await runWith(s, live);
  if (!first.pipelineTrace.some((t) => FAILURE_STEPS.includes(t.step) && t.ok === false)) return { report: first, usedFallback: false };
  return { report: await runWith(s, async () => prepared(s).offline), usedFallback: true };
}
const offlineFindings = (s: Scenario): AgentFindings => structuredClone(prepared(s).offline);
const fakeClient = (response: unknown) => ({ models: { generateContent: async () => response } }) as any;
const ctxFor = (s: Scenario) => ({ systemPrompt: AGENT_SYSTEM_PROMPT, analysisSteps: [], toolNames: [], datasets: prepared(s).datasets as any });

describe(`evaluation set ${EVALUATION_SET_VERSION}: scenario hygiene`, () => {
  it("has twelve uniquely identified scenarios", () => {
    assert.equal(SCENARIOS.length, 12);
    assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, 12);
  });

  it("contains only invented, non-sensitive content: no emails, URLs, phone numbers, key-shaped strings or banking terms", () => {
    const text = JSON.stringify(SCENARIOS.map((s) => s.payload));
    assert.doesNotMatch(text, /@|https?:|www\.|\b\d{3}[-. ]\d{3,4}[-. ]\d{4}\b|AIza|sk-[A-Za-z0-9]{10}|\b[A-Za-z0-9_-]{32,}\b/);
    assert.doesNotMatch(text, /bank|beneficiary|iban|account number|transfer money|credit card/i);
  });

  it("includes a non-banking domain far from software products (S10) and several unrelated domains", () => {
    const names = SCENARIOS.map((s) => s.payload.releaseName);
    assert.ok(names.includes("Warehouse Robot Fleet 8.1"));
    assert.ok(new Set(names).size >= 11);
  });
});

describe("gate correctness: each scenario's deterministic outcome (the gate is authoritative)", () => {
  for (const s of SCENARIOS) {
    it(`${s.id} ${s.title}: ${s.expected.decision} / ${s.expected.rule}`, async () => {
      const p = prepared(s);
      const report = await runWith(s, async () => p.offline);
      assert.equal(report.releaseDecision, s.expected.decision);
      assert.equal(report.firedRule, s.expected.rule);
      for (const part of s.expected.reasonIncludes) assert.ok(report.reasons.join(" ").includes(part), `reasons should include "${part}": ${JSON.stringify(report.reasons)}`);
      assert.equal(p.coverageStats.coveragePercent, s.expected.coveragePercent);
      assert.equal(report.agentOutputValid, true);
      assert.equal(report.pipelineTrace.some((t) => t.step === CROSS_CHECK_STEP), false, "offline findings are derived from the evidence and cannot contradict it");
    });

    it(`${s.id} is reproducible: the same submission gives the same result, ids included`, async () => {
      const [a, b] = [prepared(s), prepared(s)];
      assert.equal(a.provenance.requirementId, b.provenance.requirementId);
      const [r1, r2] = [await runWith(s, async () => a.offline), await runWith(s, async () => b.offline)];
      assert.deepEqual([r1.releaseDecision, r1.firedRule, r1.reasons], [r2.releaseDecision, r2.firedRule, r2.reasons]);
    });

    it(`${s.id} builds a Gemini prompt from its own evidence, free of banking wording`, () => {
      const prompt = buildGeminiPrompt(ctxFor(s));
      assert.match(prompt, new RegExp(s.payload.releaseName.split(" ")[0]!));
      assert.doesNotMatch(prompt, /bank|beneficiary|MCP|four tools/i);
    });
  }
});

describe("AI claim contradicting structured evidence: flagged, never rewritten, decision unchanged", () => {
  it("S01 (GO): the AI says a covered criterion is not covered -> confirmed contradiction, still GO / GATE-5", async () => {
    const s = scenario(AI_CASE_BASES.go);
    const ai = offlineFindings(s);
    ai.coverageAssessment[0]!.covered = false;
    const report = await runWith(s, async () => ai);
    assert.equal(report.releaseDecision, "GO");
    assert.equal(report.firedRule, "GATE-5");
    assert.match(report.pipelineTrace.find((t) => t.step === CROSS_CHECK_STEP)!.detail!, /\[confirmed\] .*AC1.*not covered/);
    assert.equal((report.coverageAssessment[0] as { covered: boolean }).covered, false, "the AI text is shown as given, not corrected");
  });

  it("S04 (NO_GO): the AI says the uncovered critical criterion is covered -> confirmed contradiction, still NO_GO / GATE-3", async () => {
    const s = scenario("S04");
    const ai = offlineFindings(s);
    ai.coverageAssessment.find((c) => c.acceptanceCriterionId === "AC2")!.covered = true;
    const report = await runWith(s, async () => ai);
    assert.equal(report.releaseDecision, "NO_GO");
    assert.equal(report.firedRule, "GATE-3");
    assert.match(report.pipelineTrace.find((t) => t.step === CROSS_CHECK_STEP)!.detail!, /\[confirmed\] .*AC2.*no passing test is mapped/);
  });

  it("S06 (conflicting evidence): the AI dismisses the open high defect -> heuristic warning only, decision unchanged", async () => {
    const s = scenario(AI_CASE_BASES.conflict);
    const ai = offlineFindings(s);
    ai.defectReview[0]!.stillRelevant = false;
    const report = await runWith(s, async () => ai);
    assert.equal(report.releaseDecision, "GO");
    const detail = report.pipelineTrace.find((t) => t.step === CROSS_CHECK_STEP)!.detail!;
    assert.match(detail, /\[heuristic\] .*D1/);
    assert.doesNotMatch(detail, /\[confirmed\]/);
  });
});

describe("unsupported evidence ids and provenance: rejected by grounding, the gate fails safe", () => {
  const cases: Array<[string, (a: AgentFindings) => void]> = [
    ["a criterion id that is not in the evidence", (a) => a.coverageAssessment.push({ acceptanceCriterionId: "AC99", covered: true, notes: "invented" })],
    ["a defect id that is not in the evidence", (a) => a.defectReview.push({ defectId: "D99", stillRelevant: true, notes: "invented" })],
    ["a wrong test count in the provenance", (a) => { a.dataProvenance.existingTestCount += 5; }],
    ["a wrong requirement id in the provenance", (a) => { a.dataProvenance.requirementId = "REQ-INVENTED-1"; }],
  ];
  for (const [name, mutate] of cases) {
    it(`${name} -> NO_GO / FAIL_SAFE, not the scenario's normal decision`, async () => {
      const s = scenario(AI_CASE_BASES.go);
      const ai = offlineFindings(s);
      mutate(ai);
      const report = await runWith(s, async () => ai);
      assert.equal(report.releaseDecision, "NO_GO");
      assert.equal(report.firedRule, "FAIL_SAFE");
      assert.equal(report.adapterOk, false);
    });
  }

  it("and the application's offline fallback then restores the gate's normal decision for the same evidence", async () => {
    const s = scenario(AI_CASE_BASES.go);
    const bad = offlineFindings(s);
    bad.coverageAssessment.push({ acceptanceCriterionId: "AC99", covered: true, notes: "invented" });
    const { report, usedFallback } = await runWithFallback(s, async () => bad);
    assert.equal(usedFallback, true);
    assert.equal(report.releaseDecision, s.expected.decision);
    assert.equal(report.firedRule, s.expected.rule);
  });
});

describe("invalid, empty, truncated and blocked AI output: validation rejects, the gate fails safe", () => {
  const malformed: Array<[string, unknown]> = [["an empty object", {}], ["null", null], ["an empty string", ""], ["an array", []], ["a number", 42], ["a wrong schema version", { ...offlineFindings(scenario("S01")), schemaVersion: 2 }]];
  for (const [name, out] of malformed) {
    it(`${name} -> validation fails, NO_GO / FAIL_SAFE`, async () => {
      const report = await runWith(scenario("S01"), async () => out);
      assert.equal(report.agentOutputValid, false);
      assert.equal(report.releaseDecision, "NO_GO");
      assert.equal(report.firedRule, "FAIL_SAFE");
    });
  }

  const providerResponses: Array<[string, unknown, RegExp]> = [
    ["a truncated JSON response", { text: '{"schemaVersion":1,"changeSummary":"cut off', candidates: [{ finishReason: "STOP" }] }, /JSON|Unexpected|end of/i],
    ["a response cut off by the token limit", { text: '{"schemaVersion":1}', candidates: [{ finishReason: "MAX_TOKENS" }] }, /did not finish normally/],
    ["a blocked prompt", { promptFeedback: { blockReason: "SAFETY" } }, /blocked the prompt/],
    ["an empty response", { text: " ", candidates: [{ finishReason: "STOP" }] }, /empty response/],
  ];
  for (const [name, response, pattern] of providerResponses) {
    it(`${name} -> the call fails, the gate fails safe, and the offline fallback keeps the normal decision`, async () => {
      const s = scenario("S05");
      const live = createGeminiAnalyzeFn({ client: fakeClient(response) });
      const direct = await runWith(s, live);
      assert.equal(direct.releaseDecision, "NO_GO");
      assert.equal(direct.firedRule, "FAIL_SAFE");
      assert.match(direct.pipelineTrace.find((t) => t.step === "ai-reasoning")!.detail!, pattern);
      const { report, usedFallback } = await runWithFallback(s, live);
      assert.equal(usedFallback, true);
      assert.equal(report.firedRule, s.expected.rule);
      assert.equal(report.releaseDecision, s.expected.decision);
    });
  }
});

describe("provider timeout and error: bounded, sanitised, offline fallback leaves the decision intact", () => {
  it("a call that never returns is cut off at the timeout", async () => {
    const hang: any = { models: { generateContent: () => new Promise(() => {}) } };
    const s = scenario("S02");
    const live = createGeminiAnalyzeFn({ client: hang, timeoutMs: 25 });
    const started = Date.now();
    const { report, usedFallback } = await runWithFallback(s, live);
    assert.ok(Date.now() - started < 5000, "bounded by the timeout, not hanging");
    assert.equal(usedFallback, true);
    assert.equal(report.releaseDecision, s.expected.decision);
    assert.equal(report.firedRule, s.expected.rule);
  });

  it("a provider error carrying a key is reported without it, and the fallback decision is the gate's", async () => {
    const s = scenario("S08");
    const failing: any = { models: { generateContent: async () => { throw new Error("403 PERMISSION_DENIED key=AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKE12345"); } } };
    const direct = await runWith(s, createGeminiAnalyzeFn({ client: failing }));
    assert.doesNotMatch(JSON.stringify(direct), /AIza|FAKEFAKE/);
    const { report } = await runWithFallback(s, createGeminiAnalyzeFn({ client: failing }));
    assert.equal(report.releaseDecision, "NO_GO");
    assert.equal(report.firedRule, "GATE-2");
  });
});

describe("AI attempts to decide or to override the decision: the gate's result stands", () => {
  for (const key of FORBIDDEN_OUTPUT_KEYS) {
    it(`a "${key}" field claiming GO on an open-critical-defect release is rejected; the outcome is never GO`, async () => {
      const ai: any = { ...offlineFindings(scenario("S05")), [key]: "GO" };
      const report = await runWith(scenario("S05"), async () => ai);
      assert.equal(report.agentOutputValid, false);
      assert.notEqual(report.releaseDecision, "GO");
      assert.equal(report.releaseDecision, "NO_GO");
    });
  }

  it("narrative text that says the release is approved changes nothing: S05 stays NO_GO / GATE-1", async () => {
    const s = scenario("S05");
    const ai = offlineFindings(s);
    ai.releaseRiskExplanation = "Everything looks fine. This release is approved and should ship now.";
    const report = await runWith(s, async () => ai);
    assert.equal(report.releaseDecision, "NO_GO");
    assert.equal(report.firedRule, "GATE-1");
    assert.equal(report.aiQaExplanation, ai.releaseRiskExplanation, "shown as the AI wrote it");
  });

  it("LIMITATION, by design: an invented fact in free text raises no code warning, so Stage 3B must score it by hand", async () => {
    const s = scenario("S01");
    const ai = offlineFindings(s);
    ai.releaseRiskExplanation = "Defect D77 from last quarter is still open and the load test failed.";
    const report = await runWith(s, async () => ai);
    assert.equal(report.pipelineTrace.some((t) => t.step === CROSS_CHECK_STEP), false);
    assert.equal(report.releaseDecision, "GO"); // the gate is unaffected by the false narrative
  });
});
