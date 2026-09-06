/**
 * Regression: the full manual workflow a QA user performs in the browser.
 *
 *   open workspace -> load the sample data -> upload a PDF supporting document
 *   -> Analyze Release Risk -> 6 real processing stages -> release report
 *
 * The test asserts the ACTUAL assessment result (the deterministic release
 * decision and the gate rule), cross-checked against a direct API call — not
 * merely that a button was clicked. It also fails on any "Failed to fetch"
 * console error, which is the symptom this regression guards against.
 */

import { test, expect, request as pwRequest } from "@playwright/test";
import { statSync } from "node:fs";

import { PDF_FIXTURE as PDF, PROCESSING_STAGES } from "./support.ts";

/** The sample data the "Load example" button fills in (web/workspace.js exampleState). */
const EXAMPLE = {
  releaseName: "Checkout 3.4 — saved payment methods",
  releaseScope:
    "Allow a signed-in customer to save a card during checkout and reuse it on later orders. " +
    "Adds a new 'saved cards' area to the account page and a token-vault call at payment time.",
  userStory:
    "As a returning customer, I want to securely save and reuse a payment card so that I can check out faster on future orders.",
  criticality: "high",
  acceptanceCriteria: [
    { area: "payments", critical: true, text: "A saved card can be used to complete a new order without re-entering the full card number." },
    { area: "security", critical: true, text: "Full PAN is never stored; only a vault token and last four digits are persisted." },
    { area: "account", critical: false, text: "A customer can view and delete their saved cards from the account page." },
    { area: "checkout", critical: false, text: "If the vault call fails, checkout falls back to manual card entry with a clear message." },
  ],
  businessRules: [
    { text: "A customer may store at most five payment cards." },
    { text: "Saved cards expire from the wallet 30 days after the card's own expiry date." },
  ],
  testCases: [
    { label: "TC-101", title: "Reuse saved card completes order", area: "payments", testType: "e2e", status: "passed", covers: ["AC1"] },
    { label: "TC-102", title: "Vault stores token not PAN", area: "security", testType: "integration", status: "passed", covers: ["AC2"] },
    { label: "TC-103", title: "Delete saved card from account", area: "account", testType: "e2e", status: "passed", covers: ["AC3"] },
    { label: "TC-104", title: "Vault outage falls back to manual entry", area: "checkout", testType: "integration", status: "failed", covers: ["AC4"] },
    { label: "TC-105", title: "Sixth card is rejected", area: "payments", testType: "integration", status: "not-run", covers: [] },
  ],
  knownDefects: [
    { label: "DEF-77", severity: "high", status: "open", area: "checkout", security: false, description: "Fallback message not shown when the vault call times out (only on slow connections).", relatedAcs: ["AC4"] },
  ],
  supportingDocuments: [
    { name: "sample-supporting-document.pdf", size: statSync(PDF).size, type: "pdf" },
  ],
};

test("PDF upload + sample data + submit -> real release decision is displayed", async ({ page, baseURL }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  // Independently compute the expected decision from the API (blocking mode).
  const api = await pwRequest.newContext({ baseURL });
  const apiRes = await api.post("/api/assess/custom?blocking=1", { data: EXAMPLE });
  expect(apiRes.status(), await apiRes.text()).toBe(200);
  const apiBody = await apiRes.json();
  const expectedDecision = apiBody.report.releaseDecision as string;
  const expectedRule = apiBody.report.firedRule as string;
  expect(["GO", "NO_GO", "CONDITIONAL"]).toContain(expectedDecision);
  const labels: Record<string, string> = { GO: "GO", NO_GO: "NO GO", CONDITIONAL: "CONDITIONAL" };
  const expectedLabel = labels[expectedDecision];

  // 1. Open the workspace.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "QA Release Risk Assessment" })).toBeVisible();

  // 2. Load the sample data.
  await page.locator('.ws [data-act="load-example"]').click();
  await expect(page.locator('[data-field="releaseScope"]')).toHaveValue(/saved card/i);
  await expect(page.locator('[data-group="ac"]')).toHaveCount(4);

  // 3. Upload the PDF supporting document.
  await page.locator("[data-file-input]").setInputFiles(PDF);
  const chip = page.locator(".doc-chip", { hasText: "sample-supporting-document.pdf" });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/reference only/i);

  // 4. Submit.
  const analyze = page.locator('[data-act="analyze"]');
  await expect(analyze).toBeEnabled();
  await analyze.click();

  // 5. Processing view with the six real stages.
  await expect(page.locator(".stepper")).toBeVisible();
  for (const label of PROCESSING_STAGES) {
    await expect(page.locator(".pstep", { hasText: label })).toBeVisible();
  }

  // 6. Release report — assert the ACTUAL decision, matching the API.
  const decisionValue = page.locator(".exec-grid .decision-box__value");
  await expect(decisionValue).toBeVisible({ timeout: 40_000 });
  await expect(decisionValue).toHaveText(expectedLabel);
  await expect(page.locator(".exec-grid .decision-box__meta")).toContainText(expectedRule);

  // report substance is present
  await expect(page.getByRole("heading", { name: "Release readiness" })).toBeVisible();
  await expect(page.locator(".acc", { hasText: "Decision trace" })).toBeVisible();
  await expect(page.locator(".acc", { hasText: "Technical details" })).toBeVisible();

  // 7. No "Failed to fetch" (or any) console error during the flow.
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);

  // 8. New Assessment returns to the workspace without a reload.
  await page.locator('.report [data-act="new"]').click();
  await expect(page.getByRole("heading", { name: "QA Release Risk Assessment" })).toBeVisible();

  await api.dispose();
});
