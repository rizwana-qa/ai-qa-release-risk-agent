/**
 * Hardening of the Gemini analysis layer: prompt, provider response schema, and how invalid,
 * blocked, truncated or failed responses are handled. Recorded/fake responses only: no network
 * call and no API key are used or needed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildGeminiPrompt, createGeminiAnalyzeFn, AGENT_RESPONSE_SCHEMA } from "../src/geminiAgent.ts";
import { AGENT_SYSTEM_PROMPT, FINDING_SEVERITIES, PRIORITY_LEVELS, FORBIDDEN_OUTPUT_KEYS, type AgentContext } from "../src/agentContract.ts";
import { validateAgentFindings } from "../src/agentOutputValidation.ts";
import { cloneValidAgentFindings } from "./agentFixtures.ts";

function nonBankingContext(): AgentContext {
  return {
    systemPrompt: AGENT_SYSTEM_PROMPT,
    analysisSteps: [],
    toolNames: [],
    datasets: {
      requirement: { requirement: { requirementId: "REQ-USR-ab12", title: "Export report to CSV", acceptanceCriteria: [{ id: "AC1", area: "reporting", text: "A user can export the report to CSV." }] } },
      existingTests: { tests: [{ testId: "T1", status: "active", covers: ["AC1"] }] },
      knownDefects: { defects: [] },
      riskRules: { scenario: "REQ-USR-ab12" },
    },
  };
}

describe("system prompt and user prompt (non-banking release)", () => {
  it("is not tied to the banking scenario and names no tools the model does not have", () => {
    assert.doesNotMatch(AGENT_SYSTEM_PROMPT, /banking|beneficiary|transfer money/i);
    assert.doesNotMatch(AGENT_SYSTEM_PROMPT, /MCP|get_requirement|get_existing_tests|get_known_defects|get_risk_rules/);
    assert.match(AGENT_SYSTEM_PROMPT, /you have no tools/);
  });

  it("separates facts from inference and requires insufficient evidence to be stated, not invented", () => {
    assert.match(AGENT_SYSTEM_PROMPT, /FACT is something DATA states/);
    assert.match(AGENT_SYSTEM_PROMPT, /Begin any inferred statement with "Inference:"/);
    assert.match(AGENT_SYSTEM_PROMPT, /"Insufficient evidence:"/);
    assert.match(AGENT_SYSTEM_PROMPT, /Never invent tests, defects, results/);
    assert.match(AGENT_SYSTEM_PROMPT, /covered to true ONLY when DATA shows at least one passing/);
  });

  it("says the model gives analysis only: the rules engine decides and people keep the final decision", () => {
    assert.match(AGENT_SYSTEM_PROMPT, /never make the release decision/);
    assert.match(AGENT_SYSTEM_PROMPT, /people keep the/);
    assert.match(AGENT_SYSTEM_PROMPT, /Do NOT include any decision, recommendation, verdict, or gate outcome/);
  });

  it("builds the user prompt from the supplied release evidence, with no banking wording", () => {
    const prompt = buildGeminiPrompt(nonBankingContext());
    assert.match(prompt, /Export report to CSV/);
    assert.match(prompt, /REQ-USR-ab12/);
    assert.doesNotMatch(prompt, /banking|beneficiary|MCP|four tools/i);
    assert.match(prompt, /ONLY the JSON findings object/);
  });
});

describe("provider response schema", () => {
  const schema: any = AGENT_RESPONSE_SCHEMA;

  it("is sent with the request, alongside the JSON mime type and the system instruction", async () => {
    let args: any = null;
    const client: any = { models: { generateContent: async (a: any) => { args = a; return { text: JSON.stringify(cloneValidAgentFindings()), candidates: [{ finishReason: "STOP" }] }; } } };
    await createGeminiAnalyzeFn({ client })(nonBankingContext());
    assert.equal(args.config.responseSchema, AGENT_RESPONSE_SCHEMA);
    assert.equal(args.config.responseMimeType, "application/json");
    assert.equal(args.config.systemInstruction, AGENT_SYSTEM_PROMPT);
  });

  it("mirrors the output contract: every key of a valid findings object is in the schema and required", () => {
    const a = cloneValidAgentFindings();
    const top = Object.keys(a).sort();
    assert.deepEqual(Object.keys(schema.properties).sort(), top);
    assert.deepEqual([...schema.required].sort(), top);
    const entry = (name: string, sample: object) => {
      const s = schema.properties[name].items;
      assert.deepEqual(Object.keys(s.properties).sort(), Object.keys(sample).sort(), name);
      assert.deepEqual([...s.required].sort(), Object.keys(sample).sort(), name);
    };
    entry("identifiedRisks", a.identifiedRisks[0]!);
    entry("coverageAssessment", a.coverageAssessment[0]!);
    entry("defectReview", a.defectReview[0]!);
    entry("regressionPriorities", a.regressionPriorities[0]!);
    assert.deepEqual(Object.keys(schema.properties.dataProvenance.properties).sort(), Object.keys(a.dataProvenance).sort());
  });

  it("uses the same enums as the validator and has no field that could carry a decision", () => {
    assert.deepEqual(schema.properties.identifiedRisks.items.properties.severity.enum, [...FINDING_SEVERITIES]);
    assert.deepEqual(schema.properties.regressionPriorities.items.properties.priority.enum, [...PRIORITY_LEVELS]);
    for (const key of FORBIDDEN_OUTPUT_KEYS) assert.equal(key in schema.properties, false, key);
  });

  it("does not replace server-side validation: malformed or decision-bearing output is still rejected", () => {
    assert.equal(validateAgentFindings({ ...cloneValidAgentFindings(), identifiedRisks: "none" }).ok, false);
    const missing: any = cloneValidAgentFindings();
    delete missing.dataProvenance;
    assert.equal(validateAgentFindings(missing).ok, false);
    assert.equal(validateAgentFindings({ ...cloneValidAgentFindings(), decision: "GO" }).ok, false);
  });
});

describe("invalid, blocked, truncated and failed provider responses all throw (the pipeline then fails safe)", () => {
  const analyzeWith = (response: unknown) =>
    createGeminiAnalyzeFn({ client: { models: { generateContent: async () => response } } as any })(nonBankingContext());

  it("rejects invalid JSON", async () => {
    await assert.rejects(analyzeWith({ text: "{ not json", candidates: [{ finishReason: "STOP" }] }));
  });
  it("rejects a response truncated by the token limit", async () => {
    await assert.rejects(analyzeWith({ text: '{"schemaVersion":1', candidates: [{ finishReason: "MAX_TOKENS" }] }), /did not finish normally.*MAX_TOKENS/);
  });
  it("rejects a blocked prompt", async () => {
    await assert.rejects(analyzeWith({ promptFeedback: { blockReason: "SAFETY" } }), /blocked the prompt/);
  });
  it("rejects an empty response", async () => {
    await assert.rejects(analyzeWith({ text: "  ", candidates: [{ finishReason: "STOP" }] }), /empty response/);
  });
  it("propagates a provider error unchanged", async () => {
    const client: any = { models: { generateContent: async () => { throw new Error("503 unavailable"); } } };
    await assert.rejects(createGeminiAnalyzeFn({ client })(nonBankingContext()), /503 unavailable/);
  });
  it("returns schema-invalid output as parsed; the validator, not a silent repair, rejects it", async () => {
    const bad = { ...cloneValidAgentFindings(), changeSummary: "" };
    const parsed = await analyzeWith({ text: JSON.stringify(bad), candidates: [{ finishReason: "STOP" }] });
    assert.deepEqual(parsed, bad);
    assert.equal(validateAgentFindings(parsed).ok, false);
  });
});
