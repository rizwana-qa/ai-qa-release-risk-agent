/**
 * Integration tests for the demo API (`api/server.ts`, `api/pipelineRunner.ts`).
 *
 * These confirm the API only PRESENTS the existing pipeline's output: the
 * decision comes from `evaluateReleaseGate()`, the executive-summary values equal
 * direct calls to the existing gate predicates, and failure never yields GO.
 * They do not touch `src/**`, `data/**`, or the existing 160 tests.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createDemoServer } from "../api/server.ts";
import { computeSummary } from "../api/pipelineRunner.ts";

import { changeRiskLevel, insufficientCoverage, securityFailure } from "../src/releaseGate.ts";
import { adaptAgentFindingsToReleaseFindings } from "../src/findingsAdapter.ts";
import { loadDataset } from "../src/dataLoader.ts";
import { validAgentFindings } from "./agentFixtures.ts";

let server: Server;
let base = "";

before(async () => {
  server = createDemoServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function getJson(path: string, init?: RequestInit) {
  const res = await fetch(base + path, init);
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

/* -------------------------------------------------------------------------- */

describe("demo API — static + scenario endpoints", () => {
  it("GET /api/health", async () => {
    const { status, body } = await getJson("/api/health");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  it("GET /api/scenarios returns exactly REQ-BEN-001", async () => {
    const { body } = await getJson("/api/scenarios");
    assert.equal(body.length, 1);
    assert.equal(body[0].id, "REQ-BEN-001");
  });

  it("GET /api/scenario?id=REQ-BEN-001 returns the dataset facts", async () => {
    const { status, body } = await getJson("/api/scenario?id=REQ-BEN-001");
    assert.equal(status, 200);
    assert.equal(body.requirement.requirementId, "REQ-BEN-001");
    assert.equal(body.acceptanceCriteria.length, 8);
    assert.equal(body.tests.length, 11);
    assert.equal(body.coverageMap.length, 8);
    assert.equal(body.defects.length, 5);
  });

  it("GET /api/scenario with an unknown id is 404", async () => {
    const { status } = await getJson("/api/scenario?id=REQ-NOPE");
    assert.equal(status, 404);
  });

  it("GET /api/meta lists the MCP tools, stages and gate order", async () => {
    const { body } = await getJson("/api/meta");
    assert.equal(body.mcpTools.length, 4);
    assert.equal(body.stages.length, 6);
    assert.deepEqual(body.evaluationOrder, ["GATE-1", "GATE-2", "GATE-3", "GATE-4", "GATE-5"]);
  });

  it("GET / serves the workspace HTML shell", async () => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /AI QA Release Risk &amp; Test Strategy/);
    assert.match(html, /id="view"/);
    assert.match(html, /src="\/app\.js"/);
  });
});

/* -------------------------------------------------------------------------- */

describe("demo API — assessment", () => {
  it("POST /api/assess returns the gate's decision for REQ-BEN-001", async () => {
    const { status, body } = await getJson("/api/assess?id=REQ-BEN-001", { method: "POST" });
    assert.equal(status, 200);
    assert.equal(body.report.releaseDecision, "NO_GO");
    assert.equal(body.report.firedRule, "GATE-2");
    assert.match(body.report.reasons.join(" "), /AC-8/);
    assert.match(body.report.reasons.join(" "), /DEF-004/);
    assert.equal(typeof body.report.aiQaExplanation, "string");
    assert.ok(body.report.aiQaExplanation.length > 0);
    assert.equal(body.report.agentOutputValid, true);
    assert.equal(body.report.adapterOk, true);
    assert.equal(body.mode, "recorded");
    assert.match(body.report.decisionAuthority, /deterministic/i);
  });

  it("summary values equal direct calls to the existing gate predicates", async () => {
    const { body } = await getJson("/api/assess?id=REQ-BEN-001", { method: "POST" });

    const adapted = adaptAgentFindingsToReleaseFindings(validAgentFindings(), {
      requirement: loadDataset("requirement"),
      existingTests: loadDataset("existing-tests"),
      knownDefects: loadDataset("known-defects"),
      riskRules: loadDataset("risk-rules"),
    });
    assert.equal(adapted.ok, true);
    if (!adapted.ok) return;

    assert.equal(body.summary.changeRisk, changeRiskLevel(adapted.releaseFindings));
    assert.equal(
      body.summary.testCoverage,
      insufficientCoverage(adapted.releaseFindings).insufficient ? "insufficient" : "sufficient",
    );
    assert.equal(
      body.summary.securityRisk,
      securityFailure(adapted.releaseFindings).failed ? "failed" : "passed",
    );
    assert.equal(body.summary.changeRisk, "high");
    assert.equal(body.summary.testCoverage, "insufficient");
    assert.equal(body.summary.securityRisk, "failed");
  });

  it("SSE stream emits the six real stages then a result", async () => {
    const res = await fetch(base + "/api/assess/stream?id=REQ-BEN-001");
    assert.equal(res.status, 200);
    const events = (await res.text())
      .split("\n\n")
      .filter((b) => b.startsWith("data: "))
      .map((b) => JSON.parse(b.slice(6)));

    const stageKeys = events.filter((e) => e.type === "stage" && e.status === "running").map((e) => e.key);
    assert.deepEqual(stageKeys, [
      "retrieve-qa-data-mcp",
      "ai-reasoning",
      "validate-structured-findings",
      "deterministic-adapter",
      "deterministic-release-gate",
      "assemble",
    ]);
    const result = events.find((e) => e.type === "result");
    assert.ok(result, "a result event is emitted");
    assert.equal(result.report.releaseDecision, "NO_GO");
  });

  it("fails safe (never GO) when the AI step cannot produce output", async () => {
    const prev = process.env.PIPELINE_AGENT_FINDINGS_FILE;
    process.env.PIPELINE_AGENT_FINDINGS_FILE = "workflows/__does_not_exist__.json";
    try {
      const { body } = await getJson("/api/assess?id=REQ-BEN-001", { method: "POST" });
      assert.notEqual(body.report.releaseDecision, "GO");
      assert.equal(body.report.releaseDecision, "NO_GO");
      assert.equal(body.report.firedRule, "FAIL_SAFE");
      assert.equal(body.report.agentOutputValid, false);
      assert.equal(body.summary, null);
    } finally {
      if (prev === undefined) delete process.env.PIPELINE_AGENT_FINDINGS_FILE;
      else process.env.PIPELINE_AGENT_FINDINGS_FILE = prev;
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("computeSummary — presentation only, no gate logic", () => {
  it("returns null when the adapter did not produce findings", () => {
    assert.equal(computeSummary({ adapterResult: { ok: false, problems: ["x"] } }), null);
    assert.equal(computeSummary({}), null);
  });

  it("forwards the existing predicate results when findings are present", () => {
    const adapted = adaptAgentFindingsToReleaseFindings(validAgentFindings(), {
      requirement: loadDataset("requirement"),
      existingTests: loadDataset("existing-tests"),
      knownDefects: loadDataset("known-defects"),
      riskRules: loadDataset("risk-rules"),
    });
    assert.equal(adapted.ok, true);
    if (!adapted.ok) return;

    const s = computeSummary({ adapterResult: { ok: true, releaseFindings: adapted.releaseFindings } });
    assert.ok(s);
    assert.equal(s!.changeRisk, changeRiskLevel(adapted.releaseFindings));
    assert.deepEqual(s!.coverageReasons, insufficientCoverage(adapted.releaseFindings).reasons);
    assert.deepEqual(s!.securityReasons, securityFailure(adapted.releaseFindings).reasons);
  });
});
