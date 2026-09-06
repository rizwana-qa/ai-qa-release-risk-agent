/**
 * Tests for the Phase 6 n8n workflow definition.
 *
 * These verify the workflow is a valid, linear orchestration that references
 * only in-repo components, carries no secrets, and defines no QA / decision
 * rules of its own.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PIPELINE_STEPS } from "../src/pipelineCli.ts";

const WORKFLOW_URL = new URL("../workflows/release-risk-assessment.n8n.json", import.meta.url);
const RAW = readFileSync(WORKFLOW_URL, "utf8");
const WF = JSON.parse(RAW) as any;

const TRIGGER = "Manual Trigger";
const STEP_NODES = [
  "Retrieve QA Data (MCP)",
  "AI Reasoning",
  "Validate Structured Findings",
  "Deterministic Adapter",
  "Deterministic Release Gate",
  "Assemble Release Report",
];

function nodeByName(name: string): any {
  return WF.nodes.find((n: any) => n.name === name);
}

/* -------------------------------------------------------------------------- */

describe("n8n workflow — valid JSON and shape", () => {
  it("parses as JSON with the expected top-level fields", () => {
    assert.equal(typeof WF.name, "string");
    assert.ok(Array.isArray(WF.nodes));
    assert.equal(typeof WF.connections, "object");
    assert.equal(WF.active, false, "workflow must be inactive");
    assert.equal(WF.settings?.executionOrder, "v1");
  });

  it("has exactly the 7 expected nodes", () => {
    assert.equal(WF.nodes.length, 7);
    const names = WF.nodes.map((n: any) => n.name).sort();
    assert.deepEqual(names, [TRIGGER, ...STEP_NODES].sort());
  });

  it("uses only a manual trigger and executeCommand nodes", () => {
    assert.equal(nodeByName(TRIGGER).type, "n8n-nodes-base.manualTrigger");
    for (const name of STEP_NODES) {
      assert.equal(nodeByName(name).type, "n8n-nodes-base.executeCommand", `${name} must be executeCommand`);
    }
  });

  it("contains no code/function nodes (nowhere for logic to hide)", () => {
    const codeish = ["n8n-nodes-base.code", "n8n-nodes-base.function", "n8n-nodes-base.functionItem"];
    for (const n of WF.nodes) assert.ok(!codeish.includes(n.type), `${n.name} is a code node`);
  });
});

/* -------------------------------------------------------------------------- */

describe("n8n workflow — node relationships form one linear chain", () => {
  it("every connection endpoint refers to a real node", () => {
    const names = new Set(WF.nodes.map((n: any) => n.name));
    for (const [src, conn] of Object.entries<any>(WF.connections)) {
      assert.ok(names.has(src), `connection source "${src}" is not a node`);
      for (const group of conn.main) {
        for (const target of group) assert.ok(names.has(target.node), `connection target "${target.node}" is not a node`);
      }
    }
  });

  it("each source fans out to exactly one target (no branching)", () => {
    for (const [src, conn] of Object.entries<any>(WF.connections)) {
      assert.equal(conn.main.length, 1, `${src} should have one output`);
      assert.equal(conn.main[0].length, 1, `${src} should connect to exactly one node`);
    }
  });

  it("walks Trigger -> ... -> Assemble Release Report visiting all nodes once", () => {
    const next = (name: string): string | undefined => WF.connections[name]?.main?.[0]?.[0]?.node;

    const order: string[] = [TRIGGER];
    let cur = TRIGGER;
    for (let i = 0; i < 10; i++) {
      const n = next(cur);
      if (!n) break;
      assert.ok(!order.includes(n), `cycle detected at ${n}`);
      order.push(n);
      cur = n;
    }

    assert.deepEqual(order, [TRIGGER, ...STEP_NODES]);
    assert.equal(next(order.at(-1) as string), undefined, "last node must have no outgoing connection");
  });

  it("every non-trigger node has exactly one inbound connection", () => {
    const inbound = new Map<string, number>();
    for (const conn of Object.values<any>(WF.connections)) {
      for (const group of conn.main) for (const t of group) inbound.set(t.node, (inbound.get(t.node) ?? 0) + 1);
    }
    assert.equal(inbound.get(TRIGGER) ?? 0, 0);
    for (const name of STEP_NODES) assert.equal(inbound.get(name), 1, `${name} should have one inbound`);
  });
});

/* -------------------------------------------------------------------------- */

describe("n8n workflow — references only intended in-repo components", () => {
  const COMMAND_RE =
    /^node src\/pipelineCli\.ts (fetch-data|analyze|validate|adapt|gate|assemble) --state \.\/\.pipeline-run\/state\.json$/;

  it("every executeCommand runs a whitelisted src/pipelineCli.ts step", () => {
    for (const name of STEP_NODES) {
      const cmd = nodeByName(name).parameters.command as string;
      assert.match(cmd, COMMAND_RE, `${name} command not whitelisted: ${cmd}`);
    }
  });

  it("the six step names, in chain order, equal PIPELINE_STEPS", () => {
    const steps = STEP_NODES.map((name) => (nodeByName(name).parameters.command as string).split(" ")[2]);
    assert.deepEqual(steps, [...PIPELINE_STEPS]);
  });

  it("the referenced CLI file exists in the repo", () => {
    assert.ok(existsSync(fileURLToPath(new URL("../src/pipelineCli.ts", import.meta.url))));
  });
});

/* -------------------------------------------------------------------------- */

describe("n8n workflow — no secrets or real endpoints", () => {
  it("contains no URLs", () => {
    assert.doesNotMatch(RAW, /https?:\/\//i);
  });

  it("contains no credential-like tokens", () => {
    assert.doesNotMatch(RAW, /\b(api[_-]?key|apikey|authorization|bearer|password|passwd|secret|client[_-]?secret|private[_-]?key|access[_-]?token)\b/i);
    assert.doesNotMatch(RAW, /\bsk-[A-Za-z0-9]/);
    assert.doesNotMatch(RAW, /\bAKIA[0-9A-Z]{8}/);
    assert.doesNotMatch(RAW, /-----BEGIN/);
  });

  it("attaches no credentials to any node", () => {
    for (const n of WF.nodes) assert.equal(n.credentials, undefined, `${n.name} has credentials`);
    assert.equal(WF.credentials, undefined);
  });

  it("the only environment values referenced are documented placeholders", () => {
    // GEMINI_API_KEY / PIPELINE_AGENT_FINDINGS_FILE may be *named* in notes, never assigned a value.
    assert.doesNotMatch(RAW, /GEMINI_API_KEY\s*[:=]\s*\S/);
    assert.doesNotMatch(RAW, /PIPELINE_AGENT_FINDINGS_FILE\s*=\s*[^.]/); // only the ./workflows/... placeholder allowed
  });
});

/* -------------------------------------------------------------------------- */

describe("n8n workflow — the deterministic gate stays the decision authority", () => {
  it("exactly one node runs the gate step", () => {
    const gateNodes = STEP_NODES.filter((name) => / gate /.test(nodeByName(name).parameters.command as string));
    assert.deepEqual(gateNodes, ["Deterministic Release Gate"]);
  });

  it("defines no gate rules or decision constants of its own", () => {
    for (const token of [
      "GATE-1", "GATE-2", "GATE-3", "GATE-4", "GATE-5",
      "NO_GO", "CONDITIONAL", "FAIL_SAFE",
      "releaseGateRules", "securityFailureRule", "insufficientCoverageRule", "criticalAcceptanceCriteriaRule",
      "evaluateReleaseGate(",
    ]) {
      assert.ok(!RAW.includes(token), `workflow must not contain "${token}"`);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("pipelineCli.ts — orchestration only, no duplicated decision logic", () => {
  const SRC = readFileSync(fileURLToPath(new URL("../src/pipelineCli.ts", import.meta.url)), "utf8");

  it("delegates to the Phase 3 gate rather than re-implementing it", () => {
    assert.match(SRC, /import\s*\{[^}]*\bevaluateReleaseGate\b[^}]*\}\s*from\s*"\.\/releaseGate\.ts"/);
    assert.match(SRC, /evaluateReleaseGate\(/);
  });

  it("names no gate rule identifiers or decision string literals", () => {
    for (const token of ["GATE-1", "GATE-2", "GATE-3", "GATE-4", "GATE-5", '"NO_GO"', '"CONDITIONAL"', '"GO"']) {
      assert.ok(!SRC.includes(token), `pipelineCli.ts must not contain ${token}`);
    }
  });

  it("does not re-declare the deterministic predicates", () => {
    for (const token of ["function securityFailure", "function insufficientCoverage", "function changeRiskLevel", "function criticalAcceptanceCriteria"]) {
      assert.ok(!SRC.includes(token), `pipelineCli.ts must not re-declare ${token}`);
    }
  });
});
