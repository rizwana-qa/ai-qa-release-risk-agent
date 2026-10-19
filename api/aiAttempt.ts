/**
 * Whether a live AI request was attempted before an assessment fell back to the offline analysis.
 *
 * Reporting only. It is computed AFTER the pipeline has run, from facts the pipeline recorded, and it is never an
 * input to validation, the adapter or the release gate: the deterministic gate stays the only authority for the
 * decision. It holds booleans and fixed values only: no prompt, evidence, credential or provider error text.
 */

import { readFileSync } from "node:fs";

export type AiAttemptOutcome = "not-attempted" | "accepted" | "failed" | "rejected";

export interface AiAttempt {
  /** A Gemini key was configured for this deployment. Configuration only: it says nothing about any request. */
  enabled: boolean;
  /**
   * The provider call was initiated (recorded immediately before the request starts, after the routing guard and
   * the key check have passed). It does not mean the provider received or processed anything. It is false when
   * Gemini is disabled and when a guard or missing configuration refused before any request began.
   */
  began: boolean;
  /**
   * "not-attempted": no request began. "accepted": a request began and its findings passed validation and the
   * adapter. "failed": a request began but gave no usable response (provider error, timeout, blocked, truncated,
   * empty or unparseable reply). "rejected": a reply was parsed but failed validation or the adapter's grounding.
   */
  outcome: AiAttemptOutcome;
  /** True only when the offline rules-based analysis actually supplied the findings the report is built from. */
  fallbackUsed: boolean;
}

export interface AiAttemptFacts {
  enabled: boolean;
  /** From the pipeline state (`providerAttempt.began`), never from configuration. */
  began: boolean;
  /** The live analyze, validate and adapt batch all succeeded. */
  liveBatchOk: boolean;
  /** The `ai-reasoning` step result of the live batch: true, false, or undefined if it left no entry. */
  aiReasoningOk: boolean | undefined;
  /** The offline fallback ran AND its batch succeeded. */
  fallbackSupplied: boolean;
}

export function buildAiAttempt(f: AiAttemptFacts): AiAttempt {
  if (!f.enabled) return { enabled: false, began: false, outcome: "not-attempted", fallbackUsed: false };
  if (!f.began) return { enabled: true, began: false, outcome: "not-attempted", fallbackUsed: f.fallbackSupplied };
  if (f.liveBatchOk) return { enabled: true, began: true, outcome: "accepted", fallbackUsed: false };
  return { enabled: true, began: true, outcome: f.aiReasoningOk === true ? "rejected" : "failed", fallbackUsed: f.fallbackSupplied };
}

/** Whether a pipeline state object (parsed JSON) records that a provider request began. */
export function attemptBegan(state: unknown): boolean {
  return (state as { providerAttempt?: { began?: unknown } } | null | undefined)?.providerAttempt?.began === true;
}

/** Same, read from a state file; false if the file is missing or unreadable. */
export function stateFileAttemptBegan(stateFile: string): boolean {
  try {
    return attemptBegan(JSON.parse(readFileSync(stateFile, "utf8")));
  } catch {
    return false;
  }
}
