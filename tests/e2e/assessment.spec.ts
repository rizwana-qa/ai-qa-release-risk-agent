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

import { PDF_FIXTURE as PDF, PROCESSING_STAGES, continueToEvidence, goToDecision } from "./support.ts";

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
  await expect(page.getByRole("heading", { name: "Context, scope & metadata" })).toBeVisible();

  // 2. Load the sample data.
  await page.locator('.ws [data-act="load-example"]').click();
  await expect(page.locator('[data-field="releaseScope"]')).toHaveValue(/saved card/i);
  await expect(page.locator('[data-group="ac"]')).toHaveCount(4);

  // 3. Continue to Evidence, then upload the PDF supporting document.
  await continueToEvidence(page);
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

  // 6. Release report — it opens on Review; the decision is on the next screen.
  await expect(page.locator(".tabs")).toBeVisible({ timeout: 40_000 });
  await expect(page.locator(".topbar__chip")).toContainText(expectedLabel);
  await goToDecision(page);

  // Assert the ACTUAL decision, matching the API.
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
  await expect(page.getByRole("heading", { name: "Context, scope & metadata" })).toBeVisible();

  await api.dispose();
});

test("staged workflow: Continue is gated, data survives Back, locked stages stay locked", async ({ page }) => {
  await page.goto("/");
  const stage = (name: string) => page.locator(`[data-step="${name}"]`).first();

  // Nothing is complete yet: Evidence / Analyze / Review / Decision are locked.
  for (const name of ["evidence", "analyze", "review", "decision"]) {
    await expect(stage(name)).toHaveAttribute("aria-disabled", "true");
  }

  // Continue is aria-disabled until scope, story and one criterion exist; pressing it explains why.
  const cont = page.locator('[data-act="continue-evidence"]');
  await expect(cont).toHaveAttribute("aria-disabled", "true");
  await cont.click({ force: true }); // aria-disabled, not disabled, so it can explain itself
  await expect(page.getByRole("heading", { name: "Context, scope & metadata" })).toBeVisible();
  await expect(page.locator("#err-scope")).toBeVisible();

  // Fill the three required inputs; Continue unlocks and Evidence becomes reachable.
  await page.locator('[data-field="releaseScope"]').fill("Scope text");
  await page.locator('[data-field="userStory"]').fill("As a user I want a thing");
  await page.locator('[data-group="ac"] [data-field="text"]').first().fill("The thing works");
  await expect(cont).not.toHaveAttribute("aria-disabled", "true");
  await expect(stage("evidence")).toHaveAttribute("aria-disabled", "false");

  // Add evidence, go Back to Context, and confirm nothing was discarded.
  await continueToEvidence(page);
  await page.locator('[data-act="tc-add"]').click();
  await page.locator('[data-group="tc"] [data-field="title"]').fill("A test");
  await page.locator('[data-act="back-to-context"]').click();
  await expect(page.locator('[data-field="releaseScope"]')).toHaveValue("Scope text");
  await continueToEvidence(page);
  await expect(page.locator('[data-group="tc"] [data-field="title"]')).toHaveValue("A test");

  // Review and Decision only exist once a report does.
  await expect(stage("review")).toHaveAttribute("aria-disabled", "true");
  await expect(stage("decision")).toHaveAttribute("aria-disabled", "true");
});

test("print / PDF layer: brand band, decision panel fits, status bar, no orphan pages", async ({ page }) => {
  await page.goto("/");
  await page.locator('.ws [data-act="load-example"]').click();
  await continueToEvidence(page);
  await page.locator('[data-act="analyze"]').click();
  await expect(page.locator(".tabs")).toBeVisible({ timeout: 40_000 });

  // The print layer is the only thing the PDF shows; render it exactly as Print -> Save as PDF does.
  await page.emulateMedia({ media: "print" });
  const m = await page.evaluate(() => {
    const shown = (sel: string) => { const e = document.querySelector(sel); return !!e && getComputedStyle(e).display !== "none"; };
    const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const band = document.querySelector(".pr-runhead") as HTMLElement;
    const value = rect(".pr-hero__value"), panel = rect(".pr-hero__main");
    return {
      printOnly: shown(".print-report") && !shown(".topbar") && !shown(".wf-bar") && !shown(".actbar") && !shown(".exec-grid"),
      sections: document.querySelectorAll(".pr-page").length,
      bandBg: getComputedStyle(band).backgroundColor,
      decisionFits: value.right <= panel.right && value.left >= panel.left,
      ringShown: shown(".pr-hero__ring svg"),
      kpiIcons: document.querySelectorAll(".pr-kpi__value svg").length,
      execBar: shown(".pr-dist"),
      decision: (document.querySelector(".pr-hero__value") as HTMLElement).textContent,
      decisionPt: parseFloat(getComputedStyle(document.querySelector(".pr-hero__value")!).fontSize) * 0.75,
      bodyPt: parseFloat(getComputedStyle(document.querySelector(".pr-hero__reason p")!).fontSize) * 0.75,
      mainShare: panel.width / rect(".pr-hero").width,
      heroMm: rect(".pr-hero").height * 25.4 / 96,
    };
  });
  expect(m.printOnly).toBe(true);
  expect(m.sections).toBe(4);
  expect(m.bandBg).toBe("rgb(24, 54, 91)"); // brand navy #18365B, same token as the web header
  expect(m.decisionFits, "decision word must stay inside its panel").toBe(true);
  expect(m.ringShown).toBe(true);
  expect(m.kpiIcons).toBe(3);
  expect(m.execBar).toBe(true);
  expect(m.decision).toBe("CONDITIONAL");
  // Compact decision + summary panel: 16-19pt decision, 9.5-11pt body, ~40/60 columns, content-driven height.
  expect(m.decisionPt).toBeGreaterThanOrEqual(16);
  expect(m.decisionPt).toBeLessThanOrEqual(19);
  expect(m.bodyPt).toBeGreaterThanOrEqual(9.5);
  expect(m.bodyPt).toBeLessThanOrEqual(11);
  expect(m.mainShare).toBeGreaterThan(0.37);
  expect(m.mainShare).toBeLessThan(0.43);
  expect(m.heroMm).toBeLessThan(42); // decision word + reason + the change description

  // Actual PDF: one physical page per section for this report (no footer-only or blank pages).
  const pdf = await page.pdf({ format: "A4", preferCSSPageSize: true, printBackground: false });
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  expect(pages).toBe(4);
});

test("decision + executive summary panel is compact on desktop and stacks without overflow at 320px", async ({ page }) => {
  await page.goto("/");
  await page.locator('.ws [data-act="load-example"]').click();
  await continueToEvidence(page);
  await page.locator('[data-act="analyze"]').click();
  await expect(page.locator(".tabs")).toBeVisible({ timeout: 40_000 });
  await goToDecision(page);

  const measure = () => page.evaluate(() => {
    const px = (sel: string, p: string) => parseFloat(getComputedStyle(document.querySelector(sel)!)[p as any]);
    const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const d = document.documentElement;
    return {
      value: px(".decision-box__value", "fontSize"), ring: r(".decision-box__ring").width,
      pad: px(".decision-box", "paddingTop"), ratPad: px(".rationale", "paddingTop"),
      h3: px(".rationale h2", "fontSize"), lead: px(".rationale__lead", "fontSize"),
      height: r(".exec-grid").height, share: r(".decision-box").width / r(".exec-grid").width,
      stacked: r(".rationale").top >= r(".decision-box").bottom - 1,
      overflow: d.scrollWidth > d.clientWidth + 1,
      clipped: (document.querySelector(".decision-box__value") as HTMLElement).scrollWidth > (document.querySelector(".decision-box__value") as HTMLElement).clientWidth + 1,
      label: document.querySelector(".decision-box__value")!.textContent,
    };
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  const desk = await measure();
  expect(desk.label).toBe("CONDITIONAL");
  expect(desk.value).toBeGreaterThanOrEqual(22);
  expect(desk.value).toBeLessThanOrEqual(24);
  expect(desk.ring).toBeGreaterThanOrEqual(28);
  expect(desk.ring).toBeLessThanOrEqual(32);
  expect(desk.pad).toBeLessThanOrEqual(20);
  expect(desk.ratPad).toBeLessThanOrEqual(20);
  expect(desk.h3).toBeGreaterThanOrEqual(12);
  expect(desk.h3).toBeLessThanOrEqual(13);
  expect(desk.lead).toBeGreaterThanOrEqual(12);
  expect(desk.lead).toBeLessThanOrEqual(14);
  expect(desk.share).toBeGreaterThan(0.38);
  expect(desk.share).toBeLessThan(0.42);
  expect(desk.stacked).toBe(false); // two columns on desktop
  expect(desk.height).toBeLessThan(210);

  await page.setViewportSize({ width: 320, height: 700 });
  const phone = await measure();
  expect(phone.stacked).toBe(true); // decision first, summary second
  expect(phone.overflow).toBe(false);
  expect(phone.clipped).toBe(false);
  expect(phone.pad).toBeLessThanOrEqual(16);
});

test("report states its evidence and provenance; Review tabs stay reachable at tablet width", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/");
  await page.locator('.ws [data-act="load-example"]').click();
  await continueToEvidence(page);
  await page.locator('[data-act="analyze"]').click();
  await expect(page.locator(".tabs")).toBeVisible({ timeout: 40_000 });

  // Every Review tab is on screen (none scrolled out of reach) and keeps its place in the tab order.
  const reach = await page.evaluate(() => [...document.querySelectorAll("[data-tab]")].map((t) => {
    const r = t.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.width > 0;
  }));
  expect(reach).toHaveLength(6);
  expect(reach.every(Boolean)).toBe(true);

  // The evidence line restates the supplied inputs (the worked example: 4 criteria, 5 tests, 1 defect, no documents).
  await expect(page.locator(".report__evidence")).toHaveText("Evidence analyzed: 4 acceptance criteria · 5 test cases · 1 known defect · 0 supporting documents");

  await goToDecision(page);
  // Provenance: supplied evidence vs advisory content are labelled; the gate's block is labelled deterministic.
  await expect(page.locator("section:has(#x-h) .lane--ev")).toHaveText("Supplied evidence");
  await expect(page.locator("section:has(#d-h) .lane--ev")).toHaveText("Supplied evidence");
  await expect(page.locator("section:has(#a-h) .lane--ai")).toHaveText("Advisory");
  await expect(page.locator(".card--gate .lane--gate")).toHaveText("Deterministic gate");

  // Heading hierarchy: one h1, and the executive-summary heading is an h2 (no skipped level).
  expect(await page.locator("#view h1:visible").count()).toBe(1);
  await expect(page.locator(".rationale h2")).toContainText("Why This Release Is Conditional");
});

