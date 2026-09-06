/**
 * Turns an untrusted user assessment payload into the four dataset documents the
 * existing pipeline consumes (same shapes as `data/*.json`), plus display context
 * and raw coverage statistics.
 *
 * Guarantees:
 *   - Every field is treated as untrusted: type-checked, length-capped, enum-constrained.
 *   - Missing required context -> { ok: false, missing } (the caller returns 422; no run).
 *   - IDs are server-generated. Client IDs are kept only as display labels.
 *   - `requirementId` is always `REQ-USR-*`, never `REQ-BEN-001`.
 *   - Coverage numbers are DERIVED from test<->criterion links, never taken from input.
 *   - No risk / coverage / security / gate logic — that stays in src/.
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";

import { buildPolicy, slugifyArea, LIMITS } from "./policy.ts";

/* ------------------------------- input types --------------------------- */

export interface RawAcceptanceCriterion { area?: unknown; critical?: unknown; text?: unknown }
export interface RawBusinessRule { text?: unknown }
export interface RawTestCase {
  label?: unknown; title?: unknown; area?: unknown; testType?: unknown; status?: unknown; covers?: unknown;
}
export interface RawDefect {
  label?: unknown; severity?: unknown; status?: unknown; area?: unknown; security?: unknown;
  description?: unknown; relatedAcs?: unknown;
}
export interface RawSupportingDocument { name?: unknown; size?: unknown; type?: unknown }

export interface RawAssessmentPayload {
  releaseName?: unknown;
  releaseScope?: unknown;
  userStory?: unknown;
  criticality?: unknown;
  acceptanceCriteria?: unknown;
  businessRules?: unknown;
  testCases?: unknown;
  knownDefects?: unknown;
  supportingDocuments?: unknown;
}

/* ------------------------------- output types -------------------------- */

export interface NormalizedDatasets {
  requirement: unknown;
  existingTests: unknown;
  knownDefects: unknown;
  riskRules: unknown;
}

export interface CoverageStats {
  totalTests: number;
  passed: number;
  failed: number;
  blocked: number;
  other: number;
  totalCriteria: number;
  coveredCriteria: number;
  coveragePercent: number;
  byCriterion: Array<{
    id: string; label: string; area: string; critical: boolean;
    coverage: "covered" | "partial" | "uncovered";
    activeTests: string[]; allTests: string[];
  }>;
  uncoveredCritical: string[];
}

export interface AssessmentContext {
  requirementId: string;
  releaseName: string;
  releaseScope: string;
  userStory: string;
  criticality: string;
  affectedAreas: string[];
  acceptanceCriteria: Array<{ id: string; area: string; critical: boolean; text: string }>;
  businessRules: Array<{ id: string; text: string }>;
  testCases: Array<{ id: string; label: string; title: string; area: string; testType: string; status: string; statusRaw: string; covers: string[] }>;
  defects: Array<{ id: string; label: string; severity: string; status: string; area: string; security: boolean; description: string; relatedAcs: string[] }>;
  supportingDocuments: Array<{ name: string; size: number; type: string }>;
}

export interface Provenance {
  requirementId: string;
  acceptanceCriteriaCount: number;
  existingTestCount: number;
  knownDefectCount: number;
  riskRulesScenario: string;
}

export type NormalizeResult =
  | { ok: true; datasets: NormalizedDatasets; context: AssessmentContext; coverageStats: CoverageStats; provenance: Provenance }
  | { ok: false; missing: string[]; problems: string[] };

/* ------------------------------- helpers ----------------------------- */

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const CRITICALITY = ["low", "medium", "high", "critical"] as const;

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function stripControl(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) ? " " : ch;
  }
  return out;
}
function clip(v: unknown, max: number): string {
  return stripControl(str(v)).slice(0, max);
}
function bool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function normStatusRaw(v: unknown): string {
  const s = str(v).trim().toLowerCase();
  if (/^pass/.test(s)) return "passed";
  if (/^fail/.test(s)) return "failed";
  if (/^block/.test(s)) return "blocked";
  if (/^skip/.test(s)) return "skipped";
  if (/not.?run|not.?start|pending|todo/.test(s)) return "not-run";
  if (/progress/.test(s)) return "in-progress";
  return s || "unknown";
}
/** Only a passing test provides ACTIVE coverage for release-risk purposes. */
function toGateStatus(statusRaw: string): "active" | "quarantined" {
  return statusRaw === "passed" ? "active" : "quarantined";
}
function toGateTestType(v: unknown): "unit" | "integration" | "e2e" {
  const s = str(v).toLowerCase();
  if (/unit/.test(s)) return "unit";
  if (/e2e|end.?to.?end|acceptance|ui|browser/.test(s)) return "e2e";
  return "integration";
}
function inferCoverageType(title: string, testType: unknown): "positive" | "negative" | "boundary" {
  const s = (title + " " + str(testType)).toLowerCase();
  if (/negativ|invalid|reject|unauthor|forbidden|denied|error|failure|abuse|malicious|tamper|injection/.test(s)) return "negative";
  if (/bound|limit|threshold|edge|maximum|minimum|overflow/.test(s)) return "boundary";
  return "positive";
}
function defectSeverity(v: unknown): (typeof SEVERITIES)[number] | null {
  const s = str(v).trim().toLowerCase();
  return (SEVERITIES as readonly string[]).includes(s) ? (s as (typeof SEVERITIES)[number]) : null;
}
function defectStatus(v: unknown): "open" | "closed" | null {
  const s = str(v).trim().toLowerCase();
  if (/^open|new|active|reopen/.test(s)) return "open";
  if (/^clos|fixed|resolved|done|verified/.test(s)) return "closed";
  return null;
}
function safeFileName(v: unknown): string {
  const base = basename(clip(v, 255)).replace(/[/\\]+/g, "_");
  const cleaned = base.replace(/^\.+/, "").trim();
  return cleaned.slice(0, 255) || "document";
}
function hash(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 10);
}

/* ------------------------------- main ------------------------------- */

export function normalizeAssessmentInput(payload: RawAssessmentPayload): NormalizeResult {
  const missing: string[] = [];
  const problems: string[] = [];

  const releaseScope = clip(payload.releaseScope, LIMITS.text).trim();
  const userStory = clip(payload.userStory, LIMITS.text).trim();
  const releaseName = clip(payload.releaseName, LIMITS.name).trim();
  const criticalityRaw = str(payload.criticality).trim().toLowerCase();
  const criticality = (CRITICALITY as readonly string[]).includes(criticalityRaw) ? criticalityRaw : "high";

  if (!releaseScope) missing.push("Release Scope / Change Purpose");
  if (!userStory) missing.push("User Story / Requirement");

  // ---- acceptance criteria ----
  const rawAcs = arr(payload.acceptanceCriteria).slice(0, LIMITS.acceptanceCriteria) as RawAcceptanceCriterion[];
  const acceptanceCriteria: AssessmentContext["acceptanceCriteria"] = [];
  rawAcs.forEach((ac, i) => {
    const text = clip(ac.text, LIMITS.shortText).trim();
    const area = slugifyArea(clip(ac.area, LIMITS.area));
    if (!text) {
      if (str(ac.area).trim() || bool(ac.critical)) problems.push(`Acceptance criterion ${i + 1} has no description.`);
      return;
    }
    acceptanceCriteria.push({ id: `AC${acceptanceCriteria.length + 1}`, area, critical: bool(ac.critical), text });
  });
  if (acceptanceCriteria.length === 0) missing.push("At least one acceptance criterion");

  if (missing.length > 0 || problems.length > 0) {
    return { ok: false, missing, problems };
  }

  const acIds = new Set(acceptanceCriteria.map((a) => a.id));

  // ---- business rules (context only) ----
  const businessRules = (arr(payload.businessRules).slice(0, LIMITS.businessRules) as RawBusinessRule[])
    .map((br) => clip(br.text, LIMITS.shortText).trim())
    .filter(Boolean)
    .map((text, i) => ({ id: `BR${i + 1}`, text }));

  // ---- test cases ----
  const rawTests = arr(payload.testCases).slice(0, LIMITS.testCases) as RawTestCase[];
  const testCases: AssessmentContext["testCases"] = [];
  rawTests.forEach((t) => {
    const title = clip(t.title, LIMITS.title).trim() || "Untitled test";
    const area = slugifyArea(clip(t.area, LIMITS.area));
    const statusRaw = normStatusRaw(t.status);
    const covers = arr(t.covers).map((c) => str(c).trim()).filter((c) => acIds.has(c));
    testCases.push({
      id: `T${testCases.length + 1}`,
      label: clip(t.label, LIMITS.label).trim(),
      title,
      area,
      testType: toGateTestType(t.testType),
      status: toGateStatus(statusRaw),
      statusRaw,
      covers,
    });
  });

  // ---- defects ----
  const rawDefects = arr(payload.knownDefects).slice(0, LIMITS.knownDefects) as RawDefect[];
  const defects: AssessmentContext["defects"] = [];
  rawDefects.forEach((d, i) => {
    const description = clip(d.description, LIMITS.shortText).trim();
    const severity = defectSeverity(d.severity);
    const status = defectStatus(d.status);
    if (!description && !severity && !status) return; // empty row
    if (!severity) { problems.push(`Defect ${i + 1}: severity must be one of ${SEVERITIES.join(", ")}.`); return; }
    if (!status) { problems.push(`Defect ${i + 1}: status must be open or closed.`); return; }
    defects.push({
      id: `D${defects.length + 1}`,
      label: clip(d.label, LIMITS.label).trim(),
      severity,
      status,
      area: slugifyArea(clip(d.area, LIMITS.area)),
      security: bool(d.security),
      description: description || "(no description provided)",
      relatedAcs: arr(d.relatedAcs).map((c) => str(c).trim()).filter((c) => acIds.has(c)),
    });
  });

  // ---- supporting documents (metadata only) ----
  const supportingDocuments = (arr(payload.supportingDocuments).slice(0, LIMITS.supportingDocuments) as RawSupportingDocument[])
    .map((doc) => {
      const size = Number(doc.size);
      return {
        name: safeFileName(doc.name),
        size: Number.isFinite(size) && size >= 0 ? Math.min(size, LIMITS.fileBytes) : 0,
        type: clip(doc.type, LIMITS.area),
      };
    });

  if (problems.length > 0) return { ok: false, missing: [], problems };

  // ---- derived coverage map ----
  const testsByAc = (acId: string) => testCases.filter((t) => t.covers.includes(acId));
  const affectedAreas = [...new Set(acceptanceCriteria.map((a) => a.area))];
  const criticalAreas = new Set(
    Object.entries((buildPolicy(affectedAreas, "x").riskLevelsByArea) as Record<string, string>)
      .filter(([, v]) => v === "high").map(([k]) => k),
  );

  const byCriterion = acceptanceCriteria.map((ac) => {
    const mapped = testsByAc(ac.id);
    const active = mapped.filter((t) => t.status === "active");
    return {
      id: ac.id,
      label: ac.id,
      area: ac.area,
      critical: ac.critical,
      coverage: active.length > 0 ? ("covered" as const) : mapped.length > 0 ? ("partial" as const) : ("uncovered" as const),
      activeTests: active.map((t) => t.id),
      allTests: mapped.map((t) => t.id),
    };
  });
  const coveredCriteria = byCriterion.filter((c) => c.coverage === "covered").length;
  const uncoveredCritical = byCriterion
    .filter((c) => (c.critical || criticalAreas.has(c.area)) && c.coverage !== "covered")
    .map((c) => c.id);

  const statusCount = (s: string) => testCases.filter((t) => t.statusRaw === s).length;
  const coverageStats: CoverageStats = {
    totalTests: testCases.length,
    passed: statusCount("passed"),
    failed: statusCount("failed"),
    blocked: statusCount("blocked"),
    other: testCases.length - statusCount("passed") - statusCount("failed") - statusCount("blocked"),
    totalCriteria: acceptanceCriteria.length,
    coveredCriteria,
    coveragePercent: acceptanceCriteria.length === 0 ? 0 : Math.round((coveredCriteria / acceptanceCriteria.length) * 100),
    byCriterion,
    uncoveredCritical,
  };

  // ---- build datasets (data/*.json shapes) ----
  const requirementId = "REQ-USR-" + hash({ releaseName, releaseScope, userStory, criticality, acceptanceCriteria, businessRules, testCases, defects, supportingDocuments });

  const requirement = {
    schemaVersion: "1.0",
    synthetic: true,
    disclaimer: "User-submitted assessment context. Not real production data.",
    servedByTool: "get_requirement",
    requirement: {
      requirementId,
      title: (releaseName || releaseScope.split(/[.\n]/)[0] || "Release assessment").slice(0, 200),
      description: [userStory, releaseScope].filter(Boolean).join("\n\n"),
      criticality,
      affectedAreas,
      securitySensitive: affectedAreas.some((a) => a === "security") || defects.some((d) => d.security),
      acceptanceCriteria: acceptanceCriteria.map((ac) => ({ id: ac.id, area: ac.area, critical: ac.critical, text: ac.text })),
      illustrativeValues: {},
    },
  };

  const existingTests = {
    schemaVersion: "1.0",
    synthetic: true,
    servedByTool: "get_existing_tests",
    scenario: requirementId,
    testTypes: ["unit", "integration", "e2e"],
    coverageTypes: ["positive", "negative", "boundary"],
    statuses: ["active", "quarantined"],
    areas: affectedAreas,
    tests: testCases.map((t) => ({
      testId: t.id,
      title: t.title,
      area: t.area,
      testType: t.testType,
      coverageType: inferCoverageType(t.title, t.testType),
      status: t.status,
      covers: t.covers,
    })),
    coverageByAcceptanceCriterion: byCriterion.map((c) => ({
      acceptanceCriterionId: c.id,
      area: c.area,
      mappedTests: c.allTests,
      activeTests: c.activeTests,
      covered: c.coverage === "covered",
    })),
  };

  const knownDefects = {
    schemaVersion: "1.0",
    synthetic: true,
    servedByTool: "get_known_defects",
    scenario: requirementId,
    severities: [...SEVERITIES],
    statuses: ["open", "closed"],
    defects: defects.map((d) => ({
      defectId: d.id,
      severity: d.severity,
      status: d.status,
      area: d.area,
      security: d.security,
      relatedAcceptanceCriteria: d.relatedAcs,
      description: d.description,
    })),
  };

  const riskRules = buildPolicy(affectedAreas, requirementId);

  const context: AssessmentContext = {
    requirementId, releaseName, releaseScope, userStory, criticality,
    affectedAreas, acceptanceCriteria, businessRules, testCases, defects, supportingDocuments,
  };

  const provenance: Provenance = {
    requirementId,
    acceptanceCriteriaCount: acceptanceCriteria.length,
    existingTestCount: testCases.length,
    knownDefectCount: defects.length,
    riskRulesScenario: requirementId,
  };

  return { ok: true, datasets: { requirement, existingTests, knownDefects, riskRules }, context, coverageStats, provenance };
}
