/**
 * Phase 1 — user input model + validation.
 *
 * Verifies the normalizer turns an untrusted payload into the exact dataset
 * shapes the existing pipeline consumes, derives coverage, fails safe on missing
 * context, and cannot produce REQ-BEN-001 or influence the gate rules.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeAssessmentInput } from "../api/inputNormalizer.ts";
import { adaptAgentFindingsToReleaseFindings } from "../src/findingsAdapter.ts";
import { evaluateReleaseGate, validateFindings } from "../src/releaseGate.ts";
import type { AgentFindings } from "../src/agentContract.ts";

/* ------------------------- a representative payload --------------------- */

function coachingPayload() {
  return {
    releaseName: "Release 2026.09",
    releaseScope:
      "Release 2026.09 introduces an AI communication assessment capability that evaluates learner conversations using transcript analysis, retrieved coaching guidance, and certification criteria.",
    userStory:
      "As a learner using an AI communication coaching platform, I want to complete a simulated conversation with an AI avatar and receive an evidence based assessment of my communication skills.",
    criticality: "critical",
    acceptanceCriteria: [
      { area: "Conversation", critical: true, text: "Learner can start and complete an AI avatar coaching session." },
      { area: "AI Assessment", critical: true, text: "The platform evaluates the conversation transcript against defined communication criteria." },
      { area: "RAG", critical: false, text: "The assessment engine retrieves relevant coaching guidance from the approved knowledge base." },
      { area: "Certification", critical: true, text: "The platform determines whether the learner meets the defined certification threshold." },
      { area: "Feedback", critical: true, text: "The platform generates personalized feedback based on the assessment results." },
      { area: "Security", critical: true, text: "Learner conversation data is protected from unauthorized access." },
    ],
    businessRules: [
      { text: "Certification requires a minimum score of 80%." },
      { text: "Security related failures must block certification." },
    ],
    testCases: [
      { label: "TC001", title: "Start coaching session", area: "Conversation", testType: "Functional", status: "Passed", covers: ["AC1"] },
      { label: "TC002", title: "Evaluate transcript", area: "AI Assessment", testType: "Functional", status: "Passed", covers: ["AC2"] },
      { label: "TC003", title: "Validate RAG retrieval", area: "RAG", testType: "Functional", status: "Passed", covers: ["AC3"] },
      { label: "TC004", title: "Certification threshold", area: "Certification", testType: "Functional", status: "Passed", covers: ["AC4"] },
      { label: "TC005", title: "Personalized feedback", area: "Feedback", testType: "Functional", status: "Passed", covers: ["AC5"] },
      { label: "TC006", title: "Unauthorized transcript access", area: "Security", testType: "Security", status: "Failed", covers: ["AC6"] },
    ],
    knownDefects: [
      { label: "DEF001", severity: "High", status: "Open", area: "AI Assessment", security: false, description: "Incorrect scoring under certain transcript conditions.", relatedAcs: ["AC2"] },
      { label: "DEF002", severity: "Critical", status: "Open", area: "Security", security: true, description: "Unauthorized access to learner conversation transcript.", relatedAcs: ["AC6"] },
      { label: "DEF003", severity: "Medium", status: "Open", area: "Feedback", security: false, description: "Feedback can omit an identified communication weakness.", relatedAcs: ["AC5"] },
    ],
    supportingDocuments: [{ name: "BRD.pdf", size: 1024, type: "application/pdf" }],
  };
}

/** Build a grounded AgentFindings from normalized datasets (mirrors the offline analyzer). */
function findingsFor(datasets: any): AgentFindings {
  const req = datasets.requirement.requirement;
  const cov = datasets.existingTests.coverageByAcceptanceCriterion;
  const defs = datasets.knownDefects.defects;
  return {
    schemaVersion: 1,
    changeSummary: "summary",
    identifiedRisks: [{ area: req.acceptanceCriteria[0].area, description: "risk", severity: "high" }],
    coverageAssessment: cov.map((c: any) => ({ acceptanceCriterionId: c.acceptanceCriterionId, covered: c.covered, notes: "" })),
    missingScenarios: [],
    defectReview: defs.map((d: any) => ({ defectId: d.defectId, stillRelevant: d.status === "open", notes: "" })),
    regressionPriorities: [{ area: req.acceptanceCriteria[0].area, priority: "high", rationale: "r" }],
    releaseRiskExplanation: "explanation",
    dataProvenance: {
      requirementId: req.requirementId,
      acceptanceCriteriaCount: req.acceptanceCriteria.length,
      existingTestCount: datasets.existingTests.tests.length,
      knownDefectCount: defs.length,
      riskRulesScenario: datasets.riskRules.scenario,
    },
  };
}

/* -------------------------------------------------------------------------- */

describe("normalizeAssessmentInput — dataset shapes", () => {
  it("produces a REQ-USR requirement (never REQ-BEN-001) with slugified ids and areas", () => {
    const r = normalizeAssessmentInput(coachingPayload());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const req = (r.datasets.requirement as any).requirement;
    assert.match(req.requirementId, /^REQ-USR-[0-9a-f]{10}$/);
    assert.notEqual(req.requirementId, "REQ-BEN-001");
    assert.deepEqual(req.acceptanceCriteria.map((a: any) => a.id), ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6"]);
    assert.deepEqual(req.acceptanceCriteria.map((a: any) => a.area), ["conversation", "ai-assessment", "rag", "certification", "feedback", "security"]);
    assert.equal(req.securitySensitive, true);
    // every affected area has a policy risk level
    const rr = r.datasets.riskRules as any;
    for (const a of req.affectedAreas) assert.ok(a in rr.riskLevelsByArea, `${a} missing from policy`);
    assert.equal(rr.riskLevelsByArea["security"], "high");
    assert.equal(rr.scenario, req.requirementId);
  });

  it("derives coverage from test<->criterion links (not from any input number)", () => {
    const r = normalizeAssessmentInput(coachingPayload());
    if (!r.ok) throw new Error("expected ok");
    const s = r.coverageStats;
    assert.equal(s.totalTests, 6);
    assert.equal(s.passed, 5);
    assert.equal(s.failed, 1);
    assert.equal(s.coveredCriteria, 5); // AC6's only test failed -> not active
    assert.equal(s.coveragePercent, 83);
    assert.deepEqual(s.uncoveredCritical, ["AC6"]);
    const ac6 = s.byCriterion.find((c) => c.id === "AC6")!;
    assert.equal(ac6.coverage, "partial"); // has a mapped test, but no active one
  });

  it("the built datasets pass the unchanged Phase 3 validateFindings via the adapter", () => {
    const r = normalizeAssessmentInput(coachingPayload());
    if (!r.ok) throw new Error("expected ok");
    const adapted = adaptAgentFindingsToReleaseFindings(findingsFor(r.datasets), r.datasets);
    assert.equal(adapted.ok, true);
    if (!adapted.ok) return;
    assert.equal(validateFindings(adapted.releaseFindings).ok, true);
  });

  it("the deterministic gate decides from the normalized evidence (open critical defect -> GATE-1)", () => {
    const r = normalizeAssessmentInput(coachingPayload());
    if (!r.ok) throw new Error("expected ok");
    const adapted = adaptAgentFindingsToReleaseFindings(findingsFor(r.datasets), r.datasets);
    if (!adapted.ok) throw new Error(adapted.problems.join("; "));
    const g = evaluateReleaseGate(adapted.releaseFindings);
    assert.equal(g.decision, "NO_GO");
    assert.equal(g.firedRule, "GATE-1"); // DEF002 critical + open
  });

  it("without the critical defect, an uncovered security criterion -> GATE-2", () => {
    const p = coachingPayload();
    p.knownDefects = p.knownDefects.filter((d) => d.severity !== "Critical");
    const r = normalizeAssessmentInput(p);
    if (!r.ok) throw new Error("expected ok");
    const adapted = adaptAgentFindingsToReleaseFindings(findingsFor(r.datasets), r.datasets);
    if (!adapted.ok) throw new Error(adapted.problems.join("; "));
    const g = evaluateReleaseGate(adapted.releaseFindings);
    assert.equal(g.decision, "NO_GO");
    assert.equal(g.firedRule, "GATE-2");
    assert.match(g.reasons.join(" "), /AC6/);
  });
});

describe("normalizeAssessmentInput — completeness gate (fail safe, no run)", () => {
  it("missing release scope -> not ok", () => {
    const p = coachingPayload(); (p as any).releaseScope = "   ";
    const r = normalizeAssessmentInput(p);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.missing.includes("Release Scope / Change Purpose"));
  });
  it("missing user story -> not ok", () => {
    const p = coachingPayload(); (p as any).userStory = "";
    const r = normalizeAssessmentInput(p);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.missing.includes("User Story / Requirement"));
  });
  it("zero acceptance criteria -> not ok", () => {
    const p = coachingPayload(); p.acceptanceCriteria = [];
    const r = normalizeAssessmentInput(p);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.missing.includes("At least one acceptance criterion"));
  });
  it("unknown defect severity -> not ok (problem, not silent default)", () => {
    const p = coachingPayload();
    p.knownDefects[0].severity = "catastrophic";
    const r = normalizeAssessmentInput(p);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.problems.join(" "), /severity/i);
  });
});

describe("normalizeAssessmentInput — untrusted input is treated as plain data", () => {
  it("script / SQL / path-traversal strings pass through as inert text", () => {
    const p = coachingPayload();
    p.acceptanceCriteria[0].text = "<script>alert('xss')</script>'; DROP TABLE users;-- ../../etc/passwd";
    const r = normalizeAssessmentInput(p);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const stored = (r.datasets.requirement as any).requirement.acceptanceCriteria[0].text as string;
    assert.ok(stored.includes("DROP TABLE"));           // kept verbatim as data
    assert.ok(stored.includes("../../etc/passwd"));      // not resolved
    // still a valid dataset for the pipeline
    const adapted = adaptAgentFindingsToReleaseFindings(findingsFor(r.datasets), r.datasets);
    assert.equal(adapted.ok, true);
  });

  it("oversized text is capped", () => {
    const p = coachingPayload();
    (p as any).releaseScope = "x".repeat(60_000);
    const r = normalizeAssessmentInput(p);
    if (!r.ok) throw new Error("expected ok");
    assert.ok((r.datasets.requirement as any).requirement.description.length <= 20_000 + p.userStory.length + 4);
  });

  it("malicious supporting-document filenames are reduced to a basename", () => {
    const p = coachingPayload();
    p.supportingDocuments = [
      { name: "../../secret.txt", size: 10, type: "text/plain" },
      { name: "..\\..\\win.ini", size: 10, type: "text/plain" },
    ];
    const r = normalizeAssessmentInput(p);
    if (!r.ok) throw new Error("expected ok");
    assert.deepEqual(r.datasets ? (r as any).context.supportingDocuments.map((d: any) => d.name) : [], ["secret.txt", "win.ini"]);
  });

  it("client-supplied test.covers referencing an unknown criterion id is dropped", () => {
    const p = coachingPayload();
    p.testCases[0].covers = ["AC1", "AC99", "DROP"];
    const r = normalizeAssessmentInput(p);
    if (!r.ok) throw new Error("expected ok");
    assert.deepEqual((r.datasets.existingTests as any).tests[0].covers, ["AC1"]);
  });
});

describe("normalizeAssessmentInput — determinism", () => {
  it("same payload -> same requirementId; different payload -> different id", () => {
    const a = normalizeAssessmentInput(coachingPayload());
    const b = normalizeAssessmentInput(coachingPayload());
    const p = coachingPayload(); p.releaseName = "Different";
    const c = normalizeAssessmentInput(p);
    if (!a.ok || !b.ok || !c.ok) throw new Error("expected ok");
    assert.equal((a.datasets.requirement as any).requirement.requirementId, (b.datasets.requirement as any).requirement.requirementId);
    assert.notEqual((a.datasets.requirement as any).requirement.requirementId, (c.datasets.requirement as any).requirement.requirementId);
  });
});
