/**
 * The Quality Gates page documents the existing gates. These tests make the
 * documentation fail loudly if it drifts from the rules in `src/releaseGate.ts`
 * and the risk-rules dataset, and confirm the endpoint is read-only.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createDemoServer } from "../api/server.ts";
import { getQualityGates } from "../api/qualityGates.ts";
import { buildPolicy } from "../api/policy.ts";
import { EVALUATION_ORDER, GATE_RULES } from "../src/releaseGate.ts";
import { loadDataset } from "../src/dataLoader.ts";

describe("getQualityGates() reads the real rule definitions", () => {
  const doc = getQualityGates();

  it("lists exactly the gates in GATE_RULES, in evaluation order, with the same condition and decision", () => {
    assert.deepEqual(doc.gates.map((g) => g.id), GATE_RULES.map((g) => g.id));
    assert.deepEqual([...doc.evaluationOrder], [...EVALUATION_ORDER]);
    for (const rule of GATE_RULES) {
      const g = doc.gates.find((x) => x.id === rule.id)!;
      assert.equal(g.condition, rule.condition);
      assert.equal(g.decision, rule.decision);
    }
  });

  it("has complete, non-empty documentation for every gate (no gate silently falls back to blanks)", () => {
    for (const g of doc.gates) {
      assert.ok(g.title && g.title !== g.id, `${g.id} title`);
      for (const k of ["purpose", "riskRelationship", "consequence", "source"] as const) assert.ok(g[k].length > 0, `${g.id} ${k}`);
      assert.ok(g.evidence.length > 0, `${g.id} evidence`);
    }
  });

  it("documents the COV and SEC conditions that the fixed policy and the fixture dataset both define", () => {
    assert.deepEqual(doc.coverageRule.conditions.map((c) => c.id), ["COV-1", "COV-2", "COV-3"]);
    assert.deepEqual(doc.securityRule.conditions.map((c) => c.id), ["SEC-1", "SEC-2"]);
    const fixture = loadDataset("risk-rules") as any;
    const fixtureIds = (r: any) => r.conditions.map((c: any) => c.id);
    assert.deepEqual(doc.coverageRule.conditions.map((c) => c.id), fixtureIds(fixture.insufficientCoverageRule));
    assert.deepEqual(doc.securityRule.conditions.map((c) => c.id), fixtureIds(fixture.securityFailureRule));
  });

  it("reports the COV-3 threshold the fixture and the submitted-evidence policy both use", () => {
    const shown = doc.coverageRule.conditions.find((c) => c.id === "COV-3")!.threshold;
    const fixture = (loadDataset("risk-rules") as any).insufficientCoverageRule.conditions.find((c: any) => c.id === "COV-3");
    const policy = (buildPolicy(["x"], "t") as any).insufficientCoverageRule.conditions.find((c: any) => c.id === "COV-3");
    assert.equal(shown, fixture.illustrativeThreshold);
    assert.equal(shown, policy.illustrativeThreshold);
  });

  it("keeps the executable gates, both rule catalogues and the page in step (ids, order, decisions), including GATE-6", () => {
    const executable = GATE_RULES.map((r) => ({ id: r.id, decision: r.decision }));
    const fixture = (loadDataset("risk-rules") as any).releaseGateRules;
    const policy = (buildPolicy(["x"], "t") as any).releaseGateRules;
    for (const [name, cat] of [["data/risk-rules.json", fixture], ["api/policy.ts", policy]] as const) {
      assert.deepEqual(cat.rules.map((r: any) => ({ id: r.id, decision: r.decision })), executable, `${name} rules`);
      assert.deepEqual(cat.evaluationOrder, [...EVALUATION_ORDER], `${name} evaluationOrder`);
      assert.deepEqual([...cat.decisions].sort(), ["CONDITIONAL", "GO", "NO_GO"], `${name} decisions`);
    }
    assert.deepEqual(doc.gates.map((g) => ({ id: g.id, decision: g.decision })), executable);
    assert.deepEqual(EVALUATION_ORDER.slice(3), ["GATE-4", "GATE-6", "GATE-5"]);
    const g6 = doc.gates.find((g) => g.id === "GATE-6")!;
    assert.equal(g6.decision, "CONDITIONAL");
    assert.match(g6.consequence, /after GATE-4 and before GATE-5/);
  });

  it("states what the minimum does not prove, and no longer says zero tests can produce GO", () => {
    const text = doc.limitations.join(" ");
    assert.match(text, /GATE-6 is a floor, not proof/);
    assert.match(text, /does not establish that every criterion has been verified/);
    assert.doesNotMatch(text, /Zero submitted tests can therefore still produce GO/);
  });

  it("never describes gate severity or a numeric score as defined", () => {
    assert.ok(doc.limitations.some((l) => /no numeric risk score/i.test(l)));
    assert.ok(doc.limitations.some((l) => /no separate severity/i.test(l)));
  });
});

describe("GET /api/quality-gates", () => {
  let server: Server;
  let base = "";
  before(async () => {
    server = createDemoServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves the same document as getQualityGates() and leaves the gate decision alone", async () => {
    const res = await fetch(`${base}/api/quality-gates`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), JSON.parse(JSON.stringify(getQualityGates())));
    // Existing endpoints keep their contract.
    const meta = await (await fetch(`${base}/api/meta`)).json() as any;
    assert.deepEqual(meta.evaluationOrder, [...EVALUATION_ORDER]);
  });

  it("exposes no secrets or environment values", async () => {
    process.env.GEMINI_API_KEY = "test-secret-key-value";
    const text = await (await fetch(`${base}/api/quality-gates`)).text();
    assert.ok(!text.includes("test-secret-key-value"));
    assert.ok(!/GEMINI_API_KEY|process\.env/.test(text));
    delete process.env.GEMINI_API_KEY;
  });

  it("serves the page module", async () => {
    assert.equal((await fetch(`${base}/gates.js`)).status, 200);
  });
});
