/**
 * Data-handling safeguards (Stage 2 remediation): provider-routing guard that fails closed, sanitised
 * provider errors, and dataset wording that makes no claim about the user's evidence.
 *
 * Offline only. The routing tests rely on the guard rejecting BEFORE any client exists, and on no
 * GEMINI_API_KEY being set, so no request can be made. No Gemini call is made or possible here.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";

import { createGeminiAnalyzeFn, assertDeveloperApiRouting, ROUTING_ENV_VARS } from "../src/geminiAgent.ts";
import { sanitizeProviderError } from "../src/providerError.ts";
import { runPipeline } from "../src/pipelineCli.ts";
import { runReleaseAssessment } from "../src/releaseAssessment.ts";
import { normalizeAssessmentInput } from "../api/inputNormalizer.ts";
import { buildPolicy } from "../api/policy.ts";
import type { AgentContext, AnalyzeFn } from "../src/agentContract.ts";
import type { DatasetName } from "../src/dataLoader.ts";
import { loadDataset } from "../src/dataLoader.ts";
import { realDatasetLoader } from "./agentFixtures.ts";
import { thinPayload, thinTest } from "./customFixtures.ts";

const RUN_DIR = mkdtempSync(join(tmpdir(), "data-handling-"));
let n = 0;
const stateFile = () => join(RUN_DIR, `state-${n++}.json`);
after(() => rmSync(RUN_DIR, { recursive: true, force: true }));

const FAKE_KEY = "AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKE12345";
const fetchReal = async () => {
  const load = realDatasetLoader();
  const g = (name: DatasetName) => load(name);
  return { requirement: g("requirement"), existingTests: g("existing-tests"), knownDefects: g("known-defects"), riskRules: g("risk-rules") };
};
const context = (): AgentContext => ({
  systemPrompt: "s", analysisSteps: [], toolNames: [],
  datasets: { requirement: loadDataset("requirement"), existingTests: loadDataset("existing-tests"), knownDefects: loadDataset("known-defects"), riskRules: loadDataset("risk-rules") },
});

/** Run `fn` with environment variables set, restoring them afterwards (also on failure). */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of before) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

describe("provider routing guard (fails closed)", () => {
  it("accepts an environment with none of the routing variables", () => {
    assert.doesNotThrow(() => assertDeveloperApiRouting({ GEMINI_API_KEY: "x", PATH: "/bin" }));
  });

  it("names every variable the installed SDK can use to change product or endpoint", () => {
    assert.deepEqual([...ROUTING_ENV_VARS].sort(), [
      "GEMINI_NEXT_GEN_API_BASE_URL", "GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_PROJECT", "GOOGLE_GEMINI_BASE_URL",
      "GOOGLE_GENAI_USE_ENTERPRISE", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_VERTEX_BASE_URL",
    ]);
  });

  for (const name of ROUTING_ENV_VARS) {
    it(`refuses when ${name} is set, naming the variable but never its value`, () => {
      const secretLooking = "https://user:pa55w0rd-value@proxy.example/v1";
      assert.throws(
        () => assertDeveloperApiRouting({ [name]: secretLooking }),
        (err: Error) => err.message.includes(name) && !err.message.includes("pa55w0rd") && !err.message.includes("proxy.example") && /not attempted/.test(err.message),
      );
    });
  }

  it("ignores empty or whitespace-only values (the SDK treats them as unset)", () => {
    assert.doesNotThrow(() => assertDeveloperApiRouting({ GOOGLE_GENAI_USE_VERTEXAI: "  ", GOOGLE_CLOUD_PROJECT: "" }));
  });

  it("lists every offending variable at once", () => {
    assert.throws(() => assertDeveloperApiRouting({ GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "p" }), /GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_CLOUD_PROJECT/);
  });

  it("createGeminiAnalyzeFn rejects before creating any client when routing is redirected", async () => {
    await withEnv({ GEMINI_API_KEY: undefined, GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:9" }, async () => {
      await assert.rejects(createGeminiAnalyzeFn()(context()), /GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GEMINI_BASE_URL/);
    });
  });

  it("does not fall back to another credential variable when GEMINI_API_KEY is missing", async () => {
    await withEnv({ GEMINI_API_KEY: undefined, GOOGLE_API_KEY: "some-other-credential-value" }, async () => {
      await assert.rejects(createGeminiAnalyzeFn()(context()), (err: Error) => /GEMINI_API_KEY is not set/.test(err.message) && !err.message.includes("some-other-credential-value"));
    });
  });

  it("an injected client (tests) is used as is and is not subject to the environment check", async () => {
    let called = false;
    const client: any = { models: { generateContent: async () => { called = true; return { text: "{}", candidates: [{ finishReason: "STOP" }] }; } } };
    await withEnv({ GOOGLE_GENAI_USE_VERTEXAI: "true" }, async () => { await createGeminiAnalyzeFn({ client })(context()); });
    assert.equal(called, true);
  });

  it("invalid routing leaves the deterministic decision to the gate: the fixture fails safe to NO_GO / FAIL_SAFE", async () => {
    await withEnv({ GEMINI_API_KEY: undefined, GOOGLE_GENAI_USE_VERTEXAI: "SENTINEL-VALUE-NOT-TO-APPEAR" }, async () => {
      const report = await runPipeline({ stateFile: stateFile(), fetchDatasets: fetchReal, analyze: createGeminiAnalyzeFn() });
      assert.equal(report.releaseDecision, "NO_GO");
      assert.equal(report.firedRule, "FAIL_SAFE");
      const detail = report.pipelineTrace.find((t) => t.step === "ai-reasoning")!.detail!;
      assert.match(detail, /GOOGLE_GENAI_USE_VERTEXAI/);
      assert.doesNotMatch(JSON.stringify(report), /SENTINEL-VALUE-NOT-TO-APPEAR/);
    });
  });
});

describe("sanitised provider errors", () => {
  it("redacts API keys, bearer tokens and authorization headers", () => {
    const raw = `request failed: key=${FAKE_KEY} Authorization: Bearer ya29.A0AfH6SMBxxxxxxxxxxxxxxxx x-goog-api-key: ${FAKE_KEY}`;
    const text = sanitizeProviderError(new Error(raw));
    assert.doesNotMatch(text, /AIza|ya29|Bearer ya29|FAKEFAKE/);
    assert.match(text, /\[redacted\]/);
  });

  it("redacts the exact value of the configured key, even if it has no recognisable shape", () => {
    const text = sanitizeProviderError(new Error("bad credential custom-key-value-0001 rejected"), { GEMINI_API_KEY: "custom-key-value-0001" });
    assert.doesNotMatch(text, /custom-key-value-0001/);
  });

  it("drops query strings from URLs", () => {
    const text = sanitizeProviderError(new Error("GET https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=abc123def456&alt=sse failed"));
    assert.doesNotMatch(text, /abc123|key=|alt=sse/);
    assert.match(text, /generativelanguage\.googleapis\.com/);
  });

  it("keeps the status and short message of a JSON error body and drops the diagnostic details", () => {
    const body = JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key.", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", metadata: { request: "full request content here" } }] } });
    const text = sanitizeProviderError(new Error(`got status: 400. ${body}`));
    assert.match(text, /HTTP 400 INVALID_ARGUMENT: API key not valid/);
    assert.doesNotMatch(text, /ErrorInfo|full request content|details/);
  });

  it("adds the HTTP status when the error carries one", () => {
    const err = Object.assign(new Error("quota exceeded"), { status: 429 });
    assert.equal(sanitizeProviderError(err), "HTTP 429: quota exceeded");
  });

  it("keeps useful non-sensitive diagnostics such as timeouts and blocked responses", () => {
    assert.equal(sanitizeProviderError(new Error("Gemini call exceeded the 20000ms timeout.")), "Gemini call exceeded the 20000ms timeout.");
    assert.equal(sanitizeProviderError(new Error("Gemini blocked the prompt (SAFETY).")), "Gemini blocked the prompt (SAFETY).");
  });

  it("bounds the length, handles non-Error values, and never returns an empty string", () => {
    assert.ok(sanitizeProviderError(new Error("x".repeat(5000))).length <= 200);
    assert.equal(sanitizeProviderError(undefined), "Provider request failed.");
    assert.equal(sanitizeProviderError("plain text"), "plain text");
    assert.equal(sanitizeProviderError(new Error("   ")), "Provider request failed.");
  });

  it("the pipeline trace, and so the report and PDF data, carry the sanitised text only", async () => {
    const analyze: AnalyzeFn = async () => { throw new Error(`403 PERMISSION_DENIED key=${FAKE_KEY} Authorization: Bearer ${FAKE_KEY}`); };
    const report = await runPipeline({ stateFile: stateFile(), fetchDatasets: fetchReal, analyze });
    assert.doesNotMatch(JSON.stringify(report), /AIza|FAKEFAKE/);
    assert.match(report.pipelineTrace.find((t) => t.step === "ai-reasoning")!.detail!, /\[redacted\]/);
    assert.equal(report.releaseDecision, "NO_GO"); // still the gate's fail-safe, whatever the provider said
    assert.equal(report.firedRule, "FAIL_SAFE");
  });

  it("the in-process pipeline also sanitises the error in its trace and in the fail-safe reasons", async () => {
    const result: any = await runReleaseAssessment({ analyze: async () => { throw new Error(`boom key=${FAKE_KEY}`); }, loadDataset: realDatasetLoader() });
    assert.doesNotMatch(JSON.stringify(result), /AIza|FAKEFAKE/);
    assert.equal(result.decision, "NO_GO");
  });
});

describe("dataset wording makes no claim about the user's evidence", () => {
  const norm = () => {
    const r = normalizeAssessmentInput(thinPayload({ testCases: [thinTest("Passed", ["AC1"])] }) as any);
    if (!r.ok) throw new Error("did not normalise");
    return r.datasets as any;
  };

  it("does not call submitted evidence synthetic, non-production or anonymised", () => {
    const d = norm();
    const text = JSON.stringify(d);
    assert.doesNotMatch(text, /Not real production data/i);
    for (const name of ["requirement", "existingTests", "knownDefects", "riskRules"]) {
      assert.equal("synthetic" in d[name], false, `${name} must not carry a synthetic flag`);
    }
    assert.match(d.requirement.disclaimer, /does not check whether it is synthetic, anonymised or real/);
  });

  it("the generated policy document carries no synthetic flag either", () => {
    assert.equal("synthetic" in (buildPolicy(["orders"], "x") as object), false);
  });

  it("the bundled REQ-BEN-001 fixture is still labelled synthetic (it is)", () => {
    assert.equal((loadDataset("requirement") as any).synthetic, true);
  });
});
