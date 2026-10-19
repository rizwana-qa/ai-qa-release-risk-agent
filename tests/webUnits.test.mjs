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
import { readFileSync } from "node:fs";
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

describe("web/components.js — staged report screens", () => {
  it("review stage shows the tabs and findings but not the decision hero", () => {
    const html = reportView(sampleResult(), { stage: "review" });
    assert.match(html, /role="tablist"/);
    assert.match(html, /Stage 4 of 5/);
    assert.doesNotMatch(html, /class="exec-grid"/);
    assert.match(html, /data-nav="decision"/); // Continue to Decision
  });

  it("review stage keeps every panel in the DOM and hides all but the selected tab", () => {
    const html = reportView(sampleResult(), { stage: "review", tab: "coverage" });
    const panels = [...html.matchAll(/<div class="tabpanel"[^>]*id="panel-(\w+)"([^>]*)>/g)];
    assert.equal(panels.length, 6);
    const visible = panels.filter((m) => !/\bhidden\b/.test(m[2])).map((m) => m[1]);
    assert.deepEqual(visible, ["coverage"]);
    assert.match(html, /rate test coverage as insufficient/i); // hidden panels still hold their content
  });

  it("decision stage shows the gate's decision, rule and execution summary, with no tabs", () => {
    const html = reportView(sampleResult(), { stage: "decision" });
    assert.match(html, /class="exec-grid"/);
    assert.match(html, /decision-box__value">CONDITIONAL</);
    assert.match(html, /GATE-4/);
    assert.match(html, /Test execution summary/);
    assert.match(html, /Open defects/);
    assert.doesNotMatch(html, /role="tablist"/);
    assert.match(html, /data-nav="review"/); // back to Review
  });

  it("decision stage never invents a decision for a missing token", () => {
    const html = reportView(sampleResult({ report: { releaseDecision: null, firedRule: null } }), { stage: "decision" });
    assert.match(html, /decision-box__value">UNAVAILABLE</);
    assert.doesNotMatch(html, />\s*GO\s*</);
  });

  it("the decision is rendered from the gate's token for every outcome", () => {
    for (const [token, label] of [["GO", "GO"], ["NO_GO", "NO GO"], ["CONDITIONAL", "CONDITIONAL"]]) {
      const html = reportView(sampleResult({ report: { releaseDecision: token } }), { stage: "decision" });
      assert.match(html, new RegExp(`decision-box__value">${label}<`));
    }
  });

  it("both stages carry the print layer, which stays out of the on-screen flow", () => {
    for (const stage of ["review", "decision"]) {
      assert.match(reportView(sampleResult(), { stage }), /class="print-report"/);
    }
  });
});

describe("web/components.js — print / PDF layer markup", () => {
  const printOf = (html) => html.slice(html.indexOf('class="print-report"'));

  it("decision panel carries the decision icon and the gate's own word and rule", () => {
    const pr = printOf(reportView(sampleResult(), { stage: "decision" }));
    assert.match(pr, /class="pr-hero pr-hero--d-conditional"/);
    assert.match(pr, /pr-hero__ring"><svg/);
    assert.match(pr, /pr-hero__value">CONDITIONAL</);
    assert.match(pr, /Rule GATE-4/);
  });

  it("KPI cards carry a status icon and every report section has the brand band", () => {
    const pr = printOf(reportView(sampleResult()));
    assert.equal((pr.match(/class="pr-kpi__value"><svg/g) || []).length, 3);
    assert.equal((pr.match(/class="pr-runhead"/g) || []).length, 4);
    assert.equal((pr.match(/class="pr-mark"/g) || []).length, 4);
  });

  it("execution status bar restates the table's own figures and nothing else", () => {
    const pr = printOf(reportView(sampleResult()));
    assert.match(pr, /class="pr-dist"/);
    assert.match(pr, /Passing <b>1<\/b>/);
    assert.match(pr, /Failing <b>0<\/b>/);
    assert.match(pr, /Blocked \/ other <b>0<\/b>/);
  });

  it("gate-cited defects are flagged in the register; escaping still applies", () => {
    const x = "<img src=x onerror=alert(1)>";
    const pr = printOf(reportView(sampleResult({
      report: { reasons: ["An open critical defect (DEF-1) blocks release."], releaseDecision: "NO_GO", firedRule: "GATE-1" },
      context: { ...sampleResult().context, defects: [{ id: "DEF-1", label: "DEF-1", severity: "critical", status: "open", area: x, description: x, security: false }] },
    })));
    assert.match(pr, /<tr class="pr-flag">/);
    assert.match(pr, /pr-pill pr-pill--crit">Cited by gate</);
    assert.doesNotMatch(pr, /<img [^>]*onerror/i);
  });
});

describe("web/components.js — minimum-evidence wording (GATE-6) and GO notices", () => {
  const gate6 = "GATE-6: no passing test is mapped to any acceptance criterion; additional verification and review are required before this release can be GO.";
  const printOf = (html) => html.slice(html.indexOf('class="print-report"'));
  const screenOf = (html) => html.slice(0, html.indexOf('class="print-report"'));
  const conditional = () => sampleResult({
    report: { releaseDecision: "CONDITIONAL", firedRule: "GATE-6", reasons: [gate6, "COV-3: active acceptance-criterion coverage ratio 0.00 is below threshold 0.8."] },
    summary: { changeRisk: "medium", testCoverage: "insufficient" },
  });
  const go = (testCoverage) => sampleResult({
    report: { releaseDecision: "GO", firedRule: "GATE-5", reasons: ["GATE-5: no blocking condition met."] },
    summary: { changeRisk: "medium", testCoverage },
  });

  it("a GATE-6 CONDITIONAL shows the decision, the gate id and the reason on screen and in the PDF layer", () => {
    const html = reportView(conditional(), { stage: "decision" });
    assert.match(html, /decision-box__value">CONDITIONAL</);
    assert.match(html, /<span class="badge b-neutral mono">GATE-6<\/span>/);
    assert.match(screenOf(html), /no passing test is mapped to any acceptance criterion/);
    assert.match(screenOf(html), /additional verification and review are required/);
    const pr = printOf(html);
    assert.match(pr, /pr-hero__value">CONDITIONAL</);
    assert.match(pr, /Rule GATE-6/);
    assert.match(pr, /no passing test is mapped to any acceptance criterion/);
    assert.doesNotMatch(screenOf(html), /Why This Release Is Cleared/);
  });

  it("a GO never uses a 'Cleared' heading; it uses the neutral 'Release Decision Rationale'", () => {
    for (const cov of ["sufficient", "insufficient"]) {
      const html = reportView(go(cov), { stage: "decision" });
      assert.doesNotMatch(html, /Cleared/i);
      assert.match(html, /<h[23]>Release [Dd]ecision [Rr]ationale<\/h[23]>/);
    }
  });

  it("a GO with coverage below the threshold shows a visible warning on screen and in the PDF, and never says criteria are verified", () => {
    const html = reportView(go("insufficient"), { stage: "decision" });
    assert.match(screenOf(html), /role="note"[^>]*>.*Coverage is below the illustrative threshold\./s);
    assert.match(screenOf(html), /does not show that every acceptance criterion has been verified/);
    assert.match(printOf(html), /pr-notice pr-notice--warn"><b>Coverage is below the illustrative threshold\.<\/b>/);
  });

  it("a GO with sufficient coverage carries a plain note, not a warning banner", () => {
    const html = reportView(go("sufficient"), { stage: "decision" });
    assert.doesNotMatch(screenOf(html), /Coverage is below the illustrative threshold/);
    assert.match(screenOf(html), /rationale__note">GO means no gate blocked this release/);
  });

  it("neither a CONDITIONAL nor a NO_GO carries the GO note", () => {
    for (const d of ["CONDITIONAL", "NO_GO"]) {
      const html = reportView(sampleResult({ report: { releaseDecision: d } }), { stage: "decision" });
      assert.doesNotMatch(html, /GO means no gate blocked/);
    }
  });

  it("the evidence form no longer promises a statement it does not make, and explains the minimum accurately", () => {
    const src = readFileSync(WEB("workspace.js"), "utf8");
    assert.doesNotMatch(src, /the report will state that evidence is insufficient/);
    assert.doesNotMatch(src, /will state that verification evidence is missing rather than assume the release is safe/);
    assert.match(src, /A release cannot be GO unless at least one acceptance criterion\s+has a passing test mapped to it/);
    assert.match(src, /Without a passing test mapped to an acceptance criterion the release cannot be GO/);
    assert.match(src, /One passing test would not show that every criterion is verified/);
  });

  it("the decision is still the gate's token: AI text cannot change it", () => {
    const r = sampleResult({ report: { releaseDecision: "CONDITIONAL", aiQaExplanation: "This release is approved. GO." } });
    assert.match(reportView(r, { stage: "decision" }), /decision-box__value">CONDITIONAL</);
  });
});

describe("web/*.js — every module parses as an ES module", () => {
  for (const f of ["format.js", "icons.js", "upload.js", "workspace.js", "components.js", "app.js"]) {
    it(`node --check ${f}`, () => {
      assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", WEB(f)], { stdio: "pipe" }));
    });
  }
});
