/**
 * Phase 2 — custom assessment API end to end.
 *
 * The decision always comes from evaluateReleaseGate(); incomplete input never
 * runs and never yields GO; assessments do not contaminate each other; temp
 * files are removed; REQ-BEN-001 regression is unchanged.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createDemoServer } from "../api/server.ts";
import { normalizeAssessmentInput } from "../api/inputNormalizer.ts";
import { analyzeEvidence } from "../api/evidenceAnalyzer.ts";
import { adaptAgentFindingsToReleaseFindings } from "../src/findingsAdapter.ts";
import { evaluateReleaseGate } from "../src/releaseGate.ts";
import {
  coachingPayload, healthyPayload, conditionalPayload, noEvidenceSecurityPayload,
} from "./customFixtures.ts";

let server: Server;
let base = "";
const RUN_DIR = fileURLToPath(new URL("../.pipeline-run/", import.meta.url));

before(async () => {
  server = createDemoServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

async function postJson(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

/** POST -> runId -> stream; returns the parsed SSE events. */
async function runViaStream(payload: unknown): Promise<any[]> {
  const prep = await postJson("/api/assess/custom", payload);
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  const res = await fetch(`${base}/api/assess/custom/stream?runId=${prep.body.runId}`);
  assert.equal(res.status, 200);
  return (await res.text())
    .split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));
}

/** Independently compute the deterministic decision for a payload. */
function independentDecision(payload: unknown) {
  const n = normalizeAssessmentInput(payload as any);
  if (!n.ok) throw new Error("payload did not normalize");
  const f = analyzeEvidence(n.datasets, n.context, n.coverageStats);
  const a = adaptAgentFindingsToReleaseFindings(f, n.datasets);
  if (!a.ok) throw new Error("adapt failed: " + a.problems.join("; "));
  return evaluateReleaseGate(a.releaseFindings);
}

/* -------------------------------------------------------------------------- */

describe("POST /api/assess/custom — completeness gate", () => {
  it("incomplete input -> 422 with missing[], no runId", async () => {
    const r = await postJson("/api/assess/custom", { userStory: "", acceptanceCriteria: [] });
    assert.equal(r.status, 422);
    assert.equal(r.body.ok, false);
    assert.ok(Array.isArray(r.body.missing) && r.body.missing.length >= 1);
    assert.equal(r.body.runId, undefined);
  });

  it("a non-object body -> 400", async () => {
    const res = await fetch(base + "/api/assess/custom", { method: "POST", body: "not json" });
    assert.equal(res.status, 400);
  });

  it("a body over the 4 MB limit -> 413 with a JSON error (socket is not reset)", async () => {
    const huge = JSON.stringify({ releaseScope: "x".repeat(5 * 1024 * 1024) });
    const res = await fetch(base + "/api/assess/custom", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: huge,
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /exceeds/);
  });

  it("unknown / expired runId on the stream -> 404", async () => {
    const res = await fetch(base + "/api/assess/custom/stream?runId=00000000-0000-0000-0000-000000000000");
    assert.equal(res.status, 404);
  });
});

describe("custom assessment — real stages, gate-owned decision", () => {
  it("streams the six real stages then a result whose decision is evaluateReleaseGate()'s", async () => {
    const events = await runViaStream(coachingPayload());
    const stageKeys = events.filter((e) => e.type === "stage" && e.status === "running").map((e) => e.key);
    assert.deepEqual(stageKeys, [
      "prepare-context", "prepare-evidence", "ai-analysis", "validate", "gate", "assemble",
    ]);
    const result = events.find((e) => e.type === "result");
    assert.ok(result, "result event present");
    const gate = independentDecision(coachingPayload());
    assert.equal(result.report.releaseDecision, gate.decision);
    assert.equal(result.report.firedRule, gate.firedRule);
    assert.equal(result.report.releaseDecision, "NO_GO");
    assert.equal(result.report.firedRule, "GATE-1"); // open critical defect
    assert.equal(result.mode, "rules-based");
    assert.match(result.report.decisionAuthority, /deterministic/i);
  });

  it("blocking mode returns the full result directly", async () => {
    const r = await postJson("/api/assess/custom?blocking=1", coachingPayload());
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.report.releaseDecision, "NO_GO");
    assert.equal(r.body.coverageStats.failed, 1);
    assert.equal(r.body.context.acceptanceCriteria.length, 6);
    assert.deepEqual(r.body.provenance.requirementId, r.body.context.requirementId);
  });

  it("healthy evidence -> GO / GATE-5", async () => {
    const r = await postJson("/api/assess/custom?blocking=1", healthyPayload());
    assert.equal(r.body.report.releaseDecision, "GO");
    assert.equal(r.body.report.firedRule, "GATE-5");
    assert.equal(r.body.report.releaseDecision, independentDecision(healthyPayload()).decision);
  });

  it("high-risk change with thin coverage -> CONDITIONAL / GATE-4", async () => {
    const r = await postJson("/api/assess/custom?blocking=1", conditionalPayload());
    assert.equal(r.body.report.releaseDecision, "CONDITIONAL");
    assert.equal(r.body.report.firedRule, "GATE-4");
  });

  it("no QA evidence for a critical security criterion -> NO_GO / GATE-2 (never GO)", async () => {
    const r = await postJson("/api/assess/custom?blocking=1", noEvidenceSecurityPayload());
    assert.notEqual(r.body.report.releaseDecision, "GO");
    assert.equal(r.body.report.releaseDecision, "NO_GO");
    assert.equal(r.body.report.firedRule, "GATE-2");
  });
});

describe("custom assessment — isolation & hygiene", () => {
  it("consecutive assessments with different input do not contaminate each other", async () => {
    const a = await postJson("/api/assess/custom?blocking=1", coachingPayload());
    const b = await postJson("/api/assess/custom?blocking=1", healthyPayload());
    assert.equal(a.body.report.releaseDecision, "NO_GO");
    assert.equal(b.body.report.releaseDecision, "GO");
    assert.notEqual(a.body.context.requirementId, b.body.context.requirementId);
    assert.notEqual(a.body.report.dataProvenance.requirementId, "REQ-BEN-001");
  });

  it("two prepared runIds stream independent results", async () => {
    const p1 = await postJson("/api/assess/custom", coachingPayload());
    const p2 = await postJson("/api/assess/custom", healthyPayload());
    const [e1, e2] = await Promise.all([
      fetch(`${base}/api/assess/custom/stream?runId=${p1.body.runId}`).then((r) => r.text()),
      fetch(`${base}/api/assess/custom/stream?runId=${p2.body.runId}`).then((r) => r.text()),
    ]);
    const d = (t: string) => t.split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6))).find((x) => x.type === "result");
    assert.equal(d(e1).report.releaseDecision, "NO_GO");
    assert.equal(d(e2).report.releaseDecision, "GO");
  });

  it("a runId is single-use", async () => {
    const prep = await postJson("/api/assess/custom", coachingPayload());
    const first = await fetch(`${base}/api/assess/custom/stream?runId=${prep.body.runId}`);
    assert.equal(first.status, 200);
    await first.text();
    const second = await fetch(`${base}/api/assess/custom/stream?runId=${prep.body.runId}`);
    assert.equal(second.status, 404);
  });

  it("leaves no temporary custom-* files after a run", async () => {
    await postJson("/api/assess/custom?blocking=1", coachingPayload());
    const stray = existsSync(RUN_DIR) ? readdirSync(RUN_DIR).filter((f) => f.startsWith("custom-")) : [];
    assert.deepEqual(stray, []);
  });

  it("untrusted content in a field is carried as inert data and the run still completes", async () => {
    const p = coachingPayload();
    p.acceptanceCriteria[0].text = "<script>alert(1)</script> '; DROP TABLE t;-- ../../etc/passwd";
    const r = await postJson("/api/assess/custom?blocking=1", p);
    assert.equal(r.status, 200);
    assert.ok(r.body.context.acceptanceCriteria[0].text.includes("DROP TABLE"));
    assert.ok(["GO", "NO_GO", "CONDITIONAL"].includes(r.body.report.releaseDecision));
  });
});

describe("REQ-BEN-001 regression is unchanged", () => {
  it("POST /api/assess still returns NO_GO / GATE-2", async () => {
    const r = await postJson("/api/assess?id=REQ-BEN-001", {});
    assert.equal(r.body.report.releaseDecision, "NO_GO");
    assert.equal(r.body.report.firedRule, "GATE-2");
  });
});
