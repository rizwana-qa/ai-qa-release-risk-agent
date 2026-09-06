/**
 * Portfolio Demo (30s cut source)
 * ================================
 *
 * Records the REAL product workflow, phase-marked so a post-production step
 * (scripts/build-portfolio-demo.mjs) can compress only the variable-length
 * "AI is thinking" wait — real Gemini latency, which cannot be predicted or
 * scripted — into a short clip, while every other phase already runs at a
 * pre-tuned, near-final duration. Nothing shown is fabricated: this is the
 * same live API, same deterministic gate, same real report as every other
 * test in this suite. Only the WAITING is time-compressed in the final cut,
 * exactly like the sped-up loading montage in any normal product demo video.
 *
 *   PIPELINE_AGENT_FINDINGS_FILE=./workflows/sample-agent-findings.json \
 *     npx playwright test --project=portfolio30   # free dry run, tunes timing
 *   npx playwright test --project=portfolio30      # the one real, live-Gemini take
 */

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { REPORT_ACCORDION, revealCentered, openAccordion } from "./support.ts";

const VIDEO_DEST = fileURLToPath(
  new URL("../../artifacts/portfolio-demo/portfolio-demo-raw.webm", import.meta.url),
);

async function setCaption(page: import("@playwright/test").Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    // A full-width, fully-opaque fixed bar (not a floating pill) so it can never
    // let the app's own in-flow footer bleed through at any scroll position.
    let el = document.getElementById("__demoCaption") as HTMLDivElement | null;
    if (!el) {
      el = document.createElement("div");
      el.id = "__demoCaption";
      el.style.cssText = [
        "position:fixed", "left:0", "right:0", "bottom:0", "height:64px",
        "display:flex", "align-items:center", "justify-content:center",
        "background:#0b1224", "color:#fff",
        "font:700 24px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif",
        "z-index:2147483647", "letter-spacing:.3px",
        "box-shadow:0 -6px 20px rgba(0,0,0,.25)",
        "pointer-events:none",
      ].join(";");
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

async function removeCaption(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => document.getElementById("__demoCaption")?.remove());
}

test("Portfolio Demo (30s cut source)", async ({ page }) => {
  const t0 = Date.now();
  const mark = (label: string) => console.log(`MARK ${label} ${Date.now() - t0}`);
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  /* Phase 1 — Submit Release Scenario (~0-4s) ---------------------------- */
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "QA Release Risk Assessment" })).toBeVisible();
  mark("phase1-start");
  await setCaption(page, "Submit Release Scenario");

  await page.locator('[data-field="releaseName"]').click();
  await page.locator('[data-field="releaseName"]').pressSequentially("Checkout 3.4: saved payment methods", { delay: 22 });
  await page.locator('.ws [data-act="load-example"]').click();
  await expect(page.locator('[data-field="releaseScope"]')).toHaveValue(/saved card/i);
  await revealCentered(page, page.locator('[data-group="ac"]').first(), 350);
  const analyze = page.locator('[data-act="analyze"]');
  await revealCentered(page, analyze, 300);
  await expect(analyze).toBeEnabled();
  mark("phase1-end");

  /* Phase 2 — AI is analyzing (variable-length: real Gemini latency) ----- */
  await setCaption(page, "AI Risk Analysis");
  await analyze.click();
  await expect(page.locator(".stepper")).toBeVisible();
  mark("processing-start");

  const decision = page.locator(".exec-grid .decision-box__value");
  await expect(decision).toBeVisible({ timeout: 100_000 });
  mark("processing-end"); // <- everything between processing-start and here gets compressed in post

  /* Phase 3 — Prove the live AI path (~4.5s target) ----------------------- */
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(250);
  await revealCentered(page, page.locator(REPORT_ACCORDION.technical), 300);
  await openAccordion(page, REPORT_ACCORDION.technical);
  await expect(page.locator(REPORT_ACCORDION.technical)).toHaveClass(/\bopen\b/);
  await page.waitForTimeout(2200); // hold on "AI analysis: Gemini 3.6 Flash"
  mark("phase3-end");

  /* Phase 4 — Risk + release gate decision (~5s target) ------------------- */
  await setCaption(page, "Release Gate Decision");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await revealCentered(page, page.locator(".exec-grid"), 500);
  await expect(decision).toBeVisible();
  await page.waitForTimeout(500);
  await revealCentered(page, page.locator(REPORT_ACCORDION.ai), 350);
  await openAccordion(page, REPORT_ACCORDION.ai);
  await page.waitForTimeout(1100);
  await revealCentered(page, page.locator(REPORT_ACCORDION.trace), 300);
  await openAccordion(page, REPORT_ACCORDION.trace);
  await page.waitForTimeout(1100);
  mark("phase4-end");

  /* Phase 5 — Test strategy walkthrough (~6s target) ---------------------- */
  await setCaption(page, "Test Strategy");
  await revealCentered(page, page.locator(REPORT_ACCORDION.coverage), 300);
  await openAccordion(page, REPORT_ACCORDION.coverage);
  await page.waitForTimeout(1100);
  await revealCentered(page, page.getByRole("heading", { name: "Missing test scenarios" }), 300);
  await page.waitForTimeout(800);
  await revealCentered(page, page.getByRole("heading", { name: "Regression priorities" }), 300);
  await page.waitForTimeout(800);
  await revealCentered(page, page.getByRole("heading", { name: "Known defects" }), 300);
  await page.waitForTimeout(800);
  mark("phase5-end");

  /* Phase 6 — Finale: complete QA assessment (~5s target) ------------------ */
  await setCaption(page, "Complete QA Assessment");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await page.waitForTimeout(900);
  await expect(decision).toBeVisible();
  await page.waitForTimeout(2900);
  await removeCaption(page);
  mark("phase6-end");

  const video = page.video();
  await page.close();
  if (video) {
    await video.saveAs(VIDEO_DEST);
    console.log(`\n[portfolio-demo] raw video saved: ${VIDEO_DEST}\n`);
  }

  expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
