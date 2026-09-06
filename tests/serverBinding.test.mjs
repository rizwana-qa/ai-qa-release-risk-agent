/**
 * Regression: the demo server must be reachable at whatever address the browser
 * resolves "localhost" to. On Windows that is ::1 (IPv6) first; a server bound
 * only to 127.0.0.1 left the browser's fetch() calls failing with
 * "Failed to fetch" even though the page loaded.
 *
 * This spawns the REAL `node api/server.ts` (what `npm run demo` runs) and drives
 * the full manual workflow — sample data + a PDF supporting document — over the
 * loopback address, asserting a real release decision comes back.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lookup } from "node:dns/promises";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8000 + Math.floor(Math.random() * 1500);

let child;

before(async () => {
  child = spawn(process.execPath, ["api/server.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(PORT), GEMINI_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // wait for the startup banner
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start in time")), 15_000);
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      if (buf.includes(`http://localhost:${PORT}`)) { clearTimeout(t); resolve(); }
    });
    child.on("exit", (code) => { clearTimeout(t); reject(new Error("server exited early: " + code)); });
  });
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
  }
});

describe("npm run demo — loopback reachability", () => {
  it("responds on http://127.0.0.1:<port>", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
  });

  it("responds on http://localhost:<port> (the URL the banner prints)", async () => {
    const r = await fetch(`http://localhost:${PORT}/api/health`);
    assert.equal(r.status, 200);
  });

  it("responds on http://[::1]:<port> when this host resolves localhost to IPv6 first", async () => {
    const addrs = await lookup("localhost", { all: true }).catch(() => []);
    const ipv6First = addrs.length > 0 && addrs[0].family === 6;
    if (!ipv6First && !addrs.some((a) => a.family === 6)) {
      // IPv6 loopback genuinely unavailable on this host — nothing to assert.
      return;
    }
    const r = await fetch(`http://[::1]:${PORT}/api/health`);
    assert.equal(r.status, 200, "IPv6 loopback must answer so browser fetch() to localhost works");
  });
});

describe("npm run demo — full manual workflow over localhost", () => {
  it("sample data + PDF supporting document -> real release decision via prepare + SSE", async () => {
    const B = `http://localhost:${PORT}`;
    const payload = {
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
      businessRules: [{ text: "A customer may store at most five payment cards." }],
      testCases: [
        { label: "TC-101", title: "Reuse saved card completes order", area: "payments", testType: "e2e", status: "passed", covers: ["AC1"] },
        { label: "TC-102", title: "Vault stores token not PAN", area: "security", testType: "integration", status: "passed", covers: ["AC2"] },
        { label: "TC-103", title: "Delete saved card from account", area: "account", testType: "e2e", status: "passed", covers: ["AC3"] },
        { label: "TC-104", title: "Vault outage falls back to manual entry", area: "checkout", testType: "integration", status: "failed", covers: ["AC4"] },
      ],
      knownDefects: [
        { label: "DEF-77", severity: "high", status: "open", area: "checkout", security: false, description: "Fallback message not shown on slow connections.", relatedAcs: ["AC4"] },
      ],
      supportingDocuments: [{ name: "sample-supporting-document.pdf", size: 668, type: "pdf" }],
    };

    const prep = await fetch(`${B}/api/assess/custom`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(prep.status, 200);
    const { runId } = await prep.json();
    assert.ok(runId, "prepare returned a runId");

    const sres = await fetch(`${B}/api/assess/custom/stream?runId=${runId}`);
    assert.equal(sres.status, 200);
    const events = (await sres.text())
      .split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));

    const stages = events.filter((e) => e.type === "stage" && e.status === "running").map((e) => e.key);
    assert.deepEqual(stages, ["prepare-context", "prepare-evidence", "ai-analysis", "validate", "gate", "assemble"]);

    const result = events.find((e) => e.type === "result");
    assert.ok(result, "a result event was emitted");
    assert.ok(["GO", "NO_GO", "CONDITIONAL"].includes(result.report.releaseDecision));
    assert.match(result.report.firedRule, /^GATE-\d$/);
    assert.equal(result.mode, "rules-based");
    // the PDF is carried through as reference metadata only
    assert.deepEqual(result.supportingDocuments, [{ name: "sample-supporting-document.pdf", size: 668, type: "pdf" }]);
    assert.ok(result.report.dataProvenance.requirementId.startsWith("REQ-USR-"));
  });
});
