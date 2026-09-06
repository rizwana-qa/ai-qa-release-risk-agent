/**
 * DEF-01 regression: `runStep()`'s bounded wait on a pipelineCli.ts step's
 * child process (api/pipelineRunner.ts). This is the backstop for the
 * primary fix in `src/geminiAgent.ts` (see tests/geminiAgent.test.ts) — it
 * must guarantee `runStep()` never waits past its configured timeout and
 * must never coerce a killed/timed-out step into a false "success" (the
 * pre-fix `code ?? 0` would have turned a null exit code, from a killed
 * process, into 0).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync, readFileSync } from "node:fs";

import { runStep, STEP_TIMEOUT_MS } from "../api/pipelineRunner.ts";

const RUN_DIR = mkdtempSync(join(tmpdir(), "pipeline-runner-timeout-"));
let counter = 0;
const stateFile = () => join(RUN_DIR, `state-${counter++}.json`);

after(() => rmSync(RUN_DIR, { recursive: true, force: true }));

describe("runStep() — bounded child-process wait (DEF-01 regression)", () => {
  it("exports a positive default STEP_TIMEOUT_MS", () => {
    assert.ok(STEP_TIMEOUT_MS > 0);
  });

  it("a normal, fast step completes well under its timeout and reports success (code 0)", async () => {
    const file = stateFile();
    const started = Date.now();
    const code = await runStep("fetch-data", file, { ...process.env }, STEP_TIMEOUT_MS);
    const elapsed = Date.now() - started;

    assert.equal(code, 0);
    assert.ok(elapsed < STEP_TIMEOUT_MS, `expected a fast step to finish well under ${STEP_TIMEOUT_MS}ms, took ${elapsed}ms`);
    const state = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(state.trace.at(-1)?.step, "retrieve-qa-data-mcp");
    assert.equal(state.trace.at(-1)?.ok, true);
  });

  it("a step given an impossibly short timeout is killed, resolves promptly, and reports failure (code 1, never silently 0)", async () => {
    const file = stateFile();
    const started = Date.now();
    // 1ms is shorter than any real Node child process can start, import its
    // modules, and run in — this deterministically forces the kill-on-timeout
    // path without depending on a real hang anywhere (e.g. a slow network call).
    const code = await runStep("fetch-data", file, { ...process.env }, 1);
    const elapsed = Date.now() - started;

    assert.equal(code, 1, "a killed step must resolve with a failure code, not the pre-fix code ?? 0 coercion to success");
    // Bounded well below STEP_TIMEOUT_MS — proves the wait is governed by the
    // configured timeout, not by however long the (killed) child would have taken.
    assert.ok(elapsed < 2_000, `expected the kill to resolve promptly, took ${elapsed}ms`);
  });

  it("does not hang the test process even when the killed step never gets to write its state file", async () => {
    // A step killed at 1ms almost certainly never reaches writeState(); confirm
    // this doesn't throw or hang — runStep()'s promise still settles cleanly.
    const file = stateFile();
    await assert.doesNotReject(() => runStep("fetch-data", file, { ...process.env }, 1));
  });
});
