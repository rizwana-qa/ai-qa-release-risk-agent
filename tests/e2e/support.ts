/** Shared helpers, fixtures and selectors for the Playwright browser tests. */

import { fileURLToPath } from "node:url";
import type { Page, Locator } from "@playwright/test";

/** The real supporting PDF used by both the functional test and the demo. */
export const PDF_FIXTURE = fileURLToPath(
  new URL("./fixtures/sample-supporting-document.pdf", import.meta.url),
);

/** The six real pipeline stages, in order, as labelled in web/components.js. */
export const PROCESSING_STAGES = [
  "Preparing release context",
  "Preparing QA evidence",
  "AI QA analysis",
  "Validating findings",
  "Evaluating deterministic release gate",
  "Assembling release report",
] as const;

/** Stable selectors for the report accordions (data-acc in web/components.js). */
export const REPORT_ACCORDION = {
  ai: '.acc[data-acc="ai"]',
  coverage: '.acc[data-acc="coverage"]',
  trace: '.acc[data-acc="trace"]',
  technical: '.acc[data-acc="technical"]',
} as const;

/**
 * Smoothly bring an element to the centre of the viewport and let it settle.
 * Uses `evaluate` (needs the element only attached, not visible) so it is safe to
 * call for containers of hidden inputs, and cannot hang on visibility waits.
 */
export async function revealCentered(page: Page, target: Locator, settleMs = 900): Promise<void> {
  await target.first().evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await page.waitForTimeout(settleMs);
}

/** Open a report accordion by its data-acc id and confirm it expanded. */
export async function openAccordion(page: Page, selector: string): Promise<void> {
  const acc = page.locator(selector);
  if (!(await acc.evaluate((el) => el.classList.contains("open")).catch(() => false))) {
    await acc.locator(".acc__head").click();
  }
}
