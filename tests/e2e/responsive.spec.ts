/**
 * Responsive + visual-regression check for the UI redesign.
 *
 * Runs the full real workflow at a desktop and a mobile viewport, asserts there
 * is no horizontal page overflow at any stage, and captures reference
 * screenshots to artifacts/ui-review/ (git-ignored). Nothing is mocked.
 */

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

import { PDF_FIXTURE, PROCESSING_STAGES } from "./support.ts";

const SHOTS = fileURLToPath(new URL("../../artifacts/ui-review/", import.meta.url));

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

/** True when the page itself does not scroll horizontally (allow 1px rounding). */
async function noPageOverflow(page: import("@playwright/test").Page): Promise<{ ok: boolean; w: number; c: number }> {
  return page.evaluate(() => {
    const d = document.documentElement;
    const w = Math.max(d.scrollWidth, document.body.scrollWidth);
    const c = d.clientWidth;
    return { ok: w <= c + 1, w, c };
  });
}

for (const vp of VIEWPORTS) {
  test(`responsive @ ${vp.name} ${vp.width}x${vp.height} — full workflow, no overflow`, async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await page.setViewportSize({ width: vp.width, height: vp.height });

    /* workspace */
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "QA Release Risk Assessment" })).toBeVisible();
    let of = await noPageOverflow(page);
    expect(of.ok, `workspace overflow: scrollWidth ${of.w} > clientWidth ${of.c}`).toBe(true);
    await page.screenshot({ path: `${SHOTS}${vp.name}-01-workspace.png`, fullPage: true });

    /* load example + evidence */
    await page.locator('.ws [data-act="load-example"]').click();
    await expect(page.locator('[data-group="ac"]')).toHaveCount(4);
    await page.locator("[data-file-input]").setInputFiles(PDF_FIXTURE);
    const chip = page.locator(".doc-chip", { hasText: "sample-supporting-document.pdf" });
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(/reference only/i);
    of = await noPageOverflow(page);
    expect(of.ok, `evidence overflow: ${of.w} > ${of.c}`).toBe(true);
    if (vp.name === "desktop") {
      await page.locator(".stats").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}${vp.name}-02-evidence.png`, fullPage: true });
    }
    const REPORT_SHOT = `${SHOTS}${vp.name === "desktop" ? "desktop-03" : "mobile-02"}-report.png`;

    /* analyze — real pipeline */
    const analyze = page.locator('[data-act="analyze"]');
    await expect(analyze).toBeEnabled();
    await analyze.click();
    await expect(page.locator(".stepper")).toBeVisible();
    for (const label of PROCESSING_STAGES) {
      await expect(page.locator(".pstep", { hasText: label })).toBeVisible();
    }
    of = await noPageOverflow(page);
    expect(of.ok, `processing overflow: ${of.w} > ${of.c}`).toBe(true);

    /* report — real decision */
    const decision = page.locator(".exec-grid .decision-box__value");
    await expect(decision).toBeVisible({ timeout: 40_000 });
    await expect(decision).toHaveText("CONDITIONAL");
    await expect(page.locator(".exec-grid .decision-box__meta")).toContainText("GATE-4");

    // open every report accordion, then assert still no overflow (widest state)
    for (const acc of await page.locator(".acc").all()) {
      const open = await acc.evaluate((el) => el.classList.contains("open"));
      if (!open) await acc.locator(".acc__head").click();
    }
    of = await noPageOverflow(page);
    expect(of.ok, `report overflow: ${of.w} > ${of.c}`).toBe(true);
    await page.screenshot({ path: REPORT_SHOT, fullPage: true });

    // key controls reachable / tappable
    await expect(page.locator('.report [data-act="new"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: "Release readiness" })).toBeVisible();

    expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
    await testInfo.attach(`${vp.name}-report`, { path: REPORT_SHOT, contentType: "image/png" });
  });
}
