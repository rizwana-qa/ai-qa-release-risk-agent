import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright browser tests, two projects:
 *
 *   chromium  — the functional regression (tests/e2e/assessment.spec.ts).
 *               `baseURL` uses `localhost` on purpose so it also exercises the
 *               IPv4/IPv6 loopback resolution behind the "Failed to fetch" fix.
 *
 *   demo      — the LinkedIn portfolio walkthrough (tests/e2e/linkedin-demo.spec.ts).
 *               Runs the SAME real workflow, paced for a human viewer, and
 *               records a silent video to artifacts/linkedin-demo/.
 *
 * `npm run test:e2e` runs only `chromium`. `npm run test:demo` runs only `demo`.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:8080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /linkedin-demo\.spec\.ts|portfolio-demo-30s\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "demo",
      testMatch: /linkedin-demo\.spec\.ts/,
      timeout: 240_000,
      outputDir: "./artifacts/linkedin-demo",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        // Silent by construction: Playwright never records an audio track.
        video: { mode: "on", size: { width: 1280, height: 800 } },
        // Slow the automation driver (not the app) so clicks read on video.
        launchOptions: { slowMo: 250 },
      },
    },
    {
      name: "portfolio30",
      testMatch: /portfolio-demo-30s\.spec\.ts/,
      timeout: 240_000,
      outputDir: "./artifacts/portfolio-demo",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        video: { mode: "on", size: { width: 1280, height: 800 } },
        launchOptions: { slowMo: 150 },
      },
    },
  ],
  webServer: {
    command: "npm run demo",
    url: "http://localhost:8080/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
