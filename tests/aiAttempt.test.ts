/**
 * The `aiAttempt` record: whether a live AI request BEGAN before an assessment fell back to the offline analysis.
 *
 * Offline only. No Gemini client is ever created with a real key: provider behaviour is simulated with fake
 * clients and injected analyzers, and the two tests that use the real analyze function only reach the routing
 * guard, which refuses before any client exists. These tests prove how the application records and reports an
 * attempt; they say nothing about how the live provider behaves.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { buildAiAttempt, attemptBegan, stateFileAttemptBegan, type AiAttempt } from "../api/aiAttempt.ts";
import { runCustomAssessmentInProcess, runFixtureAssessmentInProcess } from "../api/_vercelShared.ts";
import { runCustomAssessment } from "../api/customAssessmentRunner.ts";
import { runAssessment } from "../api/pipelineRunner.ts";
import { normalizeAssessmentInput } from "../api/inputNormalizer.ts";
import { analyzeEvidence } from "../api/evidenceAnalyzer.ts";
import { createGeminiAnalyzeFn } from "../src/geminiAgent.ts";
import { runPipeline } from "../src/pipelineCli.ts";
import type { AgentContext, AnalyzeFn } from "../src/agentContract.ts";
import { SCENARIOS } from "./evaluation/scenarios.ts";
import { realDatasetLoader } from "./agentFixtures.ts";

const ROOT = mkdtempSync(join(tmpdir(), "ai-attempt-test-"));
let n = 0;
after(() => rmSync(ROOT, { recursive: true, force: true }));

const FAKE_KEY = "AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKE12345";

/** Run `fn` with environment variables set, restoring them afterwards (also on failure). */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of before) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const NO_ROUTING = {
  GOOGLE_GENAI_USE_VERTEXAI: undefined, GOOGLE_GENAI_USE_ENTERPRISE: undefined, GOOGLE_CLOUD_PROJECT: undefined, GOOGLE_CLOUD_LOCATION: undefined,
  GOOGLE_VERTEX_BASE_URL: undefined, GOOGLE_GEMINI_BASE_URL: undefined, GEMINI_NEXT_GEN_API_BASE_URL: undefined, GOOGLE_API_KEY: undefined,
};
const DISABLED = { ...NO_ROUTING, GEMINI_API_KEY: undefined };
const ENABLED = { ...NO_ROUTING, GEMINI_API_KEY: FAKE_KEY };

const s01 = SCENARIOS.find((s) => s.id === "S01")!;
const payload = () => structuredClone(s01.payload) as any;
const offlineFindings = () => {
  const r = normalizeAssessmentInput(payload());
  if (!r.ok) throw new Error("did not normalise");
  return analyzeEvidence(r.datasets, r.context, r.coverageStats) as unknown;
};
const GOOD = (): AnalyzeFn => async (ctx) => { ctx.onProviderAttempt?.(); return structuredClone(offlineFindings()); };
const flags = (a: AiAttempt | undefined) => [a?.enabled, a?.began, a?.outcome, a?.fallbackUsed];
const fakeClient = (impl: () => Promise<unknown>) => { const s = { calls: 0 }; return { s, client: { models: { generateContent: async () => { s.calls++; return impl(); } } } as any }; };
const ctxFor = (extra: Partial<AgentContext> = {}): AgentContext => ({
  systemPrompt: "s", analysisSteps: [], toolNames: [], ...extra,
  datasets: { requirement: {}, existingTests: {}, knownDefects: {}, riskRules: {} },
});

describe("buildAiAttempt: every case in the design table", () => {
  const base = { enabled: true, began: true, liveBatchOk: false, aiReasoningOk: false as boolean | undefined, fallbackSupplied: true };
  const cases: Array<[string, Parameters<typeof buildAiAttempt>[0], unknown[]]> = [
    ["disabled", { ...base, enabled: false, began: false, fallbackSupplied: false }, [false, false, "not-attempted", false]],
    ["disabled, even if a stray began flag were passed", { ...base, enabled: false, began: true }, [false, false, "not-attempted", false]],
    ["enabled, live result accepted", { ...base, liveBatchOk: true, aiReasoningOk: true, fallbackSupplied: false }, [true, true, "accepted", false]],
    ["enabled but never started (guard or missing configuration), fallback supplied", { ...base, began: false }, [true, false, "not-attempted", true]],
    ["began, provider error / timeout / unusable reply (ai-reasoning failed)", base, [true, true, "failed", true]],
    ["began, no ai-reasoning entry (process killed)", { ...base, aiReasoningOk: undefined }, [true, true, "failed", true]],
    ["began, reply parsed but rejected by validation or grounding", { ...base, aiReasoningOk: true }, [true, true, "rejected", true]],
    ["began, failed, and the fallback also failed", { ...base, fallbackSupplied: false }, [true, true, "failed", false]],
  ];
  for (const [name, facts, expected] of cases) {
    it(name, () => {
      const a = buildAiAttempt(facts);
      assert.deepEqual([a.enabled, a.began, a.outcome, a.fallbackUsed], expected);
      assert.deepEqual(Object.keys(a).sort(), ["began", "enabled", "fallbackUsed", "outcome"], "booleans and a fixed value only");
    });
  }

  it("began is read from recorded state, never from a flag that merely says a key exists", () => {
    assert.equal(attemptBegan({ providerAttempt: { began: true } }), true);
    for (const v of [null, undefined, {}, { providerAttempt: {} }, { providerAttempt: { began: "true" } }, { providerAttempt: { began: false } }]) assert.equal(attemptBegan(v), false);
    assert.equal(stateFileAttemptBegan(join(ROOT, "missing.json")), false);
  });
});

describe("the hook in createGeminiAnalyzeFn: set when a request begins, never before", () => {
  const order = () => {
    const log: string[] = [];
    return { log, ctx: ctxFor({ onProviderAttempt: () => { log.push("attempt"); } }) };
  };

  it("fires once, before the provider call, on success", async () => {
    const { log, ctx } = order();
    const { client } = fakeClient(async () => { log.push("request"); return { text: "{}", candidates: [{ finishReason: "STOP" }] }; });
    await createGeminiAnalyzeFn({ client })(ctx);
    assert.deepEqual(log, ["attempt", "request"]);
  });

  const failures: Array<[string, () => Promise<unknown>, number?]> = [
    ["a provider error", async () => { throw new Error(`503 unavailable key=${FAKE_KEY}`); }],
    ["a timeout", () => new Promise(() => {}), 25],
    ["a blocked prompt", async () => ({ promptFeedback: { blockReason: "SAFETY" } })],
    ["a truncated reply", async () => ({ text: '{"a":', candidates: [{ finishReason: "MAX_TOKENS" }] })],
    ["an empty reply", async () => ({ text: " ", candidates: [{ finishReason: "STOP" }] })],
    ["unparseable JSON", async () => ({ text: "{not json", candidates: [{ finishReason: "STOP" }] })],
  ];
  for (const [name, impl, timeoutMs] of failures) {
    it(`still fires once when the call ends in ${name}`, async () => {
      const { log, ctx } = order();
      const { client, s } = fakeClient(impl);
      await assert.rejects(createGeminiAnalyzeFn({ client, timeoutMs })(ctx));
      assert.deepEqual(log, ["attempt"]);
      assert.equal(s.calls, 1);
    });
  }

  it("does not fire when the routing guard refuses (no client exists, nothing is started)", async () => {
    const { log, ctx } = order();
    await withEnv({ ...NO_ROUTING, GEMINI_API_KEY: FAKE_KEY, GOOGLE_GENAI_USE_VERTEXAI: "true" }, async () => {
      await assert.rejects(createGeminiAnalyzeFn()(ctx), /was not attempted/);
    });
    assert.deepEqual(log, []);
  });

  it("does not fire when the key is missing", async () => {
    const { log, ctx } = order();
    await withEnv(DISABLED, async () => { await assert.rejects(createGeminiAnalyzeFn()(ctx), /GEMINI_API_KEY is not set/); });
    assert.deepEqual(log, []);
  });

  it("starts no request if recording the attempt fails", async () => {
    const { client, s } = fakeClient(async () => ({ text: "{}", candidates: [{ finishReason: "STOP" }] }));
    const ctx = ctxFor({ onProviderAttempt: () => { throw new Error("cannot record"); } });
    await assert.rejects(createGeminiAnalyzeFn({ client })(ctx), /cannot record/);
    assert.equal(s.calls, 0);
  });
});

describe("the pipeline records the attempt before the request, and only then", () => {
  const stateFile = () => join(ROOT, `state-${n++}.json`);
  const datasets = async () => realDatasetLoader() && {
    requirement: realDatasetLoader()("requirement"), existingTests: realDatasetLoader()("existing-tests"),
    knownDefects: realDatasetLoader()("known-defects"), riskRules: realDatasetLoader()("risk-rules"),
  } as any;

  it("the state file already says began when the request would start, and keeps it when the call fails", async () => {
    const file = stateFile();
    let seenBefore: boolean | null = null;
    const analyze: AnalyzeFn = async (ctx) => {
      ctx.onProviderAttempt?.();
      seenBefore = stateFileAttemptBegan(file); // read while the "request" has not happened yet
      throw new Error("503 unavailable");
    };
    const report = await runPipeline({ stateFile: file, fetchDatasets: datasets, analyze });
    assert.equal(seenBefore, true);
    assert.equal(stateFileAttemptBegan(file), true);
    assert.equal(report.releaseDecision, "NO_GO"); // fail-safe: unchanged behaviour
  });

  it("an offline analyzer never records an attempt", async () => {
    const file = stateFile();
    await runPipeline({ stateFile: file, fetchDatasets: datasets, analyze: async () => JSON.parse(readFileSync("workflows/sample-agent-findings.json", "utf8")) });
    assert.equal(stateFileAttemptBegan(file), false);
    assert.equal(attemptBegan(JSON.parse(readFileSync(file, "utf8"))), false);
  });

  it("if the state cannot be written, the hook throws and began is not recorded", async () => {
    const blocker = join(ROOT, `blocker-${n++}`);
    writeFileSync(blocker, "a file, so a directory cannot be created beneath it");
    let hookError: unknown = null;
    const analyze: AnalyzeFn = async (ctx) => { try { ctx.onProviderAttempt?.(); } catch (e) { hookError = e; } return {}; };
    await assert.rejects(runPipeline({ stateFile: join(blocker, "x", "state.json"), fetchDatasets: datasets, analyze }));
    assert.ok(hookError, "the hook reported the failure to the analyze function");
  });
});

describe("in-process runners: attempt history survives the fallback run", () => {
  const run = (live: AnalyzeFn) => runCustomAssessmentInProcess(payload(), { createLiveAnalyze: () => live });
  const result = async (live: AnalyzeFn, env = ENABLED) => withEnv(env, async () => {
    const o = await run(live);
    assert.equal(o.ok, true);
    return (o as any).result;
  });
  const baseline = async () => withEnv(DISABLED, async () => (await run(GOOD()) as any).result);

  it("Gemini disabled: no attempt, offline rules, nothing started", async () => {
    const r = await baseline();
    assert.equal(r.mode, "rules-based");
    assert.deepEqual(flags(r.aiAttempt), [false, false, "not-attempted", false]);
  });

  it("live result accepted: attempt began, no fallback, mode gemini", async () => {
    const r = await result(GOOD());
    assert.equal(r.mode, "gemini");
    assert.deepEqual(flags(r.aiAttempt), [true, true, "accepted", false]);
  });

  it("provider error after the attempt began: failed, offline fallback supplied, history kept", async () => {
    const r = await result(async (ctx) => { ctx.onProviderAttempt?.(); throw new Error(`503 unavailable key=${FAKE_KEY}`); });
    assert.equal(r.mode, "rules-based");
    assert.deepEqual(flags(r.aiAttempt), [true, true, "failed", true]);
    assert.doesNotMatch(JSON.stringify(r.aiAttempt), /AIza|FAKEFAKE|503/);
  });

  it("timeout (through the real analyze function and a hung fake client): failed, fallback supplied", async () => {
    const { client, s } = fakeClient(() => new Promise(() => {}));
    const r = await withEnv(ENABLED, async () => {
      const o = await runCustomAssessmentInProcess(payload(), { createLiveAnalyze: () => createGeminiAnalyzeFn({ client, timeoutMs: 25 }) });
      return (o as any).result;
    });
    assert.equal(s.calls, 1);
    assert.equal(r.mode, "rules-based");
    assert.deepEqual(flags(r.aiAttempt), [true, true, "failed", true]);
  });

  it("an unparseable reply (real analyze function, fake client): failed, fallback supplied", async () => {
    const { client } = fakeClient(async () => ({ text: "{not json", candidates: [{ finishReason: "STOP" }] }));
    const r = await withEnv(ENABLED, async () => (await runCustomAssessmentInProcess(payload(), { createLiveAnalyze: () => createGeminiAnalyzeFn({ client }) }) as any).result);
    assert.deepEqual(flags(r.aiAttempt), [true, true, "failed", true]);
  });

  it("a reply that parses but fails validation: rejected, fallback supplied", async () => {
    const r = await result(async (ctx) => { ctx.onProviderAttempt?.(); return { not: "findings" }; });
    assert.equal(r.mode, "rules-based");
    assert.deepEqual(flags(r.aiAttempt), [true, true, "rejected", true]);
  });

  it("a reply with an unknown criterion id (adapter grounding rejects it): rejected, fallback supplied", async () => {
    const r = await result(async (ctx) => {
      ctx.onProviderAttempt?.();
      const f: any = structuredClone(offlineFindings());
      f.coverageAssessment.push({ acceptanceCriterionId: "AC99", covered: true, notes: "invented" });
      return f;
    });
    assert.deepEqual(flags(r.aiAttempt), [true, true, "rejected", true]);
  });

  it("enabled but refused before any request (a check failed, hook never fired): began is false, fallback supplied", async () => {
    const r = await result(async () => { throw new Error("Live Gemini analysis was not attempted: configuration."); });
    assert.deepEqual(flags(r.aiAttempt), [true, false, "not-attempted", true]);
  });

  it("the real routing guard refuses before any client exists: enabled, not begun, fallback supplied (no network)", async () => {
    const r = await withEnv({ ...ENABLED, GOOGLE_GENAI_USE_VERTEXAI: "true" }, async () => {
      const o = await runCustomAssessmentInProcess(payload()); // real createGeminiAnalyzeFn, refused by the guard
      return (o as any).result;
    });
    assert.deepEqual(flags(r.aiAttempt), [true, false, "not-attempted", true]);
    assert.equal(r.mode, "rules-based");
  });

  it("the deterministic decision is identical whatever happened to the live attempt", async () => {
    const reference = await baseline();
    const variants: Array<[string, AnalyzeFn]> = [
      ["accepted", GOOD()],
      ["error", async (c) => { c.onProviderAttempt?.(); throw new Error("boom"); }],
      ["rejected", async (c) => { c.onProviderAttempt?.(); return {}; }],
      ["refused", async () => { throw new Error("not attempted"); }],
    ];
    for (const [name, live] of variants) {
      const r = await result(live);
      assert.equal(r.report.releaseDecision, s01.expected.decision, name);
      assert.equal(r.report.firedRule, s01.expected.rule, name);
      assert.deepEqual(r.report.reasons, reference.report.reasons, name);
      assert.deepEqual(r.summary, reference.summary, name);
    }
  });

  it("existing response fields are all still present, and aiAttempt is additive", async () => {
    const r = await result(GOOD());
    for (const key of ["report", "summary", "coverageStats", "context", "provenance", "supportingDocuments", "mode", "meta"]) assert.ok(key in r, key);
    assert.deepEqual(Object.keys(r.aiAttempt).sort(), ["began", "enabled", "fallbackUsed", "outcome"]);
  });

  it("the fixture assessment records the same history: failure after an attempt falls back to the recorded findings", async () => {
    const r = await withEnv(ENABLED, async () => runFixtureAssessmentInProcess({ createLiveAnalyze: () => async (ctx) => { ctx.onProviderAttempt?.(); throw new Error("503"); } }));
    assert.equal(r.mode, "recorded");
    assert.deepEqual(flags(r.aiAttempt), [true, true, "failed", true]);
    const ok = await withEnv(ENABLED, async () => runFixtureAssessmentInProcess({ createLiveAnalyze: () => async (ctx) => { ctx.onProviderAttempt?.(); return JSON.parse(readFileSync("workflows/sample-agent-findings.json", "utf8")); } }));
    assert.equal(ok.mode, "gemini");
    assert.deepEqual(flags(ok.aiAttempt), [true, true, "accepted", false]);
    assert.equal((ok.report as any).releaseDecision, (r.report as any).releaseDecision);
    const off = await withEnv(DISABLED, async () => runFixtureAssessmentInProcess());
    assert.deepEqual(flags(off.aiAttempt), [false, false, "not-attempted", false]);
  });
});

describe("child-process runners (the local server path)", () => {
  it("custom assessment, Gemini disabled: not attempted", async () => {
    const o: any = await withEnv(DISABLED, async () => runCustomAssessment(payload()));
    assert.equal(o.ok, true);
    assert.equal(o.result.mode, "rules-based");
    assert.deepEqual(flags(o.result.aiAttempt), [false, false, "not-attempted", false]);
  });

  it("custom assessment, enabled but refused by the routing guard in the child process: not begun, fallback supplied (no network)", async () => {
    const o: any = await withEnv({ ...ENABLED, GOOGLE_GENAI_USE_VERTEXAI: "true" }, async () => runCustomAssessment(payload()));
    assert.equal(o.ok, true);
    assert.equal(o.result.mode, "rules-based");
    assert.deepEqual(flags(o.result.aiAttempt), [true, false, "not-attempted", true]);
    assert.equal(o.result.report.releaseDecision, s01.expected.decision);
  });

  it("fixture assessment: disabled, and enabled but refused (no network)", async () => {
    const off: any = await withEnv(DISABLED, async () => runAssessment());
    assert.deepEqual(flags(off.aiAttempt), [false, false, "not-attempted", false]);
    const refused: any = await withEnv({ ...ENABLED, GOOGLE_GENAI_USE_VERTEXAI: "true" }, async () => runAssessment());
    assert.equal(refused.mode, "recorded");
    assert.deepEqual(flags(refused.aiAttempt), [true, false, "not-attempted", true]);
    assert.equal(refused.report.releaseDecision, off.report.releaseDecision);
  });
});

describe("the test seam is unreachable from requests and the command line", () => {
  it("no request handler, server file or runner CLI passes deps or names createLiveAnalyze", () => {
    for (const f of ["api/vercel/assess-custom.ts", "api/vercel/assess.ts", "api/server.ts", "tests/evaluation/runner.ts"]) {
      const src = readFileSync(f, "utf8");
      assert.doesNotMatch(src, /createLiveAnalyze|InProcessDeps/, f);
    }
    const shared = readFileSync("api/_vercelShared.ts", "utf8");
    assert.equal((shared.match(/createLiveAnalyze/g) ?? []).length, 3, "only the interface field and the two in-process functions use it");
  });
});
