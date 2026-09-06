/**
 * Post-deploy smoke test. Runs the full manual workflow against a deployed URL
 * (or a local production-mode server) over HTTP + SSE and checks the 11 points
 * from the deployment checklist.
 *
 *   node scripts/verify-deployment.mjs https://your-app.onrender.com
 *
 * Exits non-zero if any check fails.
 */

const BASE = (process.argv[2] || process.env.BASE || "http://localhost:8080").replace(/\/$/, "");

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}`); }
};

const j = async (path, init) => {
  const r = await fetch(BASE + path, init);
  return { status: r.status, ct: r.headers.get("content-type") || "", body: await r.text() };
};
const postJson = (path, obj) =>
  j(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

const SAMPLE = {
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
  // the uploaded PDF as the frontend attaches it: reference metadata only
  supportingDocuments: [{ name: "sample-supporting-document.pdf", size: 668, type: "pdf" }],
};

console.log(`\nVerifying ${BASE}\n`);

// 1 + 2. app opens, workspace HTML loads with the module bundle
const home = await j("/");
ok(home.status === 200 && /text\/html/.test(home.ct), "1. application opens (GET / -> 200 html)");
ok(/id="view"/.test(home.body) && /\/app\.js/.test(home.body), "2. main workspace shell loads (#view + app.js)");

// 11. API responds
const health = await j("/api/health");
ok(health.status === 200 && /"ok":true/.test(health.body), "11. deployed API responds (GET /api/health)");

// static ES modules the workspace needs
const mods = await Promise.all(["/app.js", "/workspace.js", "/upload.js", "/components.js", "/format.js", "/icons.js", "/styles.css"].map((p) => j(p)));
ok(mods.every((m) => m.status === 200), "   all frontend modules serve (200)");

// 3 + 4. sample data + PDF supporting document accepted (prepare step)
const prep = await postJson("/api/assess/custom", SAMPLE);
let prepBody = {};
try { prepBody = JSON.parse(prep.body); } catch { /* ignore */ }
ok(prep.status === 200 && prepBody.runId, "3+4. sample data + PDF accepted; run prepared (runId issued)");
ok(prepBody.mode === "rules-based", "   assessment runs in rules-based mode");

// 5 + 6 + 7 + 8. submit -> SSE stages -> report -> decision
let events = [];
if (prepBody.runId) {
  const sres = await fetch(`${BASE}/api/assess/custom/stream?runId=${prepBody.runId}`);
  ok(sres.status === 200 && /text\/event-stream/.test(sres.headers.get("content-type") || ""), "5. assessment submitted; SSE stream opened");
  const text = await sres.text();
  events = text.split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => { try { return JSON.parse(b.slice(6)); } catch { return {}; } });
}
const stageKeys = events.filter((e) => e.type === "stage" && e.status === "running").map((e) => e.key);
ok(
  JSON.stringify(stageKeys) === JSON.stringify(["prepare-context", "prepare-evidence", "ai-analysis", "validate", "gate", "assemble"]),
  "6. six real processing stages stream in order",
);
const result = events.find((e) => e.type === "result");
ok(!!result && !!result.report, "7. assessment report returned");
const decision = result?.report?.releaseDecision;
const rule = result?.report?.firedRule;
ok(["GO", "NO_GO", "CONDITIONAL"].includes(decision) && /^GATE-\d$/.test(rule || ""), `8. decision displayed: ${decision} / ${rule}`);
ok(result?.report?.dataProvenance?.requirementId?.startsWith?.("REQ-USR-"), "   decision is deterministic-gate-owned (REQ-USR-* provenance, not REQ-BEN-001)");
ok(JSON.stringify(result?.supportingDocuments) === JSON.stringify([{ name: "sample-supporting-document.pdf", size: 668, type: "pdf" }]), "   PDF carried as reference metadata through the pipeline");

// 9. a completed request means the browser fetch would not have thrown "Failed to fetch"
ok(prep.status === 200 && !!result, "9. no 'Failed to fetch' path (prepare + stream + result all reachable)");

// 10. error responses are JSON, no stack traces / secrets leaked
const badBody = await j("/api/assess/custom", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
ok(badBody.status === 400 && !/at Object\.|node:internal|GEMINI|AIzaSy|\/home\/|[A-Za-z]:\\\\/.test(badBody.body), "10. malformed request -> clean 400 JSON (no stack trace / secret)");

// regression fixture still intact on the deployment
const reg = await postJson("/api/assess?id=REQ-BEN-001", {});
let regBody = {};
try { regBody = JSON.parse(reg.body); } catch { /* ignore */ }
ok(regBody?.report?.releaseDecision === "NO_GO" && regBody?.report?.firedRule === "GATE-2", "   REQ-BEN-001 regression fixture -> NO_GO / GATE-2");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
