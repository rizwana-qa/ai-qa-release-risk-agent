/**
 * Unit tests for `src/geminiAgent.ts`'s pure, offline-testable pieces.
 *
 * `createGeminiAnalyzeFn()` itself needs a live `GEMINI_API_KEY` and is never
 * imported by the rest of the test suite (same rule the old `claudeAgent.ts`
 * followed) — but unlike that module, the prompt-building and
 * response-parsing logic here is pure, so it's covered directly, including
 * via a fake `GoogleGenAI`-shaped client that never makes a network call.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildGeminiPrompt,
  parseGeminiResponse,
  createGeminiAnalyzeFn,
  type GeminiResponseLike,
} from "../src/geminiAgent.ts";
import type { AgentContext } from "../src/agentContract.ts";

function sampleContext(): AgentContext {
  return {
    systemPrompt: "system prompt text",
    analysisSteps: ["Understand the change"],
    toolNames: ["get_requirement"],
    datasets: {
      requirement: { requirement: { requirementId: "REQ-BEN-001" } },
      existingTests: { tests: [] },
      knownDefects: { defects: [] },
      riskRules: { scenario: "REQ-BEN-001" },
    },
  };
}

describe("buildGeminiPrompt", () => {
  it("embeds the datasets verbatim as JSON", () => {
    const prompt = buildGeminiPrompt(sampleContext());
    assert.match(prompt, /REQ-BEN-001/);
    assert.match(prompt, /"scenario": "REQ-BEN-001"/);
  });

  it("instructs a JSON-only reply with no markdown fences", () => {
    const prompt = buildGeminiPrompt(sampleContext());
    assert.match(prompt, /ONLY the JSON findings object/);
    assert.match(prompt, /no markdown code fences/);
  });
});

describe("parseGeminiResponse", () => {
  it("parses a clean JSON text response", () => {
    const response: GeminiResponseLike = {
      text: JSON.stringify({ schemaVersion: 1 }),
      candidates: [{ finishReason: "STOP" }],
    };
    assert.deepEqual(parseGeminiResponse(response), { schemaVersion: 1 });
  });

  it("throws when the prompt itself was blocked", () => {
    const response: GeminiResponseLike = { promptFeedback: { blockReason: "SAFETY" } };
    assert.throws(() => parseGeminiResponse(response), /blocked the prompt.*SAFETY/);
  });

  it("throws when the candidate did not finish normally", () => {
    const response: GeminiResponseLike = { text: "{}", candidates: [{ finishReason: "MAX_TOKENS" }] };
    assert.throws(() => parseGeminiResponse(response), /did not finish normally.*MAX_TOKENS/);
  });

  it("throws on an empty response", () => {
    assert.throws(() => parseGeminiResponse({ text: "" }), /empty response/);
    assert.throws(() => parseGeminiResponse({}), /empty response/);
  });

  it("throws (does not silently ignore) invalid JSON text", () => {
    assert.throws(() => parseGeminiResponse({ text: "not json" }));
  });

  it("never fills in defaults for a malformed response — it's the caller's job to fail safe", () => {
    // finishReason "SAFETY" with text present must still throw, not fall through to the text.
    const response: GeminiResponseLike = { text: JSON.stringify({ ok: true }), candidates: [{ finishReason: "SAFETY" }] };
    assert.throws(() => parseGeminiResponse(response));
  });
});

describe("createGeminiAnalyzeFn — wiring, with a fake client (no network call)", () => {
  it("sends systemInstruction + JSON response config, and returns the parsed findings", async () => {
    let capturedArgs: any = null;
    const fakeClient: any = {
      models: {
        generateContent: async (args: any) => {
          capturedArgs = args;
          return { text: JSON.stringify({ schemaVersion: 1, changeSummary: "ok" }), candidates: [{ finishReason: "STOP" }] };
        },
      },
    };

    const analyze = createGeminiAnalyzeFn({ model: "gemini-3.6-flash", client: fakeClient });
    const result = await analyze(sampleContext());

    assert.deepEqual(result, { schemaVersion: 1, changeSummary: "ok" });
    assert.equal(capturedArgs.model, "gemini-3.6-flash");
    assert.equal(capturedArgs.config.responseMimeType, "application/json");
    assert.match(capturedArgs.config.systemInstruction, /QA risk analyst/);
    assert.match(capturedArgs.contents, /REQ-BEN-001/);
  });

  it("propagates a parse failure as a thrown error (so the pipeline fails safe)", async () => {
    const fakeClient: any = {
      models: { generateContent: async () => ({ text: "", candidates: [{ finishReason: "STOP" }] }) },
    };
    const analyze = createGeminiAnalyzeFn({ client: fakeClient });
    await assert.rejects(() => analyze(sampleContext()), /empty response/);
  });
});

describe("createGeminiAnalyzeFn — bounded timeout (DEF-01 regression)", () => {
  // Scenario A: responds comfortably before the timeout — normal success path unchanged.
  it("A. resolves normally when the client responds before the timeout", async () => {
    const fakeClient: any = {
      models: {
        generateContent: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return { text: JSON.stringify({ schemaVersion: 1, ok: "fast" }), candidates: [{ finishReason: "STOP" }] };
        },
      },
    };
    const analyze = createGeminiAnalyzeFn({ client: fakeClient, timeoutMs: 200 });
    const result = await analyze(sampleContext());
    assert.deepEqual(result, { schemaVersion: 1, ok: "fast" });
  });

  // Scenario B: the client eventually responds, but only after the configured timeout.
  it("B. rejects at the timeout boundary when the client responds too slowly, without waiting for it", async () => {
    let sawAbort = false;
    const fakeClient: any = {
      models: {
        generateContent: async (args: any) => {
          args.config.abortSignal?.addEventListener("abort", () => {
            sawAbort = true;
          });
          await new Promise((r) => setTimeout(r, 500)); // far longer than the 50ms timeout below
          return { text: JSON.stringify({ schemaVersion: 1 }), candidates: [{ finishReason: "STOP" }] };
        },
      },
    };
    const analyze = createGeminiAnalyzeFn({ client: fakeClient, timeoutMs: 50 });

    const started = Date.now();
    await assert.rejects(() => analyze(sampleContext()), /exceeded the 50ms timeout/);
    const elapsed = Date.now() - started;

    // Must reject at ~50ms, not wait out the fake client's 500ms delay.
    assert.ok(elapsed < 300, `expected a bounded rejection well under 500ms, took ${elapsed}ms`);
    assert.ok(sawAbort, "expected the request's AbortSignal to be aborted on timeout");
  });

  // Scenario C: the client hangs indefinitely (never resolves or rejects).
  it("C. rejects at the timeout boundary when the client hangs indefinitely", async () => {
    const fakeClient: any = {
      models: {
        generateContent: () => new Promise(() => {}), // never settles
      },
    };
    const analyze = createGeminiAnalyzeFn({ client: fakeClient, timeoutMs: 50 });

    const started = Date.now();
    await assert.rejects(() => analyze(sampleContext()), /exceeded the 50ms timeout/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `expected the hang to be bounded to ~50ms, took ${elapsed}ms`);
  });

  // Scenario D: the client errors out quickly, before the timeout — error handling untouched.
  it("D. propagates a fast client-side error unchanged, well before the timeout", async () => {
    const fakeClient: any = {
      models: {
        generateContent: async () => {
          throw new Error("model unavailable (simulated)");
        },
      },
    };
    const analyze = createGeminiAnalyzeFn({ client: fakeClient, timeoutMs: 5_000 });

    const started = Date.now();
    await assert.rejects(() => analyze(sampleContext()), /model unavailable \(simulated\)/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_000, `expected an immediate rejection, not a wait for the 5s timeout, took ${elapsed}ms`);
  });

  // Scenario E: the client is entirely unavailable (rejects synchronously, e.g. a network/DNS failure).
  it("E. propagates a synchronous 'unavailable' rejection unchanged", async () => {
    const fakeClient: any = {
      models: {
        generateContent: () => Promise.reject(new Error("ENOTFOUND generativelanguage.googleapis.com")),
      },
    };
    const analyze = createGeminiAnalyzeFn({ client: fakeClient, timeoutMs: 5_000 });
    await assert.rejects(() => analyze(sampleContext()), /ENOTFOUND/);
  });

  it("defaults timeoutMs from GEMINI_TIMEOUT_MS / a 20s fallback when not passed explicitly", async () => {
    // Not exercising the real 20s wait — just confirming a fast, well-behaved
    // client under the default timeout still works normally (regression guard
    // against accidentally requiring timeoutMs to be passed explicitly).
    const fakeClient: any = {
      models: {
        generateContent: async () => ({ text: JSON.stringify({ schemaVersion: 1 }), candidates: [{ finishReason: "STOP" }] }),
      },
    };
    const analyze = createGeminiAnalyzeFn({ client: fakeClient });
    const result = await analyze(sampleContext());
    assert.deepEqual(result, { schemaVersion: 1 });
  });
});
