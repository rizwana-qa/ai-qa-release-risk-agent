/**
 * Integration tests for the Phase 6 pipeline CLI (`src/pipelineCli.ts`).
 *
 * The CLI is the seam the n8n workflow drives. These run it end to end with a
 * stubbed AI-reasoning step and injected datasets, and confirm the assembled report's
 * decision is always exactly what evaluateReleaseGate() returns.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runPipeline } from "../src/pipelineCli.ts";
import { fetchDatasetsViaMcp } from "../src/mcpDataClient.ts";
import { evaluateReleaseGate } from "../src/releaseGate.ts";
import { adaptAgentFindingsToReleaseFindings } from "../src/findingsAdapter.ts";
import { loadDataset, type DatasetName } from "../src/dataLoader.ts";
import type { AnalyzeFn } from "../src/agentContract.ts";
import {
  validAgentFindings,
  cloneValidAgentFindings,
  healthyDatasetLoader,
} from "./agentFixtures.ts";

const RUN_DIR = mkdtempSync(join(tmpdir(), "pipeline-cli-"));
let counter = 0;
const stateFile = () => join(RUN_DIR, `state-${counter++}.json`);

after(() => rmSync(RUN_DIR, { recursive: true, force: true }));

function loaderToFetch(loader: (name: DatasetName) => unknown) {
  return async () => ({
    requirement: loader("requirement"),
    existingTests: loader("existing-tests"),
    knownDefects: loader("known-defects"),
    riskRules: loader("risk-rules"),
  });
}
const fetchReal = loaderToFetch((n) => loadDataset(n));
const analyzeValid: AnalyzeFn = async () => cloneValidAgentFindings();

/* -------------------------------------------------------------------------- */

describe("runPipeline — valid run reaches the gate", () => {
  it("produces a report whose decision is exactly evaluateReleaseGate()'s", async () => {
    const report = await runPipeline({ stateFile: stateFile(), fetchDatasets: fetchReal, analyze: analyzeValid });

    const adapted = adaptAgentFindingsToReleaseFindings(validAgentFindings(), {
      requirement: loadDataset("requirement"),
      existingTests: loadDataset("existing-tests"),
      knownDefects: loadDataset("known-defects"),
      riskRules: loadDataset("risk-rules"),
    });
    assert.equal(adapted.ok, true);
    if (!adapted.ok) return;
    const gate = evaluateReleaseGate(adapted.releaseFindings);

    assert.equal(report.releaseDecision, gate.decision);
    assert.equal(report.firedRule, gate.firedRule);
    assert.deepEqual(report.reasons, gate.reasons);
    assert.equal(report.releaseDecision, "NO_GO");
    assert.equal(report.firedRule, "GATE-2");
  });

  it("assembles the full report payload", async () => {
    const report = await runPipeline({ stateFile: stateFile(), fetchDatasets: fetchReal, analyze: analyzeValid });

    assert.match(report.decisionAuthority, /deterministic/i);
    assert.match(report.aiQaExplanation ?? "", /AC-8/);
    assert.ok(report.identifiedRisks.length >= 1);
    assert.ok(report.coverageAssessment.length >= 1);
    assert.ok(report.regressionPriorities.length >= 1);
    assert.equal(report.agentOutputValid, true);
    assert.equal(report.adapterOk, true);

    assert.deepEqual(
      report.pipelineTrace.map((t) => t.step),
      ["retrieve-qa-data-mcp", "ai-reasoning", "validate-structured-findings", "deterministic-adapter", "deterministic-release-gate"],
    );
    assert.ok(report.pipelineTrace.every((t) => t.ok));
  });

  it("valid findings on a healthy dataset yield GO — still from the gate", async () => {
    const report = await runPipeline({
      stateFile: stateFile(),
      fetchDatasets: loaderToFetch(healthyDatasetLoader()),
      analyze: analyzeValid,
    });
    assert.equal(report.releaseDecision, "GO");
    assert.equal(report.firedRule, "GATE-5");
  });
});

/* -------------------------------------------------------------------------- */

describe("runPipeline — fail-safe paths (decision still gate-owned)", () => {
  it("malformed agent output -> NO_GO / FAIL_SAFE", async () => {
    const report = await runPipeline({ stateFile: stateFile(), fetchDatasets: fetchReal, analyze: async () => ({}) });
    assert.equal(report.releaseDecision, "NO_GO");
    assert.equal(report.firedRule, "FAIL_SAFE");
    assert.equal(report.agentOutputValid, false);
  });

  it("analyze throws -> NO_GO / FAIL_SAFE with a recorded trace", async () => {
    const report = await runPipeline({
      stateFile: stateFile(),
      fetchDatasets: fetchReal,
      analyze: async () => { throw new Error("model unavailable"); },
    });
    assert.equal(report.releaseDecision, "NO_GO");
    assert.equal(report.firedRule, "FAIL_SAFE");
    assert.equal(report.pipelineTrace.find((t) => t.step === "ai-reasoning")?.ok, false);
  });

  it("an LLM-supplied decision field is rejected, not honoured", async () => {
    const report = await runPipeline({
      stateFile: stateFile(),
      fetchDatasets: fetchReal,
      analyze: async () => ({ ...cloneValidAgentFindings(), decision: "GO" }),
    });
    assert.equal(report.releaseDecision, "NO_GO");
    assert.equal(report.firedRule, "FAIL_SAFE");
    assert.equal(report.agentOutputValid, false);
  });

  it("DEF-01 regression: a Gemini-call-timeout-shaped error still yields a prompt NO_GO / FAIL_SAFE report, not a hang", async () => {
    const started = Date.now();
    const report = await runPipeline({
      stateFile: stateFile(),
      fetchDatasets: fetchReal,
      // Exactly the error createGeminiAnalyzeFn()'s bounded timeout throws
      // (src/geminiAgent.ts) — proves stepAnalyze()'s existing catch-and-record
      // path handles it like any other analyze() failure: a valid assessment
      // is still produced, promptly, never an indefinite wait.
      analyze: async () => {
        throw new Error("Gemini call exceeded the 20000ms timeout.");
      },
    });
    const elapsed = Date.now() - started;

    assert.equal(report.releaseDecision, "NO_GO");
    assert.equal(report.firedRule, "FAIL_SAFE");
    assert.equal(report.agentOutputValid, false);
    assert.match(report.pipelineTrace.find((t) => t.step === "ai-reasoning")?.detail ?? "", /exceeded the 20000ms timeout/);
    assert.ok(elapsed < 2_000, `expected a prompt fail-safe report, not a wait, took ${elapsed}ms`);
  });

  it("ungrounded provenance -> adapter fails, gate fails safe", async () => {
    const report = await runPipeline({
      stateFile: stateFile(),
      fetchDatasets: fetchReal,
      analyze: async () => { const f = cloneValidAgentFindings(); f.dataProvenance.knownDefectCount = 99; return f; },
    });
    assert.equal(report.releaseDecision, "NO_GO");
    assert.equal(report.firedRule, "FAIL_SAFE");
    assert.equal(report.agentOutputValid, true);
    assert.equal(report.adapterOk, false);
  });
});

/* -------------------------------------------------------------------------- */

describe("Phase 6 wiring", () => {
  it("fetchDatasetsViaMcp() returns the four datasets from the live MCP server", async () => {
    const ds = (await fetchDatasetsViaMcp()) as any;
    assert.equal(ds.requirement.requirement.requirementId, "REQ-BEN-001");
    assert.equal(ds.existingTests.tests.length, 11);
    assert.equal(ds.knownDefects.defects.length, 5);
    assert.equal(Object.keys(ds.riskRules.riskLevelsByArea).length, 6);
  });

  it("the offline demo placeholder (PIPELINE_AGENT_FINDINGS_FILE) drives a full run", async () => {
    const sample = fileURLToPath(new URL("../workflows/sample-agent-findings.json", import.meta.url));
    const prev = process.env.PIPELINE_AGENT_FINDINGS_FILE;
    process.env.PIPELINE_AGENT_FINDINGS_FILE = sample;
    try {
      const report = await runPipeline({ stateFile: stateFile(), fetchDatasets: fetchReal });
      assert.equal(report.releaseDecision, "NO_GO");
      assert.equal(report.firedRule, "GATE-2");
      assert.equal(report.agentOutputValid, true);
    } finally {
      if (prev === undefined) delete process.env.PIPELINE_AGENT_FINDINGS_FILE;
      else process.env.PIPELINE_AGENT_FINDINGS_FILE = prev;
    }
  });
});
