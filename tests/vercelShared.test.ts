/**
 * Unit tests for the Vercel in-process runners (api/_vercelShared.ts).
 *
 * These call the exact same functions the local/Render spawn-based runners
 * use (runPipeline(), evaluateReleaseGate() transitively, etc.) — just
 * in-process instead of via child processes. No GEMINI_API_KEY is set here,
 * so createGeminiAnalyzeFn() is never constructed or called: every case
 * below exercises the rules-based/recorded fallback path deterministically,
 * with zero live Gemini calls.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

import { runFixtureAssessmentInProcess, runCustomAssessmentInProcess } from "../api/_vercelShared.ts";
import { coachingPayload, healthyPayload } from "./customFixtures.ts";

let prevKey: string | undefined;
before(() => { prevKey = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY; });
after(() => { if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey; });

describe("runFixtureAssessmentInProcess — no key set", () => {
  it("runs the fixed REQ-BEN-001 scenario in recorded mode and matches the known regression decision", async () => {
    const result = await runFixtureAssessmentInProcess();
    assert.equal(result.mode, "recorded");
    const report = result.report as any;
    assert.equal(report.scenario, "REQ-BEN-001");
    assert.equal(report.releaseDecision, "NO_GO");
    assert.equal(report.firedRule, "GATE-2");
    assert.equal(report.agentOutputValid, true);
    assert.equal(report.adapterOk, true);
    assert.ok(result.summary, "expected a computed executive summary");
  });

  it("leaves no scratch state file behind in the OS temp dir", async () => {
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("vercel-fixture-"));
    await runFixtureAssessmentInProcess();
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith("vercel-fixture-"));
    assert.deepEqual(after, before);
  });
});

describe("runCustomAssessmentInProcess — no key set", () => {
  it("healthy evidence -> GO / GATE-5, in rules-based mode", async () => {
    const outcome = await runCustomAssessmentInProcess(healthyPayload());
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.mode, "rules-based");
    const report = outcome.result.report as any;
    assert.equal(report.releaseDecision, "GO");
    assert.equal(report.firedRule, "GATE-5");
    // The report's scenario id reflects the real submitted requirement, not the fixture's.
    assert.match(report.scenario, /^REQ-USR-/);
  });

  it("critical defect open -> NO_GO / GATE-1, in rules-based mode", async () => {
    const outcome = await runCustomAssessmentInProcess(coachingPayload());
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.mode, "rules-based");
    const report = outcome.result.report as any;
    assert.equal(report.releaseDecision, "NO_GO");
    assert.equal(report.firedRule, "GATE-1");
  });

  it("incomplete input -> 422 with missing[], no pipeline run", async () => {
    const outcome = await runCustomAssessmentInProcess({} as never);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.status, 422);
    assert.ok(outcome.missing.length > 0);
  });

  it("leaves no scratch state file behind in the OS temp dir", async () => {
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("vercel-custom-"));
    await runCustomAssessmentInProcess(healthyPayload());
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith("vercel-custom-"));
    assert.deepEqual(after, before);
  });
});

