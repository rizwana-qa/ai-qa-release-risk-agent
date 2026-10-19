/**
 * The external-AI-processing notice is on the Evidence screen, visible before an assessment is
 * submitted, and no longer claims that nothing leaves the machine.
 */

import { test, expect } from "@playwright/test";

async function toEvidence(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.click('.ws [data-act="load-example"]');
  await page.evaluate(() => (document.querySelector('[data-act="continue-evidence"]') as HTMLElement).click());
  await expect(page.locator('[data-disclosure="external-ai"]')).toBeVisible();
}

test("Evidence screen: the notice states what is sent, what is not, both modes, the failed-attempt case and the restriction", async ({ page }) => {
  await toEvidence(page);
  const notice = page.locator('[data-disclosure="external-ai"]');
  await expect(notice).toContainText("External AI processing");
  await expect(notice).toContainText("If Gemini analysis is enabled for this deployment");
  await expect(notice).toContainText("the release name, user story and release scope, acceptance-criteria text, test titles, defect descriptions, ids, statuses, severities, criticality, area names, and which criteria each test covers");
  await expect(notice).toContainText("Rows from uploaded CSV and JSON files are sent");
  await expect(notice).toContainText("Not sent to the AI provider: business rules, text notes from TXT files, and the names, sizes and types of uploaded files");
  await expect(notice).toContainText("PDF, DOCX and XLSX contents are not read");
  await expect(notice).toContainText("If Gemini analysis is not enabled, an offline rules-based analysis runs on this application's server and no request is made to the AI provider");
  await expect(notice).toContainText("the evidence may already have been sent in that attempt");
  await expect(notice).toContainText("Starting a request does not confirm that the provider received it");
  await expect(notice).toContainText("states that a live request was started and did not give usable findings");
  await expect(notice).toContainText("Do not submit secrets, credentials, personal data or confidential production or customer evidence");
  await expect(notice).toContainText("which this application cannot show or verify");
  await expect(notice).toContainText("not by the AI");
  await expect(page.locator("#view")).not.toContainText("No external service is called");
  await expect(page.locator("#view")).not.toContainText("Runs locally against your submitted evidence only");
});

/**
 * Phrases that PROMISE something this application cannot know about the provider. Topic words alone ("residency",
 * "retention", "deletion", "compliance") are deliberately not banned: an honest statement that those terms are
 * unknown or cannot be shown must stay writable. Each pattern matches a claim, not a subject.
 */
const UNSUPPORTED_GUARANTEES: Array<[RegExp, string]> = [
  [/\b(stays?|remains?|(is|are) (stored|processed|kept|hosted))\b[^.]{0,40}\b(in|within)\b[^.]{0,20}\b(uae|united arab emirates|your (region|country))/i, "a data-residency promise"],
  [/\b(uae|united arab emirates)[- ]?(only|resident|based)\b/i, "a data-residency promise"],
  [/\b(is|are|fully|gdpr[- ]|uae[- ]|pdpl[- ])compliant\b|\bcompl(y|ies) with\b|\bmeets? (all )?(legal|regulatory|privacy)\b/i, "a compliance claim"],
  [/\b(zero|no)[- ]retention\b|\bno data is (stored|kept|retained|logged)\b/i, "a retention promise"],
  [/\bnever\s+(us(e|es|ed)|stor(e|es|ed)|retain(s|ed)?|log(s|ged)?|keep(s)?|kept|shar(e|es|ed)|train(s|ed)?)\b|\bnot\s+(used|stored|retained|logged|kept|shared)\b/i, "a promise about how the provider uses or keeps data"],
  [/\b(is|are|will be)\s+(immediately\s+)?(deleted|erased|purged|discarded)\b|\bdeleted after\b/i, "a deletion promise"],
  [/\b(is|are|remains?)\s+(secure|private|confidential|anonymi[sz]ed|encrypted)\b|\b(safely|securely)\s+(processed|stored|handled)\b/i, "a security or confidentiality claim"],
];
const guaranteesIn = (text: string): string[] => UNSUPPORTED_GUARANTEES.filter(([re]) => re.test(text)).map(([, what]) => what);

test("the notice makes no unsupported guarantee about residency, compliance, retention, deletion or security", async ({ page }) => {
  await toEvidence(page);
  const text = await page.locator('[data-disclosure="external-ai"]').innerText();
  expect(guaranteesIn(text), "claims found in the notice").toEqual([]);
});

test("the guarantee check rejects promises and still allows honest statements of what is unknown", () => {
  const promises = [
    "Your data stays in the UAE.",
    "Evidence is stored only in the United Arab Emirates.",
    "The service is GDPR-compliant.",
    "This complies with UAE data law.",
    "Zero retention applies to every request.",
    "The provider never stores or uses your data.",
    "Your data is not logged.",
    "Evidence is deleted after analysis.",
    "Your evidence is secure and confidential.",
  ];
  for (const sentence of promises) expect(guaranteesIn(sentence), `should reject: ${sentence}`).not.toEqual([]);

  const honest = [
    "This application cannot show the data residency, retention or deletion terms of the provider account.",
    "No UAE data-residency guarantee was found for the Gemini Developer API.",
    "What the provider keeps or uses depends on the terms of the account behind this deployment, which this application cannot show or verify.",
    "Compliance with local law has not been assessed.",
    "Retention periods and logging controls are unknown.",
    "Not sent to the AI provider: business rules, text notes from TXT files, and the names, sizes and types of uploaded files.",
  ];
  for (const sentence of honest) expect(guaranteesIn(sentence), `should allow: ${sentence}`).toEqual([]);
});

test("the notice comes before the Analyze button in reading order and stays on screen at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await toEvidence(page);
  const order = await page.evaluate(() => {
    const n = document.querySelector('[data-disclosure="external-ai"]')!;
    const a = document.querySelector('[data-act="analyze"]')!;
    return Boolean(n.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the notice survives edits to the form (it is part of the Evidence screen, not a one-off message)", async ({ page }) => {
  await toEvidence(page);
  await page.click('[data-act="tc-add"]');
  await expect(page.locator('[data-disclosure="external-ai"]')).toBeVisible();
});

test("the report still says which analysis mode ran (rules-based here: no key is configured for the test server)", async ({ page }) => {
  await toEvidence(page);
  await page.click('[data-act="analyze"]');
  await page.waitForSelector(".tabs", { timeout: 40000 });
  await page.click('.actbar [data-nav="decision"]');
  await expect(page.locator("#view")).toContainText("QA analysis mode: Rules based");
});
