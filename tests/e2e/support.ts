/** Shared helpers, fixtures and selectors for the Playwright browser tests. */

import { fileURLToPath } from "node:url";
import { expect, type Page, type Locator } from "@playwright/test";

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

/** Stable selectors for the Decision-screen accordions (data-acc in web/components.js). */
export const REPORT_ACCORDION = {
  trace: '.acc[data-acc="trace"]',
  technical: '.acc[data-acc="technical"]',
} as const;

/** The Review screen's tabs (data-tab in web/components.js) and their panels. */
export const REVIEW_TAB = {
  risk: "risk",
  coverage: "coverage",
  scenarios: "scenarios",
  defects: "defects",
  regression: "regression",
  ai: "ai",
} as const;

/** Context -> Evidence: the Continue button is enabled once the Context is complete. */
export async function continueToEvidence(page: Page): Promise<void> {
  await page.locator('[data-act="continue-evidence"]').click();
  await expect(page.getByRole("heading", { name: "Evidence, tests & known defects" })).toBeVisible();
}

/** Review -> Decision, via the sticky action bar. */
export async function goToDecision(page: Page): Promise<void> {
  await page.locator('.actbar [data-nav="decision"]').click();
  await expect(page.locator(".exec-grid .decision-box__value")).toBeVisible();
}

/** Decision -> Review, via the sticky action bar. */
export async function goToReview(page: Page): Promise<void> {
  await page.locator('.actbar [data-nav="review"]').click();
  await expect(page.locator(".tabs")).toBeVisible();
}

/** Select a Review tab and wait for its panel to show. */
export async function openReviewTab(page: Page, tab: string): Promise<void> {
  await page.locator(`[data-tab="${tab}"]`).click();
  await expect(page.locator(`#panel-${tab}`)).toBeVisible();
}

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
