/**
 * Phase 5 — unit tests for the dependency-free frontend helpers that run outside
 * a browser: HTML/attribute escaping, the "never invent GO" decision label, the
 * file-type policy, and the CSV / row mappers. Untrusted strings must come back
 * as inert, escaped data.
 *
 * This is a plain .mjs test (not .ts) so it can import the browser ES modules
 * directly without pulling them into the TypeScript program.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { esc, attr, decisionLabel, decisionClass } from "../web/format.js";
import { classifyExt, csvToRows, rowsToTestCases, rowsToDefects } from "../web/upload.js";
import { reportView } from "../web/components.js";

const WEB = (f) => fileURLToPath(new URL(`../web/${f}`, import.meta.url));

/** A minimal but complete assessment result for the report renderer. */
function sampleResult(over = {}) {
  const base = {
    report: {
      scenario: "REQ-USR-abc", decisionAuthority: "evaluateReleaseGate() (deterministic)",
      releaseDecision: "CONDITIONAL", firedRule: "GATE-4",
      reasons: ["High-risk change with insufficient coverage."],
      aiQaExplanation: "Explanation text.", changeSummary: "Summary text.",
      identifiedRisks: [{ area: "payments", description: "d", severity: "high" }],
      coverageAssessment: [{ acceptanceCriterionId: "AC1", covered: true, notes: "1 passing test of 1 linked." }],
      missingScenarios: ["Confirm test evidence traces to business rule BR1: rule."],
      defectReview: [], regressionPriorities: [{ area: "payments", priority: "high", rationale: "r" }],
      dataProvenance: { requirementId: "REQ-USR-abc", acceptanceCriteriaCount: 1, existingTestCount: 1, knownDefectCount: 0 },
      agentOutputValid: true, adapterOk: true,
      pipelineTrace: [
        { step: "ai-reasoning", ok: true }, { step: "validate-structured-findings", ok: true },
        { step: "deterministic-adapter", ok: true }, { step: "deterministic-release-gate", ok: true, detail: "CONDITIONAL (GATE-4)" },
      ],
    },
    summary: {
      changeRisk: "high", testCoverage: "insufficient",
      coverageReasons: ["COV-2: security area 'payments' has no negative-path test."],
      securityRisk: "passed", securityReasons: [],
    },
    coverageStats: {
      totalTests: 1, passed: 1, failed: 0, blocked: 0, other: 0,
      totalCriteria: 1, coveredCriteria: 1, coveragePercent: 100,
      byCriterion: [{ id: "AC1", label: "AC1", area: "payments", critical: true, coverage: "covered", activeTests: ["T1"], allTests: ["T1"] }],
      uncoveredCritical: [],
    },
    context: {
      requirementId: "REQ-USR-abc", releaseName: "R", releaseScope: "s", userStory: "u", criticality: "high",
      affectedAreas: ["payments"],
      acceptanceCriteria: [{ id: "AC1", area: "payments", critical: true, text: "crit" }],
      businessRules: [{ id: "BR1", text: "rule" }],
      testCases: [{ id: "T1", label: "T1", title: "t", area: "payments", testType: "e2e", status: "active", statusRaw: "passed", covers: ["AC1"] }],
      defects: [], supportingDocuments: [],
    },
    provenance: { requirementId: "REQ-USR-abc" },
    supportingDocuments: [],
    mode: "rules-based",
    meta: { pipelineStages: ["Preparing release context"], evaluationOrder: ["GATE-1", "GATE-2"], mcpTools: ["get_requirement"] },
  };
  return { ...base, ...over, report: { ...base.report, ...(over.report || {}) }, summary: { ...base.summary, ...(over.summary || {}) } };
}

describe("web/format.js — escaping", () => {
  it("esc() neutralises HTML control characters", () => {
    const out = esc("<script>alert('x')</script> & \"q\"");
    assert.ok(!out.includes("<script>"));
    assert.equal(out, "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;q&quot;");
  });

  it("attr() also collapses newlines for safe attribute use", () => {
    assert.equal(attr('a"b\nc'), "a&quot;b c");
  });

  it("esc() handles null / undefined / numbers", () => {
    assert.equal(esc(null), "");
    assert.equal(esc(undefined), "");
    assert.equal(esc(42), "42");
  });
});

describe("web/format.js — decision label never fabricates GO", () => {
  it("known tokens map straight through", () => {
    assert.equal(decisionLabel("GO"), "GO");
    assert.equal(decisionLabel("NO_GO"), "NO GO");
    assert.equal(decisionLabel("CONDITIONAL"), "CONDITIONAL");
  });
  it("unknown / null / empty -> UNAVAILABLE, never GO", () => {
    for (const v of [null, undefined, "", "go", "APPROVED", "yes", 1]) {
      assert.equal(decisionLabel(v), "UNAVAILABLE");
      assert.equal(decisionClass(v), "d-unavailable");
    }
  });
});

describe("web/upload.js — file-type policy", () => {
  it("parses only json/csv/txt", () => {
    for (const n of ["a.json", "TESTS.CSV", "notes.txt"]) assert.equal(classifyExt(n), "text");
  });
  it("keeps pdf/docx/xlsx as references only", () => {
    for (const n of ["spec.pdf", "plan.docx", "data.xlsx"]) assert.equal(classifyExt(n), "reference");
  });
  it("rejects executables, scripts, archives, markup and extension-less names", () => {
    for (const n of ["evil.exe", "run.sh", "hack.js", "a.bat", "x.ps1", "p.zip", "page.html", "x.svg", "README", "../../passwd"]) {
      assert.equal(classifyExt(n), "blocked", n);
    }
  });
});

describe("web/upload.js — CSV + row mappers treat content as plain data", () => {
  it("csvToRows parses a quoted CSV with embedded commas and quotes", () => {
    const rows = csvToRows(
      "Test ID,Title,Status\n" +
      'TC-1,"Login, then logout","passed"\n' +
      'TC-2,"He said ""hi""",failed\n',
    );
    assert.deepEqual(rows, [
      { "Test ID": "TC-1", Title: "Login, then logout", Status: "passed" },
      { "Test ID": "TC-2", Title: 'He said "hi"', Status: "failed" },
    ]);
  });

  it("rowsToTestCases maps common headers and carries malicious text verbatim", () => {
    const tc = rowsToTestCases([
      { "Test ID": "TC-9", Title: "<script>x</script>", Area: "Auth", Type: "e2e", Status: "passed", Covers: "AC1 AC2" },
    ]);
    assert.equal(tc.length, 1);
    assert.equal(tc[0].title, "<script>x</script>"); // data, not executed or stripped
    assert.deepEqual(tc[0].covers, ["AC1", "AC2"]);
    assert.equal(tc[0].status, "passed");
  });

  it("rowsToDefects maps severity/security and keeps SQL-ish text as data", () => {
    const df = rowsToDefects([
      { "Defect ID": "D1", Severity: "High", Status: "Open", Security: "yes", Description: "'; DROP TABLE t;--", "Related AC": "AC3" },
    ]);
    assert.equal(df[0].security, true);
    assert.equal(df[0].severity, "high");
    assert.equal(df[0].description, "'; DROP TABLE t;--");
    assert.deepEqual(df[0].relatedAcs, ["AC3"]);
  });
});

describe("web/components.js — reportView renders backend data faithfully and inertly", () => {
  it("shows exactly the backend decision label and never invents one", () => {
    const html = reportView(sampleResult());
    assert.match(html, /CONDITIONAL/);
    assert.doesNotMatch(html, /\bGO\b(?!\s*\/)/); // no stray "GO" for a CONDITIONAL result
    const unavailable = reportView(sampleResult({ report: { releaseDecision: null, firedRule: "FAIL_SAFE" } }));
    assert.match(unavailable, /UNAVAILABLE/);
    assert.doesNotMatch(unavailable, />\s*GO\s*</);
  });

  it("neutralises XSS payloads in every rendered field", () => {
    const x = "<script>alert(1)</script><img src=x onerror=alert(1)>";
    const html = reportView(sampleResult({
      report: { changeSummary: x, aiQaExplanation: x, reasons: [x], identifiedRisks: [{ area: x, description: x, severity: "high" }] },
      context: {
        ...sampleResult().context,
        releaseName: x,
        acceptanceCriteria: [{ id: "AC1", area: x, critical: true, text: x }],
      },
    }));
    assert.doesNotMatch(html, /<script>|<img [^>]*onerror/i);
    assert.match(html, /&lt;script&gt;/);
  });

  it("when Test Coverage = INSUFFICIENT the coverage section states why (no silent contradiction)", () => {
    const html = reportView(sampleResult()); // 100% model coverage but summary.testCoverage === "insufficient"
    assert.match(html, /rate test coverage as insufficient/i);
    assert.match(html, /COV-2: security area/); // the gate's own coverage reason is surfaced
  });

  it("when Security Risk = FAIL the readiness section surfaces the security reasons", () => {
    const html = reportView(sampleResult({
      summary: { securityRisk: "failed", securityReasons: ["SEC-1: open security defect DEF-9 at high severity."] },
      report: { releaseDecision: "NO_GO", firedRule: "GATE-1", reasons: ["An open critical defect (DEF-1) blocks release."] },
    }));
    assert.match(html, /Security checks \(deterministic QA rules\)/);
    assert.match(html, /SEC-1: open security defect DEF-9/);
  });
});

describe("web/*.js — every module parses as an ES module", () => {
  for (const f of ["format.js", "icons.js", "upload.js", "workspace.js", "components.js", "app.js"]) {
    it(`node --check ${f}`, () => {
      assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", WEB(f)], { stdio: "pipe" }));
    });
  }
});
