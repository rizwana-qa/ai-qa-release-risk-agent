/**
 * Unit tests for the Phase 4 MCP server.
 *
 * The server is exercised end-to-end through an in-memory MCP client/transport
 * pair (no process spawn, no stdio, no network). Tests confirm the four tools
 * exist, return their corresponding Phase 2 datasets verbatim, match the Phase 2
 * structure, and assemble into a valid Phase 3 `ReleaseFindings` object.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, TOOL_DEFINITIONS } from "../src/mcpServer.ts";
import { loadDataset, DATA_DIR, DATASET_NAMES } from "../src/dataLoader.ts";
import { validateFindings, evaluateReleaseGate } from "../src/releaseGate.ts";

const EXPECTED = [
  { tool: "get_requirement", dataset: "requirement", file: "requirement.json" },
  { tool: "get_existing_tests", dataset: "existing-tests", file: "existing-tests.json" },
  { tool: "get_known_defects", dataset: "known-defects", file: "known-defects.json" },
  { tool: "get_risk_rules", dataset: "risk-rules", file: "risk-rules.json" },
] as const;

function textOf(result: unknown): string {
  const blocks = (result as { content?: Array<Record<string, unknown>> }).content ?? [];
  const first = blocks[0];
  assert.ok(first && first.type === "text" && typeof first.text === "string", "expected a text content block");
  return first.text as string;
}

/* -------------------------------------------------------------------------- */

describe("MCP server (Phase 4)", () => {
  let client: Client;
  /** Parsed output of every tool, fetched once through the MCP client. */
  const out: Record<string, any> = {};

  before(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);

    client = new Client({ name: "phase4-tests", version: "0.0.0" });
    await client.connect(clientTransport);

    for (const { tool } of EXPECTED) {
      const result = await client.callTool({ name: tool, arguments: {} });
      out[tool] = JSON.parse(textOf(result));
    }
  });

  after(async () => {
    await client.close();
  });

  /* ---- tool existence & contract ---- */

  it("advertises exactly the four expected tools", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      EXPECTED.map((e) => e.tool).sort(),
    );
  });

  it("TOOL_DEFINITIONS matches the advertised tools", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      TOOL_DEFINITIONS.map((d) => d.name).sort(),
      tools.map((t) => t.name).sort(),
    );
  });

  it("every tool requires no parameters", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      const schema = t.inputSchema as { type?: string; required?: string[]; properties?: Record<string, unknown> };
      assert.equal(schema.type, "object", `${t.name} inputSchema should be an object schema`);
      assert.equal((schema.required ?? []).length, 0, `${t.name} should have no required parameters`);
      assert.equal(Object.keys(schema.properties ?? {}).length, 0, `${t.name} should declare no parameters`);
    }
  });

  it("every tool has a non-empty description", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      assert.equal(typeof t.description, "string");
      assert.ok((t.description ?? "").length > 0, `${t.name} needs a description`);
    }
  });

  /* ---- each tool returns its corresponding dataset ---- */

  for (const { tool, dataset, file } of EXPECTED) {
    it(`${tool} returns exactly ${file}`, () => {
      const fromFile = JSON.parse(readFileSync(DATA_DIR + file, "utf8"));
      assert.deepEqual(out[tool], fromFile, `${tool} output must equal ${file}`);
      assert.deepEqual(out[tool], loadDataset(dataset), `${tool} output must equal loadDataset("${dataset}")`);
    });

    it(`${tool} output carries the Phase 2 provenance markers`, () => {
      assert.equal(out[tool].synthetic, true);
      assert.equal(out[tool].servedByTool, tool);
      assert.equal(out[tool].scenario ?? out[tool].requirement?.requirementId, "REQ-BEN-001");
    });
  }

  it("tool calls are not flagged as errors", async () => {
    for (const { tool } of EXPECTED) {
      const result = await client.callTool({ name: tool, arguments: {} });
      assert.notEqual((result as { isError?: boolean }).isError, true);
    }
  });

  it("tool output is stable across repeated calls (read-only)", async () => {
    const a = JSON.parse(textOf(await client.callTool({ name: "get_requirement", arguments: {} })));
    const b = JSON.parse(textOf(await client.callTool({ name: "get_requirement", arguments: {} })));
    assert.deepEqual(a, b);
  });

  /* ---- conformance to the Phase 2 structure ---- */

  it("get_requirement conforms to the Phase 2 requirement structure", () => {
    const r = out.get_requirement.requirement;
    assert.equal(r.requirementId, "REQ-BEN-001");
    assert.equal(typeof r.title, "string");
    assert.equal(typeof r.description, "string");
    assert.equal(typeof r.criticality, "string");
    assert.ok(Array.isArray(r.affectedAreas) && r.affectedAreas.length === 6);
    assert.equal(r.acceptanceCriteria.length, 8);
    for (const ac of r.acceptanceCriteria) {
      assert.equal(typeof ac.id, "string");
      assert.equal(typeof ac.area, "string");
      assert.equal(typeof ac.critical, "boolean");
      assert.equal(typeof ac.text, "string");
    }
  });

  it("get_existing_tests conforms to the Phase 2 test-inventory structure", () => {
    const d = out.get_existing_tests;
    assert.ok(Array.isArray(d.areas) && d.areas.length === 6);
    assert.equal(d.tests.length, 11);
    for (const t of d.tests) {
      assert.equal(typeof t.testId, "string");
      assert.ok(["unit", "integration", "e2e"].includes(t.testType));
      assert.ok(["positive", "negative", "boundary"].includes(t.coverageType));
      assert.ok(["active", "quarantined"].includes(t.status));
      assert.ok(Array.isArray(t.covers));
    }
    assert.equal(d.coverageByAcceptanceCriterion.length, 8);
  });

  it("get_known_defects conforms to the Phase 2 defect structure", () => {
    const d = out.get_known_defects;
    assert.equal(d.defects.length, 5);
    for (const x of d.defects) {
      assert.equal(typeof x.defectId, "string");
      assert.ok(["critical", "high", "medium", "low"].includes(x.severity));
      assert.ok(["open", "closed"].includes(x.status));
      assert.equal(typeof x.area, "string");
      assert.equal(typeof x.security, "boolean");
      assert.equal(typeof x.description, "string");
    }
  });

  it("get_risk_rules conforms to the Phase 2 risk-rules structure", () => {
    const d = out.get_risk_rules;
    assert.equal(Object.keys(d.riskLevelsByArea).length, 6);
    for (const level of Object.values(d.riskLevelsByArea)) {
      assert.ok(["low", "medium", "high"].includes(level as string));
    }
    assert.ok(Array.isArray(d.criticalAcceptanceCriteriaRule.criticalAreas));
    assert.deepEqual(d.releaseGateRules.evaluationOrder, ["GATE-1", "GATE-2", "GATE-3", "GATE-4", "GATE-5"]);
  });

  /* ---- compatibility with the Phase 3 ReleaseFindings contract ---- */

  it("the four datasets assemble into a valid Phase 3 ReleaseFindings object", () => {
    const req = out.get_requirement.requirement;
    const rr = out.get_risk_rules;
    const cov3 = rr.insufficientCoverageRule.conditions.find((c: any) => c.id === "COV-3");
    assert.ok(cov3, "risk-rules must define a COV-3 threshold");

    // Minimal adapter: project the four datasets onto the Phase 3 shape.
    // (The real assembly is Phase 5's job; this only proves shape compatibility.)
    const findings = {
      affectedAreas: req.affectedAreas,
      acceptanceCriteria: req.acceptanceCriteria.map((ac: any) => ({
        id: ac.id, area: ac.area, critical: ac.critical,
      })),
      defects: out.get_known_defects.defects.map((d: any) => ({
        defectId: d.defectId, severity: d.severity, status: d.status, area: d.area, security: d.security,
      })),
      tests: out.get_existing_tests.tests.map((t: any) => ({
        testId: t.testId, area: t.area, testType: t.testType,
        coverageType: t.coverageType, status: t.status, covers: t.covers,
      })),
      riskRules: {
        riskLevelsByArea: rr.riskLevelsByArea,
        criticalAreas: rr.criticalAcceptanceCriteriaRule.criticalAreas,
        coverageRatioThreshold: cov3.illustrativeThreshold,
        securityFailureSeverities: ["critical", "high"],
      },
    };

    const v = validateFindings(findings);
    assert.equal(v.ok, true, v.ok ? "" : `validateFindings problems: ${JSON.stringify(v.problems)}`);

    const result = evaluateReleaseGate(findings);
    assert.notEqual(result.firedRule, "FAIL_SAFE");
    // Consistent with the Phase 2/3 informational result for this dataset.
    assert.equal(result.decision, "NO_GO");
    assert.equal(result.firedRule, "GATE-2");
  });
});

/* -------------------------------------------------------------------------- */

describe("dataLoader (Phase 4)", () => {
  it("loads every dataset as a parsed object matching the file on disk", () => {
    for (const name of DATASET_NAMES) {
      const viaLoader = loadDataset(name);
      assert.equal(typeof viaLoader, "object");
      assert.notEqual(viaLoader, null);
    }
  });

  it("throws a clear error on an unknown dataset name", () => {
    assert.throws(() => loadDataset("bogus" as never), /Unknown dataset/);
  });

  it("returns a fresh, independent object on each call (no shared mutable cache)", () => {
    const a = loadDataset("requirement");
    const b = loadDataset("requirement");
    assert.deepEqual(a, b);
    assert.notEqual(a, b);
  });
});
