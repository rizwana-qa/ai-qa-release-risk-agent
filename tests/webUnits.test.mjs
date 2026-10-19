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

import { esc, attr, decisionLabel, decisionClass, headingCase } from "../web/format.js";
import { qualityGatesView } from "../web/gates.js";
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
    assert.match(html, /Security Checks \(Deterministic QA Rules\)/);
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
    assert.match(html, /Test Execution Summary/);
    assert.match(html, /Open Defects/);
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

describe("web/components.js — decision dashboard blocks", () => {
  const decision = (over) => reportView(sampleResult(over), { stage: "decision" });
  const digits = (html, re) => Number((html.match(re) || [])[1]);

  it("renders the metric strip with the coverage statistics as returned", () => {
    const html = decision();
    assert.match(html, /class="kstrip"/);
    assert.equal(digits(html, /kstat__l">Total Tests<\/span><b class="kstat__v">(\d+)</), 1);
    assert.equal(digits(html, /kstat__l">Passed<\/span><b class="kstat__v">(\d+)</), 1);
  });

  it("shows an em dash, not zero, when coverage statistics are missing", () => {
    const html = decision({ coverageStats: null });
    assert.match(html, /kstat__l">Total Tests<\/span><b class="kstat__v">—</);
  });

  it("donut total equals the sum of the legend counts and the register rows", () => {
    const html = decision({ report: { regressionPriorities: [{ area: "a", priority: "high", rationale: "r" }, { area: "b", priority: "low", rationale: "r" }] } });
    const legend = [...html.matchAll(/donut__sw[^>]*><\/span><span>[^<]+<\/span><b>(\d+)<\/b>/g)].map((m) => Number(m[1]));
    const total = legend.reduce((a, b) => a + b, 0);
    assert.ok(total >= 3);
    assert.match(html, new RegExp(`class="donut__n"[^>]*>${total}<`));
    assert.match(html, new RegExp(`${total} signals`));
  });

  it("omits the donut and says so when there are no risk signals", () => {
    const html = decision({ report: { identifiedRisks: [], regressionPriorities: [], defectReview: [] } });
    assert.match(html, /No specific risk signals were identified/);
    assert.doesNotMatch(html, /class="donut__svg"/);
  });

  it("labels the AI assessment advisory and never presents it as the decision", () => {
    const html = decision();
    assert.match(html, /callout--ai/);
    assert.match(html, /lane lane--ai">Advisory</);
  });

  it("print page 1 carries the metrics strip, risk summary and change description", () => {
    const html = decision();
    assert.match(html, /class="pr-mstrip"/);
    assert.match(html, /class="pr-donut__svg"/);
    assert.match(html, /Change Under Assessment/);
  });
});

describe("web/components.js — evidence line and provenance labels", () => {
  it("restates the evidence counts from the report's own data", () => {
    const html = reportView(sampleResult(), { stage: "decision" });
    assert.match(html, /Evidence analyzed:<\/b> 1 acceptance criterion · 1 test case · 0 known defects · 0 supporting documents/);
  });

  it("pluralises and follows the data, not a fixed sample", () => {
    const r = sampleResult();
    r.coverageStats = { ...r.coverageStats, totalCriteria: 8, totalTests: 11 };
    r.context = { ...r.context, defects: [{ id: "D1", severity: "low", status: "open", area: "x", description: "d" }, { id: "D2", severity: "low", status: "closed", area: "x", description: "d" }], supportingDocuments: [{ name: "a.pdf" }] };
    const html = reportView(r, { stage: "review" });
    assert.match(html, /8 acceptance criteria · 11 test cases · 2 known defects · 1 supporting document</);
  });

  it("labels supplied evidence, advisory content and the deterministic gate separately", () => {
    const html = reportView(sampleResult(), { stage: "decision" });
    assert.equal((html.match(/lane lane--ev">Supplied evidence</g) || []).length, 2);
    assert.match(html, /lane lane--ai">Advisory</);
    assert.match(html, /lane lane--gate">Deterministic gate</);
  });

  it("executive summary heading is an h2 under the h1 (no skipped heading level)", () => {
    const html = reportView(sampleResult(), { stage: "decision" });
    assert.match(html, /<h2>Why This Release Is Conditional<\/h2>/);
    assert.doesNotMatch(html, /<h3>Why This Release/);
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

describe("web/components.js — print layer wording never softens a decision", () => {
  const printOf = (html) => html.slice(html.indexOf('class="print-report"'));
  const withDecision = (token, rule, reasons) => sampleResult({ report: { releaseDecision: token, firedRule: rule, reasons } });

  it("labels the gate's reasons by outcome, with a matching marker colour", () => {
    const go = printOf(reportView(withDecision("GO", "GATE-5", ["GATE-5: no blocking condition met."])));
    assert.match(go, /<h2 class="pr-h2">Gate Checks<\/h2>\s*<ol class="pr-list pr-list--ok">/);
    assert.match(go, /Applied Deterministic Rules/);
    assert.doesNotMatch(go, /Top Release Blockers|Failed Deterministic Rules/);
    const cond = printOf(reportView(withDecision("CONDITIONAL", "GATE-4", ["GATE-4: change risk level is 'high'."])));
    assert.match(cond, /Conditions &amp; Unresolved Items<\/h2>\s*<ol class="pr-list pr-list--warn">/);
    assert.match(cond, /Failed Deterministic Rules/);
    const nogo = printOf(reportView(withDecision("NO_GO", "GATE-2", ["GATE-2: security failure."])));
    assert.match(nogo, /Top Release Blockers<\/h2>\s*<ol class="pr-list pr-list--crit">/);
  });

  it("an unavailable decision is never described as having no blocking reasons", () => {
    const r = withDecision(null, null, []);
    const pdf = printOf(reportView(r));
    assert.match(pdf, /The pipeline did not return a valid release decision\./);
    assert.match(pdf, /No valid release decision was returned/);
    assert.doesNotMatch(pdf, /reported no blocking reasons/);
    const web = reportView(r, { stage: "decision" });
    assert.match(web, /rationale__lead">The pipeline did not return a valid release decision\./);
  });
});

describe("web/components.js — PDF defects chart, methodology, time zone", () => {
  const printOf = (html) => html.slice(html.indexOf('class="print-report"'));
  const defects = [
    { id: "D1", label: "D1", severity: "high", status: "open", security: true, area: "a", description: "x" },
    { id: "D2", label: "D2", severity: "low", status: "open", security: false, area: "a", description: "x" },
    { id: "D3", label: "D3", severity: "critical", status: "closed", security: false, area: "a", description: "x" },
  ];

  it("counts open defects by severity from the supplied defects only", () => {
    const pdf = printOf(reportView(sampleResult({ context: { ...sampleResult().context, defects } })));
    assert.match(pdf, /Critical <b>0<\/b>/); // the critical defect is closed
    assert.match(pdf, /High <b>1<\/b>/);
    assert.match(pdf, /Low <b>1<\/b>/);
    assert.match(pdf, /2 open of 3 supplied defects; 1 security-flagged\./);
  });

  it("says so plainly when no defects were supplied", () => {
    assert.match(printOf(reportView(sampleResult())), /No known defects were supplied\./);
  });

  it("numbers the pipeline stages that actually ran", () => {
    const pdf = printOf(reportView(sampleResult({ meta: { pipelineStages: ["Retrieve QA data (MCP)", "AI QA analysis"], evaluationOrder: [], mcpTools: [] } })));
    assert.match(pdf, /class="pr-steps"><li><b>01<\/b><span>Retrieve QA data \(MCP\)<\/span><\/li><li><b>02<\/b><span>AI QA analysis<\/span>/);
  });

  it("stamps the generation time with an explicit UTC offset and carries the confidentiality tag", () => {
    const pdf = printOf(reportView(sampleResult()));
    assert.match(pdf, /Generated \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC[+-]\d{2}:\d{2}/);
    assert.equal((pdf.match(/class="pr-conf">Confidential</g) || []).length, 4);
  });

  it("contains no development artifacts", () => {
    // The inline SVGs' xmlns attribute is a namespace, not content; everything else must be free of dev artifacts.
    const pdf = printOf(reportView(sampleResult())).replace(/xmlns="[^"]*"/g, "");
    assert.doesNotMatch(pdf, /localhost|127\.0\.0\.1|https?:\/\/|\bundefined\b|\bNaN\b|\[object/);
  });
});

describe("web/format.js — headingCase", () => {
  it("capitalises every word and lower-cases the rest", () => {
    assert.equal(headingCase("release decision"), "Release Decision");
    assert.equal(headingCase("SPRINT HEALTH"), "Sprint Health");
    assert.equal(headingCase("quality GATES"), "Quality Gates");
    assert.equal(headingCase("EXECUTIVE SUMMARY"), "Executive Summary");
    assert.equal(headingCase("no-go release decision"), "No-Go Release Decision");
  });
  it("keeps approved acronyms, decision labels and identifiers", () => {
    assert.equal(headingCase("AI QA API PDF UI UX summary"), "AI QA API PDF UI UX Summary");
    assert.equal(headingCase("NO-GO and GO"), "NO-GO And GO");
    assert.equal(headingCase("GATE-4 findings for REQ-BEN-001"), "GATE-4 Findings For REQ-BEN-001");
    assert.equal(headingCase("evaluateReleaseGate() result"), "evaluateReleaseGate() Result");
  });
  it("handles punctuation, entities, slashes and empty input", () => {
    assert.equal(headingCase("Risk signals &amp; open defects"), "Risk Signals &amp; Open Defects");
    assert.equal(headingCase("Missing / incomplete evidence"), "Missing / Incomplete Evidence");
    assert.equal(headingCase("coverage checks (deterministic QA rules)"), "Coverage Checks (Deterministic QA Rules)");
    assert.equal(headingCase("why is this risky?"), "Why Is This Risky?");
    assert.equal(headingCase(""), "");
    assert.equal(headingCase(null), "");
  });
  it("is idempotent", () => {
    const once = headingCase("open defects by severity");
    assert.equal(headingCase(once), once);
  });
});

describe("web/components.js — headings follow the capitalisation convention", () => {
  const headingTexts = (html) => [...html.matchAll(/<h([2-6])[^>]*>([\s\S]*?)<\/h\1>/g)]
    .map((m) => m[2].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()).filter(Boolean);

  it("every section heading on both report screens and in the PDF layer is already heading-cased", () => {
    for (const decision of ["GO", "NO_GO", "CONDITIONAL"]) {
      for (const stage of ["review", "decision"]) {
        const html = reportView(sampleResult({ report: { releaseDecision: decision } }), { stage });
        const bad = headingTexts(html).filter((t) => headingCase(t.replace(/&/g, "&amp;")).replace(/&amp;/g, "&") !== t);
        assert.deepEqual(bad, [], `${decision}/${stage}`);
      }
    }
  });

  it("does not rewrite user-entered text inside headings", () => {
    const html = reportView(sampleResult({ context: { ...sampleResult().context, releaseName: "my CHECKOUT release v2" } }), { stage: "decision" });
    assert.match(html, /<h1 id="page-h"[^>]*>my CHECKOUT release v2<\/h1>/);
  });
});

describe("web/gates.js — Quality Gates page", () => {
  const doc = {
    decisions: ["GO", "NO_GO", "CONDITIONAL"], evaluationOrder: ["GATE-1"], evaluationNote: "n",
    gates: [{ id: "GATE-1", title: "critical defect open", condition: "<img src=x onerror=alert(1)>", decision: "NO_GO", purpose: "p", evidence: ["e"], riskRelationship: "r", consequence: "c", source: "s" }],
    failSafe: { id: "FAIL_SAFE", decision: "NO_GO", condition: "c", source: "s" },
    coverageRule: { description: "d", conditions: [{ id: "COV-3", text: "t", threshold: 0.8 }] },
    securityRule: { description: "d", conditions: [{ id: "SEC-1", text: "t" }] },
    flow: [{ label: "Evidence", text: "t" }], riskDerivation: [{ label: "l", text: "t", source: "s" }],
    evidenceSources: [{ label: "l", text: "t" }], limitations: ["x"],
  };
  const html = qualityGatesView(doc);
  it("renders a single h1 and heading-cased section headings", () => {
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    assert.match(html, /<h1[^>]*>Quality Gates<\/h1>/);
    assert.match(html, /<h3 id="qg-GATE-1">Critical Defect Open<\/h3>/);
    assert.match(html, /Evaluation And Decision Flow/);
  });
  it("escapes gate text instead of rendering it as HTML", () => {
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x/);
  });
  it("shows the real threshold and labels the fail-safe", () => {
    assert.match(html, /Threshold: 0\.8 \(illustrative\)/);
    assert.match(html, /FAIL_SAFE/);
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
      assert.match(html, /<h2>Release Decision Rationale<\/h2>/);
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
