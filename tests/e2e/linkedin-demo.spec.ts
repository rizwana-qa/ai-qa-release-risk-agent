/**
 * LinkedIn Demo: AI QA Release Risk Assessment
 * ===========================================
 *
 * A recorded, human-paced walkthrough of the REAL product workflow:
 *
 *   QA release information -> supporting document -> AI assessment ->
 *   processing (6 real stages) -> risk analysis -> release decision
 *
 * Nothing is mocked, faked, or hardcoded. The assessment runs through the live
 * API and the deterministic gate; this test only reads and displays what the
 * application produces. The validated sample yields CONDITIONAL / GATE-4.
 *
 * The `demo` Playwright project records this run to a silent video
 * (Playwright never captures an audio track) under artifacts/linkedin-demo/.
 *
 *   npm run test:demo            # headless, records the video
 *   npm run test:demo:headed     # watch it run in a real Chromium window
 *   npm run demo:video           # record + report the final video file
 */

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

import {
  PDF_FIXTURE,
  PROCESSING_STAGES,
  REPORT_ACCORDION,
  revealCentered,
  openAccordion,
} from "./support.ts";

/** Deliberate on-screen holds so a viewer can read each state (ms). */
const HOLD = { beat: 800, read: 2800, study: 3800, settle: 4500, finale: 6000 };

const VIDEO_DEST = fileURLToPath(
  new URL("../../artifacts/linkedin-demo/ai-qa-release-risk-demo.webm", import.meta.url),
);

test("LinkedIn Demo: AI QA Release Risk Assessment", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  /* 1 — Open the application ------------------------------------------------ */
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "QA Release Risk Assessment" })).toBeVisible();
  await expect(page.locator('[data-act="analyze"]')).toBeVisible();
  await page.waitForTimeout(HOLD.read);

  /* 2 — Load example release information ---------------------------------- */
  await page.locator('.ws [data-act="load-example"]').click();
  await expect(page.locator('[data-field="releaseScope"]')).toHaveValue(/saved card/i);
  await expect(page.locator('[data-group="ac"]')).toHaveCount(4);

  // Let the viewer see there is real release context + acceptance criteria.
  await revealCentered(page, page.locator('[data-field="userStory"]'));
  await page.waitForTimeout(HOLD.read);
  await revealCentered(page, page.locator('[data-group="ac"]').last());
  await page.waitForTimeout(HOLD.read);

  /* 3 — Attach the supporting document ---------------------------------- */
  await revealCentered(page, page.locator(".dropzone"));
  await page.locator("[data-file-input]").setInputFiles(PDF_FIXTURE);

  const chip = page.locator(".doc-chip", { hasText: "sample-supporting-document.pdf" });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/reference only/i);
  await revealCentered(page, chip, 700);
  await page.waitForTimeout(HOLD.study); // "supporting evidence attached"

  /* 4 — Analyze Release Risk (real workflow, no mocks) ------------------ */
  const analyze = page.locator('[data-act="analyze"]');
  await revealCentered(page, analyze, 700);
  await expect(analyze).toBeEnabled();
  await page.waitForTimeout(HOLD.beat);
  await analyze.click();

  /* 5 — Processing: the six real pipeline stages ---------------------- */
  await expect(page.locator(".stepper")).toBeVisible();
  await page.waitForTimeout(HOLD.beat);
  for (const label of PROCESSING_STAGES) {
    // The real pipeline (~0.5s/stage) can outrun this loop's paced holds and
    // finish — swapping to the report view — before a later stage is checked
    // here. When that happens every stage was genuinely reached in real time,
    // just too briefly for this paced loop to catch; stop watching stages
    // individually rather than fail on a `.pstep` the report legitimately replaced.
    const stillProcessing = await page.locator(".stepper").isVisible().catch(() => false);
    if (!stillProcessing) break;

    const step = page.locator(".pstep", { hasText: label });
    await expect(step).toBeVisible();
    // Show each stage reach at least "running", then move on — no artificial delay.
    await expect(step).toHaveClass(/pstep--(running|done)/, { timeout: 30_000 });
    await page.waitForTimeout(HOLD.beat);
  }
  await page.waitForTimeout(HOLD.read); // all stages complete

  /* 6 — Final assessment: the real release decision ----------------- */
  const decision = page.locator(".exec-grid .decision-box__value");
  await expect(decision).toBeVisible({ timeout: 45_000 });
  await expect(decision).toHaveText("CONDITIONAL");
  await expect(page.locator(".exec-grid .decision-box__meta")).toContainText("GATE-4");

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await page.waitForTimeout(HOLD.settle); // CONDITIONAL / GATE-4 held on screen

  /* 7 — Report walkthrough (slow, deliberate) -------------------------- */

  // Executive summary — Change risk / Test coverage / Security risk / Release decision
  await revealCentered(page, page.locator(".exec-grid"));
  await page.waitForTimeout(HOLD.read);

  // Release readiness — the non-technical "why" and recommended next actions
  await revealCentered(page, page.getByRole("heading", { name: "Release readiness" }));
  await page.waitForTimeout(HOLD.study);

  // AI analysis (advisory) — identified risks, change summary
  await revealCentered(page, page.locator(REPORT_ACCORDION.ai));
  await page.waitForTimeout(HOLD.read);

  // Test coverage — why the deterministic rules rate coverage as insufficient
  await revealCentered(page, page.locator(REPORT_ACCORDION.coverage));
  await openAccordion(page, REPORT_ACCORDION.coverage);
  await expect(page.locator(REPORT_ACCORDION.coverage)).toHaveClass(/\bopen\b/);
  await page.waitForTimeout(HOLD.study);

  // Decision trace — AI analysis identifies risk; the deterministic gate decides
  await revealCentered(page, page.locator(REPORT_ACCORDION.trace));
  await openAccordion(page, REPORT_ACCORDION.trace);
  await expect(page.locator(REPORT_ACCORDION.trace)).toHaveClass(/\bopen\b/);
  await page.waitForTimeout(HOLD.study);

  // Technical details — execution mode, pipeline stages, MCP tools, provenance
  await revealCentered(page, page.locator(REPORT_ACCORDION.technical));
  await openAccordion(page, REPORT_ACCORDION.technical);
  await expect(page.locator(REPORT_ACCORDION.technical)).toHaveClass(/\bopen\b/);
  await page.waitForTimeout(HOLD.read);

  /* 8 — Final frame: the release decision, clearly readable ----------- */
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await expect(decision).toHaveText("CONDITIONAL");
  await expect(page.locator(".exec-grid .decision-box__meta")).toContainText("GATE-4");
  await page.waitForTimeout(HOLD.finale);

  /* --- persist a stable, clearly-named copy of the recording --------- */
  const video = page.video();
  await page.close();
  if (video) {
    await video.saveAs(VIDEO_DEST);
    await testInfo.attach("linkedin-demo", { path: VIDEO_DEST, contentType: "video/webm" });
    // eslint-disable-next-line no-console
    console.log(`\n[linkedin-demo] silent video saved: ${VIDEO_DEST}\n`);
  }

  expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
