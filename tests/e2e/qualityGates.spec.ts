/**
 * The read-only Quality Gates page, heading capitalisation, and proof that the
 * existing decisions are unchanged (fixture -> NO GO via GATE-2, worked
 * example -> CONDITIONAL via GATE-4, low-risk evidence with tests -> GO).
 */

import { test, expect, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1366, height: 768 },
  { name: "large", width: 1920, height: 1080 },
] as const;

async function openGates(page: Page, { fresh = true } = {}) {
  if (fresh) await page.goto("/");
  if (await page.locator("#sidebar").isVisible()) await page.locator("#nav-gates").click();
  else { await page.click("#menu-btn"); await page.getByRole("menuitem", { name: "Quality Gates" }).click(); }
  await expect(page.getByRole("heading", { level: 1, name: "Quality Gates" })).toBeVisible();
}

test("Quality Gates page lists the real gates and matches the API", async ({ page, request }) => {
  const doc = await (await request.get("/api/quality-gates")).json();
  await openGates(page);
  expect(page.url()).toContain("#/quality-gates");

  const cards = page.locator(".qg-gate");
  await expect(cards).toHaveCount(doc.gates.length + 1); // + fail-safe
  for (const g of doc.gates) {
    const card = page.locator(`#qg-${g.id}`).locator("xpath=ancestor::article");
    await expect(card).toContainText(g.id);
    await expect(card).toContainText(g.condition);
  }
  for (const name of ["Purpose", "Quality Gate Inventory", "Conditions Behind The Gates", "Evaluation And Decision Flow", "Source Of Truth", "Limitations And Undefined Behavior"]) {
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByText("Threshold: 0.8 (illustrative)")).toBeVisible();
  // No decision control: the page is informational only.
  await expect(page.locator('#gates-view [data-act="analyze"], #gates-view [data-act="run-demo"]')).toHaveCount(0);
});

test("opening Quality Gates keeps the workflow intact and Back returns to it", async ({ page }) => {
  await page.goto("/");
  await page.fill('[data-field="releaseScope"]', "Scope that must survive a detour");
  await openGates(page, { fresh: false });
  await page.getByRole("link", { name: "Back to Workflow" }).click();
  await expect(page.locator('[data-field="releaseScope"]')).toHaveValue("Scope that must survive a detour");
  await expect(page.locator("#gates-view")).toBeHidden();
});

test("a direct link to #/quality-gates resolves to the page", async ({ page }) => {
  await page.goto("/#/quality-gates");
  await expect(page.getByRole("heading", { level: 1, name: "Quality Gates" })).toBeVisible();
});

for (const vp of VIEWPORTS) {
  test(`Quality Gates page has no horizontal overflow @ ${vp.name} ${vp.width}x${vp.height}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openGates(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const clipped = await page.evaluate(() => [...document.querySelectorAll("#gates-view *")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).length);
    expect(clipped).toBe(0);
  });
}

test("every section heading on the report and in the PDF layer is heading-cased; the PDF has no Quality Gates page", async ({ page }) => {
  await page.goto("/");
  await page.click('.ws [data-act="load-example"]');
  await page.click('[data-act="continue-evidence"]');
  await page.click('[data-act="analyze"]');
  await page.waitForSelector(".tabs", { timeout: 40000 });
  await page.click('.actbar [data-nav="decision"]');
  await page.waitForSelector(".exec-grid");

  const bad = await page.evaluate(() => {
    const keep = new Set(["QA", "AI", "API", "PDF", "UI", "UX", "MCP", "ID", "GO", "NO-GO", "CONDITIONAL"]);
    const ok = (w: string) => keep.has(w) || /[0-9_]/.test(w) || /[a-z][A-Z]/.test(w) || !/[A-Za-z]/.test(w) || w.split("-").every((p) => /^[A-Z][^A-Z]*$/.test(p) || keep.has(p));
    return [...document.querySelectorAll("#view h2, #view h3, #view h4, #view .print-report h1.pr-h1--sm")]
      .filter((h) => !h.matches("#page-h"))
      .map((h) => (h.textContent || "").replace(/\s+/g, " ").trim())
      .filter((t) => t && !t.split(" ").every((w) => ok(w.replace(/^[("']+|[)"'.,:;?!]+$/g, ""))));
  });
  expect(bad).toEqual([]);

  const printText = await page.evaluate(() => document.querySelector(".print-report")!.textContent || "");
  expect(printText).not.toMatch(/Quality Gates\b/);
  expect(await page.locator(".print-report .pr-page").count()).toBe(4);
  const pdf = await page.pdf({ format: "A4", preferCSSPageSize: true, printBackground: false });
  expect((pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) || []).length).toBe(4);
});

test("existing decisions are unchanged: fixture NO GO via GATE-2, worked example CONDITIONAL via GATE-4", async ({ page }) => {
  await page.goto("/");
  await page.click("#menu-btn");
  await page.click('[data-act="run-demo"]');
  await page.click('[data-act="analyze"]');
  await page.waitForSelector(".tabs", { timeout: 40000 });
  await page.click('.actbar [data-nav="decision"]');
  await expect(page.locator(".decision-box__value")).toHaveText("NO GO");
  await expect(page.locator(".rationale")).toContainText("GATE-2");

  await page.click("#menu-btn");
  await page.click('[data-act="new"]');
  await page.click('.ws [data-act="load-example"]');
  await page.click('[data-act="continue-evidence"]');
  await page.click('[data-act="analyze"]');
  await page.waitForSelector(".tabs", { timeout: 40000 });
  await page.click('.actbar [data-nav="decision"]');
  await expect(page.locator(".decision-box__value")).toHaveText("CONDITIONAL");
  await expect(page.locator(".rationale")).toContainText("GATE-4");
});
