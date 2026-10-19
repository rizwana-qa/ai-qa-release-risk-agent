/**
 * Stage 3B runner controls (tests/evaluation/runner.ts), proved offline with fake analyzers.
 *
 * These tests prove that the CONTROLS behave as designed: dry-run makes no provider request, the cap and the
 * one-attempt rule hold, stop conditions halt the batch, and nothing secret is written. They say nothing about
 * how the live provider behaves. No Gemini client is constructed anywhere in this file: every live-mode run
 * injects its own factory, and environments are fake objects passed in, never the real process environment.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";

import {
  APPROVED_ORDER, APPROVED_SET_FINGERPRINT, HARD_MAX_ATTEMPTS, DEFAULT_RETENTION_DAYS, ConfigError, RequestMeter,
  fingerprintOf, findSensitive, parseCliArgs, purgeExpiredRaw, runBatch, runCli, unknownIdTokens,
  type BatchRecord, type RunnerOptions,
} from "./evaluation/runner.ts";
import { SCENARIOS, EVALUATION_SET_VERSION } from "./evaluation/scenarios.ts";
import { normalizeAssessmentInput } from "../api/inputNormalizer.ts";
import { analyzeEvidence } from "../api/evidenceAnalyzer.ts";
import type { AgentContext, AnalyzeFn } from "../src/agentContract.ts";

const ROOT = mkdtempSync(join(tmpdir(), "s3b-runner-test-"));
const STATE_ROOT = mkdtempSync(join(ROOT, "state-root-"));
let n = 0;
const dir = (label: string) => join(ROOT, `${label}-${n++}`);
after(() => rmSync(ROOT, { recursive: true, force: true }));

const FAKE_KEY = "AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKE12345";
const LIVE_ENV = { GEMINI_API_KEY: FAKE_KEY, GEMINI_MODEL: "fake-model-pinned" } as NodeJS.ProcessEnv;
const FIXED_GIT = () => ({ head: "test-head", workingTreeDirty: false });
const NOW = new Date("2026-10-19T10:00:00Z");

/** Offline findings per requirement id, so a fake "live" analyzer can answer any scenario correctly. */
const FINDINGS = new Map<string, any>();
for (const s of SCENARIOS) {
  const p = normalizeAssessmentInput(s.payload as any);
  if (p.ok) FINDINGS.set(p.provenance.requirementId, analyzeEvidence(p.datasets, p.context, p.coverageStats));
}
const reqIdOf = (c: AgentContext): string => (c.datasets as any).requirement.requirement.requirementId;
const goodAnalyzer = (calls?: string[]): AnalyzeFn => async (c) => { calls?.push(reqIdOf(c)); return structuredClone(FINDINGS.get(reqIdOf(c))); };
const mustNotBeCalled = () => { throw new Error("factory must not be called"); };

const opts = (over: Partial<RunnerOptions> = {}): RunnerOptions => ({
  mode: "dry-run", outDir: dir("out"), env: {}, now: () => NOW, git: FIXED_GIT, stateRoot: STATE_ROOT, ...over,
});
const live = (analyze: AnalyzeFn, over: Partial<RunnerOptions> = {}): RunnerOptions =>
  opts({ mode: "live", env: LIVE_ENV, analyzeFactory: () => analyze, ...over });
const allFilesText = (d: string) => readdirSync(d).map((f) => readFileSync(join(d, f), "utf8")).join("\n");

describe("fixed plan", () => {
  it("allows exactly S01, S05, S02, S06 and a hard cap of four", () => {
    assert.deepEqual([...APPROVED_ORDER], ["S01", "S05", "S02", "S06"]);
    assert.equal(HARD_MAX_ATTEMPTS, 4);
    assert.equal(DEFAULT_RETENTION_DAYS, 7);
  });

  it("the approved scenarios still carry the fingerprint pinned in the runner (any edit is a deliberate version change)", () => {
    assert.equal(EVALUATION_SET_VERSION, "1.0.0");
    assert.equal(fingerprintOf(SCENARIOS), APPROVED_SET_FINGERPRINT);
  });
});

describe("dry-run (the default): zero provider requests", () => {
  it("never builds or calls the live analyzer, attempts four scenarios in order, and passes with the unchanged gate", async () => {
    const record = await runBatch(opts({ analyzeFactory: mustNotBeCalled as any }));
    assert.equal(record.mode, "dry-run");
    assert.equal(record.status, "completed");
    assert.equal(record.actual.providerRequestsAttempted, 0);
    assert.equal(record.actual.assessmentAttempts, 4);
    assert.deepEqual(record.scenarios.map((r) => r.scenarioId), ["S01", "S05", "S02", "S06"]);
    for (const r of record.scenarios) {
      const expected = SCENARIOS.find((s) => s.id === r.scenarioId)!.expected;
      assert.equal(r.mode, "offline-dry-run");
      assert.equal(r.outcome, "pass");
      assert.equal(r.providerRequestsAttempted, 0);
      assert.equal(r.fallback.used, false);
      assert.deepEqual(r.observed, { decision: expected.decision, rule: expected.rule });
    }
  });

  it("the CLI without --live is a dry-run", async () => {
    assert.equal(parseCliArgs([]).live, false);
    const lines: string[] = [];
    const code = await runCli(["--out-dir", dir("cli")], { out: (s) => lines.push(s), err: (s) => lines.push(s) }, { env: {}, git: FIXED_GIT, analyzeFactory: mustNotBeCalled as any });
    assert.equal(code, 0);
    assert.match(lines.join(""), /\(dry-run\) completed/);
    assert.match(lines.join(""), /provider requests attempted 0/);
  });

  it("writes one record per batch with planned versus actual counts, outside the repository", async () => {
    const o = opts();
    const record = await runBatch(o);
    const files = readdirSync(o.outDir!);
    assert.equal(files.length, 1);
    const saved = JSON.parse(readFileSync(join(o.outDir!, files[0]!), "utf8")) as BatchRecord;
    assert.deepEqual(saved.planned.scenarios, ["S01", "S05", "S02", "S06"]);
    assert.equal(saved.planned.maxAssessmentAttempts, 4);
    assert.equal(saved.planned.maxAutomaticRetries, 0);
    assert.equal(saved.actual.assessmentAttempts, record.actual.assessmentAttempts);
    assert.ok(saved.scenarios.every((r) => r.startedAt && r.finishedAt && r.expected.rule && r.observed.rule));
  });
});

describe("configuration fails closed", () => {
  const bad: Array<[string, Partial<RunnerOptions>]> = [
    ["a reordered scenario list", { scenarioIds: ["S05", "S01", "S02", "S06"] }],
    ["an extra scenario", { scenarioIds: ["S01", "S05", "S02", "S06", "S03"] }],
    ["a subset", { scenarioIds: ["S01", "S05"] }],
    ["a scenario outside the approved four", { scenarioIds: ["S01", "S05", "S02", "S09"] }],
    ["a cap above four", { maxAttempts: 5 }],
    ["a cap of zero", { maxAttempts: 0 }],
    ["a fractional cap", { maxAttempts: 2.5 }],
    ["a zero retention period", { retentionDays: 0 }],
    ["a non-integer retention period", { retentionDays: 1.5 }],
    ["an output directory inside the repository", { outDir: join(process.cwd(), "tests", "evaluation-out") }],
    ["a raw directory inside the repository", { rawDir: join(process.cwd(), "raw") }],
  ];
  for (const [name, over] of bad) {
    it(`rejects ${name}`, async () => {
      await assert.rejects(runBatch(opts(over)), ConfigError);
    });
  }

  it("rejects scenario content that no longer matches the approved fingerprint", async () => {
    const tampered = structuredClone(SCENARIOS);
    tampered.find((s) => s.id === "S05")!.expected.decision = "GO";
    await assert.rejects(runBatch(opts({ scenarios: tampered })), /fingerprint/);
  });

  it("rejects a missing scenario", async () => {
    await assert.rejects(runBatch(opts({ scenarios: SCENARIOS.filter((s) => s.id !== "S06") })), ConfigError);
  });

  it("makes no analyze call when configuration is rejected", async () => {
    let called = false;
    await assert.rejects(runBatch(live(async () => { called = true; return {}; }, { maxAttempts: 9 })), ConfigError);
    assert.equal(called, false);
  });
});

describe("request limits", () => {
  it("the meter refuses a second call for the same scenario and any call beyond the batch cap", async () => {
    const meter = new RequestMeter(4);
    const inner: AnalyzeFn = async () => ({});
    const ctx = {} as AgentContext;
    const a = meter.wrap("S01", inner, () => {});
    await a(ctx);
    await assert.rejects(a(ctx), /limit reached/);
    for (const id of ["S05", "S02", "S06"]) await meter.wrap(id, inner, () => {})(ctx);
    assert.equal(meter.total, 4);
    await assert.rejects(meter.wrap("S03", inner, () => {})(ctx), /limit reached/);
    assert.equal(meter.total, 4);
    assert.equal(meter.violations, 2);
  });

  it("a cap below the number of scenarios stops the batch exactly at the cap", async () => {
    const calls: string[] = [];
    const record = await runBatch(live(goodAnalyzer(calls), { maxAttempts: 2 }));
    assert.equal(record.status, "stopped");
    assert.equal(record.stop?.code, "attempt-cap");
    assert.equal(record.actual.assessmentAttempts, 2);
    assert.equal(calls.length, 2);
    assert.deepEqual(record.scenarios.map((r) => r.outcome), ["pass", "pass", "not-run", "not-run"]);
  });

  it("a full live batch makes exactly four analyze calls, one per scenario, in order", async () => {
    const calls: string[] = [];
    const record = await runBatch(live(goodAnalyzer(calls)));
    assert.equal(record.status, "completed");
    assert.equal(calls.length, 4);
    assert.equal(new Set(calls).size, 4);
    assert.equal(record.actual.providerRequestsAttempted, 4);
    assert.ok(record.scenarios.every((r) => r.providerRequestsAttempted === 1 && r.mode === "gemini" && r.outcome === "pass"));
  });
});

describe("no automatic retries", () => {
  it("a failing live call is attempted once, then the offline fallback is recorded; it is never repeated", async () => {
    const calls: string[] = [];
    let failFirst = true;
    const analyze: AnalyzeFn = async (c) => {
      calls.push(reqIdOf(c));
      if (failFirst) { failFirst = false; throw new Error("503 unavailable"); }
      return structuredClone(FINDINGS.get(reqIdOf(c)));
    };
    const record = await runBatch(live(analyze));
    assert.equal(calls.length, 4, "one call per scenario, none repeated");
    const s01 = record.scenarios[0]!;
    assert.equal(s01.providerRequestsAttempted, 1);
    assert.equal(s01.fallback.used, true);
  });

  it("two failed live attempts stop the batch; later scenarios are never run", async () => {
    const calls: string[] = [];
    const failing: AnalyzeFn = async (c) => { calls.push(reqIdOf(c)); throw new Error("timeout"); };
    const record = await runBatch(live(failing));
    assert.equal(record.status, "stopped");
    assert.equal(calls.length, 2);
    assert.deepEqual(record.scenarios.map((r) => r.outcome), ["pass", "pass", "not-run", "not-run"]);
    assert.ok(record.scenarios[2]!.startedAt === null);
    assert.equal(record.stop?.code, "live-path-unusable");
  });
});

describe("provider guard failures stop execution before any request", () => {
  const cases: Array<[string, NodeJS.ProcessEnv, RegExp]> = [
    ["a routing variable is set", { ...LIVE_ENV, GOOGLE_GENAI_USE_VERTEXAI: "SENTINEL-VALUE" }, /GOOGLE_GENAI_USE_VERTEXAI/],
    ["an endpoint override is set", { ...LIVE_ENV, GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:9" }, /GOOGLE_GEMINI_BASE_URL/],
    ["the key is missing", { GEMINI_MODEL: "m" }, /GEMINI_API_KEY is not set/],
    ["the model is not pinned", { GEMINI_API_KEY: FAKE_KEY }, /pin GEMINI_MODEL/],
  ];
  for (const [name, env, pattern] of cases) {
    it(`blocks when ${name}: zero attempts, factory never called, no value shown`, async () => {
      const o = opts({ mode: "live", env, analyzeFactory: mustNotBeCalled as any });
      const record = await runBatch(o);
      assert.equal(record.status, "blocked");
      assert.equal(record.actual.assessmentAttempts, 0);
      assert.equal(record.actual.providerRequestsAttempted, 0);
      assert.equal(record.stop?.code, "preflight-failed");
      assert.match(record.stop!.detail, pattern);
      assert.doesNotMatch(allFilesText(o.outDir!), /SENTINEL-VALUE|127\.0\.0\.1|AIza/);
      assert.ok(record.scenarios.every((r) => r.outcome === "not-run"));
    });
  }

  it("the CLI exits non-zero when --live is blocked", async () => {
    const lines: string[] = [];
    const code = await runCli(["--live", "--out-dir", dir("cli")], { out: (s) => lines.push(s), err: (s) => lines.push(s) }, { env: {}, git: FIXED_GIT, analyzeFactory: mustNotBeCalled as any });
    assert.equal(code, 1);
    assert.match(lines.join(""), /Stopped: preflight-failed/);
  });
});

describe("fallback is recorded distinctly from a live response", () => {
  it("an invalid live response is labelled rules-based-fallback and keeps the gate's decision", async () => {
    const analyze: AnalyzeFn = async (c) => (reqIdOf(c) === requirementIdOf("S01") ? { not: "findings" } : structuredClone(FINDINGS.get(reqIdOf(c))));
    const record = await runBatch(live(analyze));
    const [s01, s05] = record.scenarios;
    assert.equal(s01!.mode, "rules-based-fallback");
    assert.equal(s01!.fallback.used, true);
    assert.equal(s01!.validation.agentOutputValid, false);
    assert.deepEqual(s01!.observed, { decision: "GO", rule: "GATE-5" });
    assert.equal(s05!.mode, "gemini");
    assert.equal(s05!.fallback.used, false);
    assert.equal(record.actual.fallbackRuns, 1);
  });

  it("a fake live success is labelled gemini, never rules-based", async () => {
    const record = await runBatch(live(goodAnalyzer()));
    assert.ok(record.scenarios.every((r) => r.mode === "gemini"));
  });
});

function requirementIdOf(id: string): string {
  const p = normalizeAssessmentInput(SCENARIOS.find((s) => s.id === id)!.payload as any);
  if (!p.ok) throw new Error("not ok");
  return p.provenance.requirementId;
}

describe("stop conditions halt the batch", () => {
  it("a decision-like key in the AI response halts after that scenario and is recorded as an override attempt", async () => {
    const analyze: AnalyzeFn = async (c) => ({ ...structuredClone(FINDINGS.get(reqIdOf(c))), decision: "GO" });
    const record = await runBatch(live(analyze));
    assert.equal(record.status, "stopped");
    assert.equal(record.stop?.code, "override-attempt");
    assert.equal(record.stop?.scenarioId, "S01");
    assert.deepEqual(record.scenarios[0]!.measures.forbiddenKeysInResponse, ["decision"]);
    assert.deepEqual(record.scenarios.map((r) => r.outcome), ["pass", "not-run", "not-run", "not-run"]);
    assert.equal(record.actual.assessmentAttempts, 1);
  });

  it("two invalid live responses stop the batch with repeated-invalid", async () => {
    const record = await runBatch(live(async () => ({})));
    assert.equal(record.status, "stopped");
    assert.equal(record.stop?.code, "repeated-invalid");
    assert.equal(record.actual.assessmentAttempts, 2);
  });

  it("a provider error on every call ends the batch after two requests, with no repeat", async () => {
    const record = await runBatch(live(async () => { throw new Error("boom"); }, { scenarios: SCENARIOS }));
    assert.ok(record.stop);
    assert.equal(record.actual.providerRequestsAttempted, 2);
  });

  it("a provider-guard refusal inside the call is an infrastructure stop at the first scenario", async () => {
    const refusing: AnalyzeFn = async () => { throw new Error("Live Gemini analysis was not attempted: the environment sets GOOGLE_CLOUD_PROJECT."); };
    const record = await runBatch(live(refusing));
    assert.equal(record.status, "stopped");
    assert.equal(record.stop?.code, "infrastructure");
    assert.equal(record.stop?.scenarioId, "S01");
    assert.equal(record.actual.assessmentAttempts, 1);
  });
});

describe("secrets never reach logs or artifacts; errors are sanitised", () => {
  it("a provider error carrying the key and a bearer token is recorded redacted", async () => {
    const o = live(async () => { throw new Error(`403 PERMISSION_DENIED key=${FAKE_KEY} Authorization: Bearer ya29.A0AfH6SMBxxxxxxxxxxxxxxxx ${LIVE_ENV.GEMINI_API_KEY}`); });
    const record = await runBatch(o);
    const text = JSON.stringify(record) + allFilesText(o.outDir!);
    assert.doesNotMatch(text, /AIza|FAKEFAKE|ya29/);
    assert.match(record.scenarios[0]!.trace.find((t) => t.step === "ai-reasoning")!.detail, /\[redacted\]/);
  });

  it("the stdout summary carries no environment value", async () => {
    const lines: string[] = [];
    await runCli(["--live", "--out-dir", dir("cli")], { out: (s) => lines.push(s), err: (s) => lines.push(s) }, { env: { ...LIVE_ENV, GOOGLE_CLOUD_PROJECT: "secret-project-name" }, git: FIXED_GIT, analyzeFactory: mustNotBeCalled as any });
    assert.doesNotMatch(lines.join(""), /AIza|FAKEFAKE|secret-project-name/);
  });

  it("a response whose text contains the key is not saved raw and halts the batch", async () => {
    const analyze: AnalyzeFn = async (c) => ({ ...structuredClone(FINDINGS.get(reqIdOf(c))), releaseRiskExplanation: `see ${FAKE_KEY}` });
    const rawDir = dir("raw");
    const o = live(analyze, { rawDir });
    const record = await runBatch(o);
    assert.equal(record.stop?.code, "sensitive-data");
    assert.equal(record.scenarios[0]!.rawSaved, false);
    assert.doesNotMatch(allFilesText(rawDir) + allFilesText(o.outDir!), /AIza|FAKEFAKE/);
  });

  it("findSensitive reports what kind of thing matched, never the text", () => {
    const hits = findSensitive(`x ${FAKE_KEY} y`, {});
    assert.deepEqual(hits, ["Google API key shape"]);
    assert.deepEqual(findSensitive("value custom-secret-123456 here", { MY_API_TOKEN: "custom-secret-123456" }), ["value of environment variable MY_API_TOKEN"]);
    assert.deepEqual(findSensitive("plain scenario text", { PATH: "/bin", MY_API_TOKEN: "short" }), []);
  });

  it("credentials cannot be passed as arguments: unknown flags are rejected without echoing them", async () => {
    assert.throws(() => parseCliArgs(["--api-key", FAKE_KEY]), ConfigError);
    const lines: string[] = [];
    const code = await runCli(["--api-key", FAKE_KEY], { out: (s) => lines.push(s), err: (s) => lines.push(s) });
    assert.equal(code, 2);
    assert.doesNotMatch(lines.join(""), /AIza|FAKEFAKE/);
    assert.throws(() => parseCliArgs([FAKE_KEY]), ConfigError);
  });

  it("the runner source builds no client of its own and names no credential or endpoint", () => {
    const src = readFileSync(join(import.meta.dirname, "evaluation", "runner.ts"), "utf8");
    assert.doesNotMatch(src, /new GoogleGenAI|from "@google\/genai"|fetch\(|https?:\/\/|process\.env\.GEMINI_API_KEY/);
  });
});

describe("raw responses: outside the repository, 7-day retention by default", () => {
  it("saves live Gemini output only, marks it synthetic, and never saves dry-run or fallback output", async () => {
    const rawDir = dir("raw");
    await runBatch(live(goodAnalyzer(), { rawDir }));
    const files = readdirSync(rawDir).sort();
    assert.equal(files.length, 4);
    const one = JSON.parse(readFileSync(join(rawDir, files[0]!), "utf8"));
    assert.equal(one.syntheticDataOnly, true);
    assert.ok(one.response && one.savedAt);

    const dryRaw = dir("raw");
    await runBatch(opts({ rawDir: dryRaw }));
    assert.equal(readdirSync(dryRaw).length, 0);
  });

  it("purges only expired runner files, using the retention period, and leaves everything else", () => {
    const rawDir = dir("raw");
    mkdtempSync(rawDir + "-x"); // unrelated sibling; must not matter
    rmSync(rawDir, { recursive: true, force: true });
    const make = (name: string, ageDays: number) => {
      const f = join(rawDir, name);
      mkdirIfMissing(rawDir);
      writeFileSync(f, JSON.stringify({ savedAt: new Date(NOW.getTime() - ageDays * 86_400_000).toISOString(), response: {} }));
      const t = new Date(NOW.getTime() - ageDays * 86_400_000);
      utimesSync(f, t, t);
    };
    make("s3b-raw-old-S01.json", 8);
    make("s3b-raw-new-S01.json", 6);
    writeFileSync(join(rawDir, "notes.txt"), "keep me");
    writeFileSync(join(rawDir, "other.json"), "{}");
    assert.equal(purgeExpiredRaw(rawDir, DEFAULT_RETENTION_DAYS, NOW), 1);
    assert.deepEqual(readdirSync(rawDir).sort(), ["notes.txt", "other.json", "s3b-raw-new-S01.json"]);
    assert.equal(purgeExpiredRaw(rawDir, 3, NOW), 1, "a shorter configured period purges the 6-day file");
  });

  it("a run purges expired raw files at start and records how many", async () => {
    const rawDir = dir("raw");
    mkdirIfMissing(rawDir);
    const f = join(rawDir, "s3b-raw-ancient-S01.json");
    writeFileSync(f, JSON.stringify({ savedAt: "2026-01-01T00:00:00Z" }));
    const record = await runBatch(opts({ rawDir }));
    assert.equal(record.retention.purgedFiles, 1);
    assert.equal(existsSync(f), false);
    assert.equal(record.retention.days, 7);
  });
});

describe("informational measure: id-shaped tokens not found in the evidence", () => {
  it("flags invented ids and ignores known ids and rule names", () => {
    const evidence = { tests: [{ testId: "RB-1" }], criteria: ["AC1", "AC2"], defects: [{ defectId: "D1" }] };
    const response = { notes: "AC1 is covered by RB-1; D1 is closed; COV-3 and GATE-5 apply, but AC99 and D77 are not in the data." };
    assert.deepEqual(unknownIdTokens(response, evidence), ["AC99", "D77"]);
  });
});

describe("existing gate expectations are unchanged by the runner", () => {
  it("each approved scenario's observed decision and rule equal the locked expected values", async () => {
    const record = await runBatch(opts());
    const expected = Object.fromEntries(SCENARIOS.map((s) => [s.id, [s.expected.decision, s.expected.rule]]));
    assert.deepEqual(Object.fromEntries(record.scenarios.map((r) => [r.scenarioId, [r.observed.decision, r.observed.rule]])), Object.fromEntries(APPROVED_ORDER.map((id) => [id, expected[id]])));
    assert.deepEqual(APPROVED_ORDER.map((id) => expected[id]), [["GO", "GATE-5"], ["NO_GO", "GATE-1"], ["CONDITIONAL", "GATE-6"], ["GO", "GATE-5"]]);
  });
});

import { mkdirSync } from "node:fs";
function mkdirIfMissing(d: string) { mkdirSync(d, { recursive: true }); }

/* ============================= safety review additions ============================= */

import { createGeminiAnalyzeFn } from "../src/geminiAgent.ts";
import { BASELINE_FILES, baselineDigest, assertOutsideRepo } from "./evaluation/runner.ts";
import { dirname as pathDirname, resolve as pathResolve } from "node:path";
import { existsSync as fsExists, symlinkSync, mkdirSync as fsMkdir } from "node:fs";

/** A fake Gemini client for the REAL createGeminiAnalyzeFn: counts every generateContent call. */
function countingClient(behaviour: (call: number) => unknown | Promise<unknown>) {
  const state = { calls: 0 };
  const client = {
    models: {
      generateContent: async () => {
        state.calls++;
        return behaviour(state.calls);
      },
    },
  } as any;
  return { client, state };
}
const geminiReply = (call: number) => ({ text: JSON.stringify(FINDINGS.get(requirementIdOf(APPROVED_ORDER[call - 1]!))), candidates: [{ finishReason: "STOP" }] });

describe("request enforcement through the real provider invocation", () => {
  it("a full batch through the real createGeminiAnalyzeFn makes exactly four client calls, one per scenario", async () => {
    const { client, state } = countingClient(geminiReply);
    const record = await runBatch(opts({ mode: "live", env: LIVE_ENV, analyzeFactory: () => createGeminiAnalyzeFn({ client }) }));
    assert.equal(state.calls, 4);
    assert.equal(record.actual.providerRequestsAttempted, 4);
    assert.ok(record.scenarios.every((r) => r.providerRequestsAttempted === 1 && r.mode === "gemini" && r.outcome === "pass"));
  });

  it("failed provider calls are counted, are not retried, and the second failure ends the batch", async () => {
    const { client, state } = countingClient(() => { throw new Error("503 unavailable"); });
    const record = await runBatch(opts({ mode: "live", env: LIVE_ENV, analyzeFactory: () => createGeminiAnalyzeFn({ client }) }));
    assert.equal(state.calls, 2, "one failed call per scenario, none repeated, none after the stop");
    assert.equal(record.actual.providerRequestsAttempted, state.calls, "the meter agrees with the client");
    assert.equal(record.stop?.code, "live-path-unusable");
    assert.deepEqual(record.scenarios.map((r) => r.outcome), ["pass", "pass", "not-run", "not-run"]);
  });

  it("a response the pipeline rejects is counted once and the offline fallback adds no provider call", async () => {
    const { client, state } = countingClient(() => ({ text: "{}", candidates: [{ finishReason: "STOP" }] }));
    const record = await runBatch(opts({ mode: "live", env: LIVE_ENV, analyzeFactory: () => createGeminiAnalyzeFn({ client }) }));
    assert.equal(state.calls, 2);
    assert.equal(record.scenarios[0]!.providerRequestsAttempted, 1);
    assert.equal(record.scenarios[0]!.mode, "rules-based-fallback");
  });
});

describe("unexpected exceptions stop the batch", () => {
  it("an exception raised inside the real pipeline path (state serialisation) stops after that scenario and records later ones as not run", async () => {
    // A BigInt cannot be serialised into the pipeline's state file, which makes runPipeline itself reject.
    const analyze: AnalyzeFn = async () => ({ ...structuredClone(FINDINGS.get(requirementIdOf("S01"))), unserialisable: 10n });
    const record = await runBatch(live(analyze));
    assert.equal(record.status, "stopped");
    assert.equal(record.stop?.code, "infrastructure");
    assert.equal(record.stop?.scenarioId, "S01");
    assert.equal(record.actual.assessmentAttempts, 1);
    assert.equal(record.scenarios[0]!.outcome, "fail");
    assert.equal(record.scenarios[0]!.providerRequestsAttempted, 1);
    assert.deepEqual(record.scenarios.slice(1).map((r) => r.outcome), ["not-run", "not-run", "not-run"]);
    assert.ok(record.scenarios.slice(1).every((r) => r.startedAt === null && r.providerRequestsAttempted === 0));
  });

  it("an exception outside the pipeline (the raw-response write) is caught, recorded, and stops the batch with the record kept", async () => {
    const rawDir = dir("raw");
    const analyze: AnalyzeFn = async (c) => { rmSync(rawDir, { recursive: true, force: true }); return structuredClone(FINDINGS.get(reqIdOf(c))); };
    const o = live(analyze, { rawDir });
    const record = await runBatch(o);
    assert.equal(record.status, "stopped");
    assert.equal(record.stop?.code, "infrastructure");
    assert.equal(record.stop?.scenarioId, "S01");
    assert.equal(record.actual.providerRequestsAttempted, 1);
    assert.deepEqual(record.scenarios.slice(1).map((r) => r.outcome), ["not-run", "not-run", "not-run"]);
    assert.equal(readdirSync(o.outDir!).length, 1, "the record was still written");
  });

  it("temporary pipeline state is removed after a normal run, a stop and an exception", async () => {
    const stateDirs = () => readdirSync(STATE_ROOT).sort();
    const before = stateDirs();
    await runBatch(opts());
    await runBatch(live(async () => ({})));
    await runBatch(live(async () => ({ unserialisable: 10n })));
    assert.deepEqual(stateDirs(), before);
  });
});

describe("the provider guard cannot be bypassed or replaced", () => {
  it("a custom preflight passed by a programmatic caller is ignored: a routing variable still blocks, with zero calls", async () => {
    let calls = 0;
    const o = opts({ mode: "live", env: { ...LIVE_ENV, GOOGLE_GENAI_USE_VERTEXAI: "true" }, analyzeFactory: () => async () => { calls++; return {}; } });
    const record = await runBatch({ ...o, preflight: () => {} } as any);
    assert.equal(record.status, "blocked");
    assert.equal(calls, 0);
  });

  it("the guard failing inside the real analyze function (no injected client) is recorded and stops the batch before any client exists", async () => {
    const saved = process.env.GOOGLE_CLOUD_PROJECT;
    const savedKey = process.env.GEMINI_API_KEY;
    try {
      process.env.GOOGLE_CLOUD_PROJECT = "sentinel-project-do-not-print";
      delete process.env.GEMINI_API_KEY; // nothing can be sent without a key either
      const o = opts({ mode: "live", env: { ...LIVE_ENV, GOOGLE_CLOUD_PROJECT: undefined } as NodeJS.ProcessEnv, analyzeFactory: () => createGeminiAnalyzeFn() });
      const record = await runBatch(o);
      assert.equal(record.status, "stopped");
      assert.equal(record.stop?.code, "infrastructure");
      assert.equal(record.actual.assessmentAttempts, 1);
      assert.doesNotMatch(JSON.stringify(record) + allFilesText(o.outDir!), /sentinel-project/);
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_CLOUD_PROJECT; else process.env.GOOGLE_CLOUD_PROJECT = saved;
      if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    }
  });
});

describe("secret handling when the scan itself fires", () => {
  it("a record that matches a secret-named environment value is not retained in full; only counts and codes are written", async () => {
    // Test-only trick: make an ordinary scenario title look like a secret value so the scan fires.
    const o = opts({ env: { SYNTHETIC_TEST_SECRET: "Recipe Box" } as NodeJS.ProcessEnv });
    const record = await runBatch(o);
    const files = readdirSync(o.outDir!);
    assert.equal(files.length, 1);
    const text = readFileSync(join(o.outDir!, files[0]!), "utf8");
    assert.doesNotMatch(text, /Recipe Box/);
    assert.match(text, /sensitive-data/);
    assert.equal(JSON.parse(text).actual.assessmentAttempts, 1);
    assert.equal(record.status, "stopped");
    assert.doesNotMatch(JSON.stringify(record), /Recipe Box/);
  });

  it("when even the minimal record would match, nothing is written and the run is refused", async () => {
    const o = opts({ env: { SYNTHETIC_TEST_SECRET: "evaluationSetVersion" } as NodeJS.ProcessEnv });
    await assert.rejects(runBatch(o), /Refusing to write any evaluation record/);
    assert.equal(readdirSync(o.outDir!).length, 0);
  });

  it("the CLI error path prints a message without values and exits non-zero", async () => {
    const lines: string[] = [];
    const code = await runCli(["--out-dir", dir("cli")], { out: (s) => lines.push(s), err: (s) => lines.push(s) }, { env: { SYNTHETIC_TEST_SECRET: "evaluationSetVersion" } as NodeJS.ProcessEnv, git: FIXED_GIT });
    assert.equal(code, 2);
    assert.doesNotMatch(lines.join(""), /SYNTHETIC_TEST_SECRET=|evaluationSetVersion/);
  });
});

describe("unknown evidence ids and other flags are visible and never read as clean", () => {
  const withProse = (text: string): AnalyzeFn => async (c) => ({ ...structuredClone(FINDINGS.get(reqIdOf(c))), releaseRiskExplanation: text });

  it("invented ids in the AI text flag the scenario; the gate outcome still passes and is reported separately", async () => {
    const record = await runBatch(live(withProse("The earlier defect D77 and criterion AC99 were reopened.")));
    const s01 = record.scenarios[0]!;
    assert.equal(s01.outcome, "pass", "gate correctness is judged separately from narrative");
    assert.deepEqual(s01.measures.unknownIdTokens, ["AC99", "D77"]);
    assert.equal(s01.evidenceCheck.status, "flagged");
    assert.match(s01.evidenceCheck.reasons.join(" "), /AC99, D77/);
    assert.deepEqual(record.humanReview.flaggedScenarios, ["S01", "S05", "S02", "S06"]);
  });

  it("the CLI prints REVIEW lines and exits 3 (gate-correct but flagged), never 0", async () => {
    const lines: string[] = [];
    const code = await runCli(["--live", "--out-dir", dir("cli")], { out: (s) => lines.push(s), err: (s) => lines.push(s) },
      { env: LIVE_ENV, git: FIXED_GIT, analyzeFactory: () => withProse("Defect D77 is open.") });
    assert.equal(code, 3);
    assert.match(lines.join(""), /REVIEW: Id-shaped tokens not found in the evidence: D77/);
    assert.match(lines.join(""), /Human review required/);
  });

  it("a live run with nothing flagged is still marked as requiring human review, and 'clean' is not an accuracy claim", async () => {
    const record = await runBatch(live(goodAnalyzer()));
    assert.equal(record.humanReview.required, true);
    assert.match(record.humanReview.note, /do not detect every unsupported free-text assertion/);
    assert.ok(record.scenarios.every((r) => r.evidenceCheck.status === "clean"));
  });

  it("a fallback run is flagged, and a dry-run is not-applicable", async () => {
    const fallback = await runBatch(live(async () => ({}), { maxAttempts: 4 }));
    assert.equal(fallback.scenarios[0]!.evidenceCheck.status, "flagged");
    const dry = await runBatch(opts());
    assert.ok(dry.scenarios.every((r) => r.evidenceCheck.status === "not-applicable"));
    assert.equal(dry.humanReview.required, false);
  });

  it("with no id prefix in the evidence there is nothing to compare against, so nothing is flagged (see the later, fuller cases)", () => {
    assert.deepEqual(unknownIdTokens({ t: "criterion ac99 and AC 98 were reopened" }, {}), []);
  });
});

describe("retention: exactly what is deleted, and what is not", () => {
  const seed = (rawDir: string, name: string, savedAt: string, ageDays: number) => {
    mkdirIfMissing(rawDir);
    const f = join(rawDir, name);
    writeFileSync(f, JSON.stringify({ savedAt }));
    const t = new Date(NOW.getTime() - ageDays * 86_400_000);
    utimesSync(f, t, t);
    return f;
  };

  it("uses the older of the embedded time and the modification time, so a future embedded time cannot keep a file", () => {
    const rawDir = dir("raw");
    const f = seed(rawDir, "s3b-raw-forged-S01.json", "2099-01-01T00:00:00Z", 10);
    assert.equal(purgeExpiredRaw(rawDir, 7, NOW), 1);
    assert.equal(fsExists(f), false);
  });

  it("never deletes run records, other files, or anything outside the raw directory", () => {
    const rawDir = dir("raw");
    const record = seed(rawDir, "s3b-run-old.json", "2020-01-01T00:00:00Z", 400);
    const other = seed(rawDir, "notes.json", "2020-01-01T00:00:00Z", 400);
    const outside = seed(dir("elsewhere"), "s3b-raw-outside-S01.json", "2020-01-01T00:00:00Z", 400);
    assert.equal(purgeExpiredRaw(rawDir, 7, NOW), 0);
    assert.ok(fsExists(record) && fsExists(other) && fsExists(outside));
  });

  it("reports what it cannot remove instead of skipping it silently (a directory with a raw-file name)", () => {
    const rawDir = dir("raw");
    fsMkdir(join(rawDir, "s3b-raw-trap-S01.json"), { recursive: true });
    const failures: string[] = [];
    assert.equal(purgeExpiredRaw(rawDir, 7, NOW, failures), 0);
    assert.deepEqual(failures, ["s3b-raw-trap-S01.json"]);
    assert.ok(fsExists(join(rawDir, "s3b-raw-trap-S01.json")), "nothing was followed or removed");
  });

  it("a live run is blocked, before any provider call, when expired data cannot be removed", async () => {
    const rawDir = dir("raw");
    fsMkdir(join(rawDir, "s3b-raw-trap-S01.json"), { recursive: true });
    const record = await runBatch(opts({ mode: "live", env: LIVE_ENV, rawDir, analyzeFactory: mustNotBeCalled as any }));
    assert.equal(record.status, "blocked");
    assert.equal(record.stop?.code, "retention-cleanup-failed");
    assert.equal(record.retention.purgeFailures, 1);
    assert.equal(record.actual.providerRequestsAttempted, 0);
  });

  it("a dry-run records the same failure as a note and continues", async () => {
    const rawDir = dir("raw");
    fsMkdir(join(rawDir, "s3b-raw-trap-S01.json"), { recursive: true });
    const record = await runBatch(opts({ rawDir }));
    assert.equal(record.status, "completed");
    assert.match(record.notes.join(" "), /could not be removed/);
  });

  it("bounds: 1 to 365 days; 366, 0 and negative values are rejected", async () => {
    for (const days of [366, 0, -1]) await assert.rejects(runBatch(opts({ retentionDays: days })), ConfigError);
    for (const days of [1, 365]) assert.equal((await runBatch(opts({ retentionDays: days }))).retention.days, days);
  });

  it("directories that resolve into the repository through a link are rejected, even before they exist", () => {
    const link = join(ROOT, `link-${n++}`);
    try { symlinkSync(join(process.cwd(), "tests"), link, "junction"); } catch { return; } // links not permitted here: nothing to prove
    assert.throws(() => assertOutsideRepo(join(link, "new-subdir"), "The output directory"), ConfigError);
    assert.throws(() => assertOutsideRepo(link, "The output directory"), ConfigError);
  });

  it("directories in the repository root, and relative paths that lead there, are rejected", () => {
    assert.throws(() => assertOutsideRepo(process.cwd(), "x"), ConfigError);
    assert.throws(() => assertOutsideRepo(join("tests", "..", "out"), "x"), ConfigError);
  });
});

describe("scenario integrity: any change to an approved scenario fails closed", () => {
  const mutate = (id: string, fn: (s: (typeof SCENARIOS)[number]) => void) => {
    const copy = structuredClone(SCENARIOS);
    fn(copy.find((s) => s.id === id)!);
    return copy;
  };
  const cases: Array<[string, () => typeof SCENARIOS]> = [
    ["a changed test status in the payload", () => mutate("S01", (s) => { (s.payload.testCases[0] as any).status = "Failed"; })],
    ["a changed defect severity", () => mutate("S05", (s) => { (s.payload.knownDefects[0] as any).severity = "low"; })],
    ["a changed acceptance-criterion text", () => mutate("S02", (s) => { (s.payload.acceptanceCriteria[0] as any).text += " "; })],
    ["a changed expected decision", () => mutate("S06", (s) => { s.expected.decision = "NO_GO"; })],
    ["a changed expected rule", () => mutate("S01", (s) => { s.expected.rule = "GATE-4"; })],
    ["changed expected reasons", () => mutate("S05", (s) => { s.expected.reasonIncludes = []; })],
    ["a changed coverage figure", () => mutate("S02", (s) => { s.expected.coveragePercent = 50; })],
    ["a changed title", () => mutate("S01", (s) => { s.title += "!"; })],
  ];
  for (const [name, make] of cases) {
    it(`rejects ${name}, with no analyze call`, async () => {
      let called = false;
      await assert.rejects(runBatch(live(async () => { called = true; return {}; }, { scenarios: make() })), /fingerprint/);
      assert.equal(called, false);
    });
  }

  it("scenarios outside the approved four are not covered by the fingerprint and are never run", async () => {
    const mutated = mutate("S09", (s) => { s.expected.decision = "NO_GO"; });
    const record = await runBatch(opts({ scenarios: mutated }));
    assert.deepEqual(record.scenarios.map((r) => r.scenarioId), ["S01", "S05", "S02", "S06"]);
  });
});

describe("reproducibility: the baseline digest", () => {
  const closure = (): string[] => {
    const root = pathResolve(import.meta.dirname, "..");
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      const re = /(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g;
      for (let m = re.exec(src); m; m = re.exec(src)) visit(pathResolve(pathDirname(file), (m[1] ?? m[2])!));
    };
    visit(join(root, "tests", "evaluation", "runner.ts"));
    return [...seen].map((f) => f.slice(root.length + 1).replaceAll("\\", "/")).sort();
  };

  it("BASELINE_FILES is exactly the static import closure of the runner", () => {
    assert.deepEqual([...BASELINE_FILES].sort(), closure());
  });

  it("every run records the digest and the Node version; the digest ignores line-ending differences", async () => {
    const record = await runBatch(opts());
    assert.equal(record.baseline.fileCount, BASELINE_FILES.length);
    assert.match(record.baseline.sha256, /^[0-9a-f]{64}$/);
    assert.equal(record.baseline.sha256, baselineDigest().sha256);
    assert.equal(record.nodeVersion, process.version);
    const a = mkdtempSync(join(ROOT, "base-a-"));
    const b = mkdtempSync(join(ROOT, "base-b-"));
    for (const rel of BASELINE_FILES) {
      const text = readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
      for (const [root, eol] of [[a, "\n"], [b, "\r\n"]] as const) {
        const f = join(root, rel);
        fsMkdir(pathDirname(f), { recursive: true });
        writeFileSync(f, text.replace(/\n/g, eol));
      }
    }
    assert.equal(baselineDigest(a).sha256, baselineDigest(b).sha256);
  });

  it("fails closed when a baseline file is missing", () => {
    assert.throws(() => baselineDigest(mkdtempSync(join(ROOT, "base-empty-"))), ConfigError);
  });
});

/* ============================= final audit additions ============================= */

import {
  DEFAULT_MAX_BATCH_MS, RecordWriteError, matchesExpected, purgeExpiredRecords, purgeStaleState,
} from "./evaluation/runner.ts";
import { lstatSync as fsLstat } from "node:fs";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("batch deadline", () => {
  it("a hung call is cut off at the deadline, recorded as an unknown result (never a success), and later scenarios are not run", async () => {
    const calls: string[] = [];
    const hung: AnalyzeFn = (c) => { calls.push(reqIdOf(c)); return new Promise(() => {}); };
    const o = live(hung, { maxBatchMs: 400 });
    const started = Date.now();
    const record = await runBatch(o);
    assert.ok(Date.now() - started < 5_000, "the runner did not wait for the hung call");
    assert.equal(record.status, "stopped");
    assert.equal(record.stop?.code, "deadline-exceeded");
    assert.equal(record.stop?.scenarioId, "S01");
    const s01 = record.scenarios[0]!;
    assert.equal(s01.outcome, "fail");
    assert.equal(s01.mode, "not-run");
    assert.equal(s01.observed.decision, null, "no decision is reported for an unfinished scenario");
    assert.equal(s01.providerRequestsAttempted, 1);
    assert.equal(s01.evidenceCheck.status, "flagged");
    assert.match(s01.stopConditions[0]!.detail, /request may still be in flight/);
    assert.deepEqual(record.scenarios.slice(1).map((r) => r.outcome), ["not-run", "not-run", "not-run"]);
    assert.equal(calls.length, 1);
    assert.equal(readdirSync(o.outDir!).length, 1, "the record, with the attempt count, was written");
  });

  it("a call that finishes after the deadline cannot write a raw file or change anything", async () => {
    const rawDir = dir("raw");
    const slow: AnalyzeFn = async (c) => { await sleep(1500); return structuredClone(FINDINGS.get(reqIdOf(c))); };
    const o = live(slow, { maxBatchMs: 400, rawDir });
    const record = await runBatch(o);
    assert.equal(record.stop?.code, "deadline-exceeded");
    await sleep(2000); // let the abandoned call finish
    assert.deepEqual(readdirSync(rawDir), []);
    assert.equal(record.retention.rawStored, false);
    assert.equal(record.scenarios[0]!.rawSaved, false);
    assert.equal(record.scenarios[0]!.outcome, "fail");
  });

  it("no scenario is started once the deadline has passed (checked before each start)", async () => {
    let ticks = 0;
    const calls: string[] = [];
    const o = live(goodAnalyzer(calls), { maxBatchMs: 1_000, clock: () => (ticks++ < 2 ? 0 : 5_000_000) });
    const record = await runBatch(o);
    assert.equal(record.stop?.code, "deadline-exceeded");
    assert.equal(record.stop?.scenarioId, "S05");
    assert.deepEqual(record.scenarios.map((r) => r.outcome), ["pass", "not-run", "not-run", "not-run"]);
    assert.equal(calls.length, 1);
  });

  it("is bounded: 10 ms to 900000 ms; the default is documented", async () => {
    assert.equal(DEFAULT_MAX_BATCH_MS, 120_000);
    for (const ms of [9, 900_001, 0, -5, 1.5]) await assert.rejects(runBatch(opts({ maxBatchMs: ms })), ConfigError);
    assert.equal((await runBatch(opts({ maxBatchMs: 10_000 }))).maxBatchMs, 10_000);
    assert.equal(parseCliArgs(["--max-batch-seconds", "30"]).maxBatchSeconds, 30);
    const lines: string[] = [];
    assert.equal(await runCli(["--max-batch-seconds", "0", "--out-dir", dir("cli")], { out: (s) => lines.push(s), err: (s) => lines.push(s) }), 2);
  });

  it("the record states the deadline and the elapsed time", async () => {
    const record = await runBatch(opts());
    assert.equal(record.maxBatchMs, DEFAULT_MAX_BATCH_MS);
    assert.ok(Number.isInteger(record.elapsedMs) && record.elapsedMs >= 0);
  });
});

describe("provider timeout setting is checked at preflight", () => {
  for (const [label, value, blocked] of [["too large", "999999", true], ["not a number", "abc", true], ["zero", "0", true], ["too small", "10", true], ["in bounds", "20000", false]] as const) {
    it(`GEMINI_TIMEOUT_MS ${label} -> ${blocked ? "blocked, zero calls" : "allowed"}`, async () => {
      let calls = 0;
      const record = await runBatch(live(async (c) => { calls++; return structuredClone(FINDINGS.get(reqIdOf(c))); }, { env: { ...LIVE_ENV, GEMINI_TIMEOUT_MS: value } as NodeJS.ProcessEnv }));
      if (blocked) {
        assert.equal(record.status, "blocked");
        assert.match(record.stop!.detail, /GEMINI_TIMEOUT_MS/);
        assert.equal(calls, 0);
      } else {
        assert.equal(record.status, "completed");
      }
    });
  }
});

describe("the real provider path cannot be combined with weakening seams", () => {
  const real = (over: Partial<RunnerOptions>): RunnerOptions => ({ mode: "live", outDir: dir("out"), now: () => NOW, git: FIXED_GIT, ...over });

  it("a custom environment, repository root or clock is refused when no analyzer is injected (nothing is built or sent)", async () => {
    await assert.rejects(runBatch(real({ env: LIVE_ENV })), /cannot be combined/);
    await assert.rejects(runBatch(real({ repoRoot: ROOT })), /cannot be combined/);
    await assert.rejects(runBatch(real({ clock: () => 0 })), /cannot be combined/);
  });

  it("records whether the analyzer was the default or injected, and says so on screen and in the record", async () => {
    const lines: string[] = [];
    const code = await runCli(["--live", "--out-dir", dir("cli")], { out: (s) => lines.push(s), err: (s) => lines.push(s) },
      { env: LIVE_ENV, git: FIXED_GIT, analyzeFactory: () => goodAnalyzer() });
    assert.equal(code, 0, "gate-correct and nothing flagged: exit 0, but review is still required");
    assert.match(lines.join(""), /NOTE: an injected analyzer was used/);
    assert.match(lines.join(""), /Human review required/);
    const injected = await runBatch(live(goodAnalyzer()));
    assert.equal(injected.analyzerSource, "injected");
    assert.match(injected.notes.join(" "), /not a valid live result/);
    assert.equal((await runBatch(opts())).analyzerSource, "offline");
  });

  it("the command-line entry point passes no overrides, and the Gemini module sets no SDK retry and no Vertex routing", () => {
    const runner = readFileSync(join(import.meta.dirname, "evaluation", "runner.ts"), "utf8");
    const entry = runner.slice(runner.indexOf("if (process.argv[1]"));
    assert.match(entry, /runCli\(process\.argv\.slice\(2\), \{ out:[^}]*err:[^}]*\}\)\.then/);
    const gemini = readFileSync(join(import.meta.dirname, "..", "src", "geminiAgent.ts"), "utf8");
    assert.doesNotMatch(gemini, /retryOptions/);
    assert.doesNotMatch(gemini, /vertexai:\s*true/);
    assert.match(gemini, /vertexai:\s*false/);
  });
});

describe("the audit record itself cannot be written", () => {
  it("is reported explicitly with the counts held in memory; no audit file is claimed", async () => {
    const outDir = dir("out");
    const swap: AnalyzeFn = async (c) => {
      if (!fsExists(join(outDir, "marker"))) { rmSync(outDir, { recursive: true, force: true }); writeFileSync(outDir, "not a directory"); }
      return structuredClone(FINDINGS.get(reqIdOf(c)));
    };
    const err = await runBatch(live(swap, { outDir })).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof RecordWriteError);
    assert.match((err as RecordWriteError).message, /No audit file exists/);
    assert.match((err as RecordWriteError).summary, /provider requests attempted 4/);
  });

  it("the CLI prints that fact, exits 2, and does not print a success line", async () => {
    const outDir = dir("cli");
    const swap: AnalyzeFn = async (c) => { rmSync(outDir, { recursive: true, force: true }); writeFileSync(outDir, "x"); return structuredClone(FINDINGS.get(reqIdOf(c))); };
    const lines: string[] = [];
    const code = await runCli(["--live", "--out-dir", outDir], { out: (s) => lines.push(s), err: (s) => lines.push(s) }, { env: LIVE_ENV, git: FIXED_GIT, analyzeFactory: () => swap });
    assert.equal(code, 2);
    assert.match(lines.join(""), /Known in memory only \(no audit file\): .*provider requests attempted \d/);
    assert.doesNotMatch(lines.join(""), /Stage 3B runner \(live\)/);
  });
});

describe("matchesExpected (the decision-mismatch check)", () => {
  const expected = { decision: "NO_GO" as const, rule: "GATE-1", reasonIncludes: ["open critical defect: D1"], coveragePercent: 100 };
  it("requires decision, rule and every reason fragment", () => {
    assert.equal(matchesExpected(expected, "NO_GO", "GATE-1", ["GATE-1: open critical defect: D1."]), true);
    assert.equal(matchesExpected(expected, "GO", "GATE-1", ["open critical defect: D1"]), false);
    assert.equal(matchesExpected(expected, "NO_GO", "GATE-3", ["open critical defect: D1"]), false);
    assert.equal(matchesExpected(expected, "NO_GO", "GATE-1", ["something else"]), false);
    assert.equal(matchesExpected(expected, null, null, []), false);
  });
});

describe("retention of run records and temporary state", () => {
  const seed = (d: string, name: string, content: string, ageDays: number) => {
    mkdirIfMissing(d);
    const f = join(d, name);
    writeFileSync(f, content);
    const t = new Date(NOW.getTime() - ageDays * 86_400_000);
    utimesSync(f, t, t);
    return f;
  };

  it("expired run records are removed; newer records, other files and files outside the directory are not", () => {
    const out = dir("out");
    const old = seed(out, "s3b-run-old.json", JSON.stringify({ startedAt: "2026-01-01T00:00:00Z" }), 30);
    const forged = seed(out, "s3b-run-forged.json", JSON.stringify({ startedAt: "2099-01-01T00:00:00Z" }), 30);
    const malformed = seed(out, "s3b-run-malformed.json", "{not json", 30);
    const partial = seed(out, "s3b-run-crash.json.partial", "{\"startedAt\":", 30);
    const fresh = seed(out, "s3b-run-fresh.json", JSON.stringify({ startedAt: NOW.toISOString() }), 1);
    const unrelated = seed(out, "report.json", "{}", 400);
    const elsewhere = seed(dir("elsewhere"), "s3b-run-elsewhere.json", "{}", 400);
    const failures: string[] = [];
    assert.equal(purgeExpiredRecords(out, 7, NOW, failures), 4);
    assert.deepEqual(failures, []);
    for (const gone of [old, forged, malformed, partial]) assert.equal(fsExists(gone), false);
    for (const kept of [fresh, unrelated, elsewhere]) assert.equal(fsExists(kept), true);
  });

  it("a run removes expired records in its output directory and reports the count; the new record survives", async () => {
    const o = opts();
    seed(o.outDir!, "s3b-run-ancient.json", JSON.stringify({ startedAt: "2020-01-01T00:00:00Z" }), 400);
    const record = await runBatch(o);
    assert.equal(record.retention.purgedRecords, 1);
    assert.deepEqual(readdirSync(o.outDir!).filter((f) => f.startsWith("s3b-run-")).length, 1);
  });

  it("a directory or link with a record's name is reported, never followed or removed, and blocks a live run before any call", async () => {
    const o = live(async () => ({}), { analyzeFactory: mustNotBeCalled as any });
    fsMkdir(join(o.outDir!, "s3b-run-trap.json"), { recursive: true });
    const record = await runBatch(o);
    assert.equal(record.status, "blocked");
    assert.equal(record.stop?.code, "retention-cleanup-failed");
    assert.equal(record.actual.providerRequestsAttempted, 0);
    assert.equal(fsExists(join(o.outDir!, "s3b-run-trap.json")), true);
    const dry = opts();
    fsMkdir(join(dry.outDir!, "s3b-run-trap.json"), { recursive: true });
    assert.match((await runBatch(dry)).notes.join(" "), /could not be removed/);
  });

  it("stale temporary state: removes only old, runner-shaped directories holding only runner-shaped files", () => {
    const root = dir("state");
    const mk = (name: string, files: string[], ageDays: number) => {
      const d = join(root, name);
      fsMkdir(d, { recursive: true });
      for (const f of files) writeFileSync(join(d, f), "{}");
      const t = new Date(NOW.getTime() - ageDays * 86_400_000);
      utimesSync(d, t, t);
      return d;
    };
    const stale = mk("s3b-state-aaaaaa", ["S01-live.json", "S05-fallback.json"], 3);
    const recent = mk("s3b-state-bbbbbb", ["S01-live.json"], 0);
    const foreign = mk("s3b-state-cccccc", ["S01-live.json", "notes.txt"], 3);
    const other = mk("something-else", ["S01-live.json"], 30);
    const failures: string[] = [];
    assert.equal(purgeStaleState(root, NOW, failures), 1);
    assert.deepEqual(failures, ["s3b-state-cccccc"]);
    assert.equal(fsExists(stale), false);
    for (const kept of [recent, foreign, other]) assert.equal(fsExists(kept), true);
  });

  it("stale-state cleanup does not follow a link that has the runner's directory name", () => {
    const root = dir("state");
    const target = dir("target");
    fsMkdir(target, { recursive: true });
    writeFileSync(join(target, "S01-live.json"), "{}");
    fsMkdir(root, { recursive: true });
    try { symlinkSync(target, join(root, "s3b-state-link"), "junction"); } catch { return; }
    const failures: string[] = [];
    assert.equal(purgeStaleState(root, new Date(NOW.getTime() + 10 * 86_400_000), failures), 0);
    assert.deepEqual(failures, ["s3b-state-link"]);
    assert.equal(fsExists(join(target, "S01-live.json")), true);
    assert.equal(fsLstat(join(root, "s3b-state-link")).isSymbolicLink() || fsLstat(join(root, "s3b-state-link")).isDirectory(), true);
  });

  it("a run uses a fresh state directory under the configured root and removes it, including after a stop", async () => {
    const root = dir("state");
    fsMkdir(root, { recursive: true });
    await runBatch(opts({ stateRoot: root }));
    await runBatch(live(async () => ({}), { stateRoot: root }));
    assert.deepEqual(readdirSync(root), []);
  });

  it("records are written atomically: no .partial file remains after a normal run", async () => {
    const o = live(goodAnalyzer(), { rawDir: dir("raw") });
    await runBatch(o);
    assert.ok(![...readdirSync(o.outDir!), ...readdirSync(o.rawDir!)].some((f) => f.endsWith(".partial")));
  });
});

describe("id-shaped token check, improved but still partial", () => {
  const evidence = { criteria: ["AC1"], tests: [{ label: "RB-1" }], defects: [{ id: "D1" }] };

  it("flags lower-case and spaced forms of prefixes the evidence itself uses", () => {
    const text = { a: "ac99 and AC 98 and rb-7 and RB 3 and d77 were reopened; ac1, RB 1 and D1 are fine." };
    assert.deepEqual(unknownIdTokens(text, evidence), ["AC98", "AC99", "D77", "RB-7", "RB3"]);
  });

  it("does not flag ordinary text, a single letter with a space, or rule names", () => {
    assert.deepEqual(unknownIdTokens({ a: "Week 5, page 3, section D 5, GATE-5 and COV-3 apply" }, evidence), []);
  });

  it("cannot see claims that name no id, wrong claims about real ids, or unusual spellings (limitation kept)", () => {
    assert.deepEqual(unknownIdTokens({ a: "The checkout test failed last quarter, and AC1 is not covered." }, evidence), []);
    assert.deepEqual(unknownIdTokens({ a: "Criterion number ninety-nine" }, evidence), []);
  });
});
