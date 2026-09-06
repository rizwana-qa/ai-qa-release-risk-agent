/**
 * Production wiring for the Gemini reasoning layer.
 *
 * Provides an {@link AnalyzeFn} backed by a real Gemini model. Unlike the
 * Claude implementation this replaces, it does not re-fetch data through a
 * live MCP tool-use loop — it sends the datasets already present on the
 * {@link AgentContext} directly, in a single turn. That works identically
 * whether the context came from the fixed REQ-BEN-001 fixture or from a
 * user's own custom-submitted evidence, because both populate
 * `AgentContext.datasets` the same way before calling `analyze()` (see
 * `stepAnalyze()` in `pipelineCli.ts`) — there is nothing left to fetch, so
 * a tool-calling loop would only add complexity without adding capability.
 *
 * This module performs I/O and needs `GEMINI_API_KEY`; it is never imported
 * by the test suite. The deterministic pipeline and the release gate live
 * elsewhere and are unaffected by anything here.
 */

import { pathToFileURL } from "node:url";

import { GoogleGenAI } from "@google/genai";

import { AGENT_SYSTEM_PROMPT, type AnalyzeFn, type AgentContext } from "./agentContract.ts";
import { runReleaseAssessment } from "./releaseAssessment.ts";

const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";

/**
 * Bound on how long a single live Gemini call may run. Without this, a
 * hung or slow response would block the "analyze" pipeline step (and the
 * child process that runs it) indefinitely instead of failing safe. See
 * `raceWithTimeout()` below for how this bound is enforced independent of
 * whether the underlying client itself honours an abort signal.
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 20_000;

/** The user-turn prompt sent to Gemini. Pure and independently testable. */
export function buildGeminiPrompt(context: AgentContext): string {
  return [
    "Analyse the change using ONLY the data below — it has already been retrieved",
    "from the four tools named in the system prompt, so there is nothing further to fetch.",
    "Reply with ONLY the JSON findings object described in the system prompt: no prose,",
    "no markdown code fences, no commentary before or after the JSON.",
    "",
    "DATA:",
    JSON.stringify(context.datasets, null, 2),
  ].join("\n");
}

/** Minimal shape this module reads off a Gemini response, kept narrow for easy testing. */
export interface GeminiResponseLike {
  text?: string;
  candidates?: Array<{ finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
}

/**
 * Turn a raw Gemini response into parsed JSON, or throw. Pure and
 * independently testable — never guesses or fills in defaults; a response
 * that isn't clean, complete JSON is a problem the caller must fail safe on.
 */
export function parseGeminiResponse(response: GeminiResponseLike): unknown {
  if (response.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the prompt (${response.promptFeedback.blockReason}).`);
  }
  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    throw new Error(`Gemini did not finish normally (finishReason: ${finishReason}).`);
  }
  const text = response.text;
  if (!text || !text.trim()) {
    throw new Error("Gemini returned an empty response.");
  }
  return JSON.parse(text) as unknown;
}

/**
 * Wrap `promise` so it always settles within `timeoutMs`, aborting `controller`
 * when the bound is hit. This is enforced by our own timer — not merely by
 * passing a timeout/abortSignal into the SDK call — so the bound holds even
 * if the underlying client (real or, in tests, a fake) never itself reacts
 * to the abort signal.
 */
function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Gemini call exceeded the ${timeoutMs}ms timeout.`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Build an {@link AnalyzeFn} that sends `AgentContext.datasets` to Gemini in
 * a single turn and returns its parsed JSON findings verbatim (unvalidated —
 * `validateAgentFindings()` and the adapter's grounding checks, downstream,
 * are what may reject it and trigger the rules-based fallback).
 *
 * The call is bounded to `timeoutMs` (default `GEMINI_TIMEOUT_MS` env var, or
 * 20s): a hung or slow response rejects with a clear error instead of
 * blocking forever, so the existing catch-and-record-failure path in
 * `stepAnalyze()` (pipelineCli.ts) engages promptly and the pipeline fails
 * safe rather than hanging.
 */
export function createGeminiAnalyzeFn(
  opts: { model?: string; client?: GoogleGenAI; timeoutMs?: number } = {},
): AnalyzeFn {
  const model = opts.model ?? DEFAULT_MODEL;
  const client = opts.client ?? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (context: AgentContext): Promise<unknown> => {
    const controller = new AbortController();
    const response = await raceWithTimeout(
      client.models.generateContent({
        model,
        contents: buildGeminiPrompt(context),
        config: {
          systemInstruction: AGENT_SYSTEM_PROMPT,
          responseMimeType: "application/json",
          abortSignal: controller.signal,
          httpOptions: { timeout: timeoutMs },
        },
      }),
      timeoutMs,
      controller,
    );
    return parseGeminiResponse(response);
  };
}

/** CLI entry: run the full assessment and print it. */
export async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.error(
      "[geminiAgent] No GEMINI_API_KEY found.\n" +
        "Set it to run the live Gemini assessment. The deterministic pipeline and\n" +
        "gate are covered by `npm test` and do not require an API key.",
    );
    process.exit(1);
  }

  const assessment = await runReleaseAssessment({ analyze: createGeminiAnalyzeFn() });

  console.log("\n=== Release Assessment ===");
  console.log(`Decision : ${assessment.decision}  (rule: ${assessment.firedRule})`);
  console.log("Reasons  :");
  for (const r of assessment.reasons) console.log(`  - ${r}`);
  console.log("\nAgent QA risk explanation:");
  console.log(assessment.agentExplanation ?? "(none — pipeline failed safe before the agent produced valid output)");
  console.log("\nPipeline :");
  for (const step of assessment.pipeline) {
    console.log(`  ${step.ok ? "ok " : "FAIL"} ${step.step}${step.detail ? ` — ${step.detail}` : ""}`);
  }
  console.log("\nNote: the decision above is produced solely by evaluateReleaseGate(), not by Gemini.");
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error("[geminiAgent] fatal:", err);
    process.exit(1);
  });
}
