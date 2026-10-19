/**
 * Minimum-evidence policy (GATE-6) in the browser: the form messages, the
 * CONDITIONAL screen and PDF layer for an empty submission, and a GO with and
 * without a coverage warning.
 */

import { test, expect, type Page } from "@playwright/test";

async function fillContext(page: Page, criteria = 1) {
  await page.goto("/");
  await page.fill('[data-field="releaseScope"]', "Small read-only change to the order list");
  await page.fill('[data-field="userStory"]', "As a user I want to filter orders by date so that I can find them");
  await page.fill('[data-group="ac"] [data-field="text"]', "A user can filter the order list by date range");
  await page.fill('[data-group="ac"] [data-field="area"]', "orders");
  for (let i = 1; i < criteria; i++) {
    await page.click('[data-act="ac-add"]');
    await page.locator('[data-group="ac"] [data-field="text"]').nth(i).fill(`Second criterion ${i}`);
    await page.locator('[data-group="ac"] [data-field="area"]').nth(i).fill("orders");
  }
  await page.click('input[data-field="criticality"][value="low"]', { force: true });
  await page.evaluate(() => (document.querySelector('[data-act="continue-evidence"]') as HTMLElement).click());
}

async function addTest(page: Page, status: string, covers: string[]) {
  await page.click('[data-act="tc-add"]');
  const row = page.locator('[data-group="tc"]').last();
  await row.locator('[data-field="label"]').fill("TC-1");
  await row.locator('[data-field="title"]').fill("Filter by date");
  await row.locator('[data-field="area"]').fill("orders");
  await row.locator('[data-field="status"]').selectOption(status);
  await row.locator('[data-field="testType"]').selectOption("e2e");
  for (const id of covers) await row.locator(`[data-field="covers"][value="${id}"]`).click({ force: true });
}

async function analyseToDecision(page: Page) {
  await page.click('[data-act="analyze"]');
  await page.waitForSelector(".tabs", { timeout: 40000 });
  await page.click('.actbar [data-nav="decision"]');
  await page.waitForSelector(".exec-grid");
}

test("form: states the minimum accurately and does not promise a statement the report does not make", async ({ page }) => {
  await fillContext(page);
  const form = page.locator("#view");
  await expect(form).toContainText("No test cases have been added.");
  await expect(form).toContainText("A release cannot be GO unless at least one acceptance criterion has a passing test mapped to it");
  await expect(form).toContainText("One passing test would not show that every criterion is verified");
  await expect(form).not.toContainText("the report will state that evidence is insufficient");
  await expect(form).not.toContainText("rather than assume the release is safe");

  await addTest(page, "failed", ["AC1"]);
  await expect(form).toContainText("No passing test is mapped to an acceptance criterion.");
  await page.locator('[data-group="tc"] [data-field="status"]').last().selectOption("passed");
  await expect(form).not.toContainText("No passing test is mapped to an acceptance criterion.");
});

test("empty evidence -> CONDITIONAL / GATE-6 on screen and in the PDF layer, never GO", async ({ page }) => {
  await fillContext(page);
  await analyseToDecision(page);
  await expect(page.locator(".decision-box__value")).toHaveText("CONDITIONAL");
  await expect(page.locator(".rationale")).toContainText("no passing test is mapped to any acceptance criterion");
  await expect(page.locator(".rationale")).toContainText("additional verification and review are required");
  await expect(page.locator(".rationale .badge.mono", { hasText: "GATE-6" })).toBeVisible();
  await expect(page.locator("#view")).not.toContainText("Why This Release Is Cleared");

  const printText = await page.evaluate(() => document.querySelector(".print-report")!.textContent || "");
  expect(printText).toMatch(/Rule GATE-6/);
  expect(printText).toMatch(/no passing test is mapped to any acceptance criterion/);
  expect(printText).not.toMatch(/Cleared/);
  const pdf = await page.pdf({ format: "A4", preferCSSPageSize: true, printBackground: false });
  expect((pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) || []).length).toBe(4);
});

test("only failed, not-run or unmapped tests never satisfy the minimum", async ({ page }) => {
  for (const [status, covers] of [["failed", ["AC1"]], ["not-run", ["AC1"]], ["passed", []]] as const) {
    await fillContext(page);
    await addTest(page, status, [...covers]);
    await analyseToDecision(page);
    await expect(page.locator(".decision-box__value")).toHaveText("CONDITIONAL");
    await expect(page.locator(".rationale")).toContainText("GATE-6");
  }
});

test("one passing mapped test satisfies the minimum; partial coverage shows a warning and the GO is not called verified", async ({ page }) => {
  await fillContext(page, 3);
  await addTest(page, "passed", ["AC1"]);
  await analyseToDecision(page);
  await expect(page.locator(".decision-box__value")).toHaveText("GO");
  await expect(page.locator(".rationale :is(h2, h3)")).toHaveText(/^Release decision rationale$/i);
  await expect(page.locator(".rationale")).toContainText("Coverage is below the illustrative threshold.");
  await expect(page.locator(".rationale")).toContainText("does not show that every acceptance criterion has been verified");
  const printText = await page.evaluate(() => document.querySelector(".print-report")!.textContent || "");
  expect(printText).toMatch(/Coverage is below the illustrative threshold\./);
  expect(printText).not.toMatch(/Cleared/);
});

test("full coverage GO has the plain note and no coverage warning", async ({ page }) => {
  await fillContext(page);
  await addTest(page, "passed", ["AC1"]);
  await analyseToDecision(page);
  await expect(page.locator(".decision-box__value")).toHaveText("GO");
  await expect(page.locator(".rationale")).not.toContainText("Coverage is below the illustrative threshold");
  await expect(page.locator(".rationale .rationale__note")).toContainText("GO means no gate blocked this release");
});
