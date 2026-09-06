/**
 * Scenario data assembly for the demo API.
 *
 * PRESENTATION SUPPORT ONLY. This module reads the synthetic dataset via the
 * existing `loadDataset()` and reshapes it for the browser. It performs no risk,
 * coverage, security, or decision computation of any kind.
 */

import { loadDataset } from "../src/dataLoader.ts";

export interface ScenarioSummary {
  id: string;
  title: string;
  summary: string;
}

/** The one synthetic scenario. The selector is functional but this list is fixed. */
export const SCENARIOS: readonly ScenarioSummary[] = [
  {
    id: "REQ-BEN-001",
    title:
      "Add a beneficiary and allow an authenticated customer to transfer money to the beneficiary after authentication",
    summary: "Add a beneficiary and allow an authenticated customer to transfer money to the beneficiary.",
  },
];

export interface AcceptanceCriterionView {
  id: string;
  area: string;
  critical: boolean;
  text: string;
}
export interface TestView {
  testId: string;
  title: string;
  area: string;
  testType: string;
  coverageType: string;
  status: string;
  covers: string[];
  note?: string;
}
export interface CoverageMapView {
  acceptanceCriterionId: string;
  area: string;
  mappedTests: string[];
  activeTests: string[];
  covered: boolean;
}
export interface DefectView {
  defectId: string;
  severity: string;
  status: string;
  area: string;
  security: boolean;
  relatedAcceptanceCriteria: string[];
  description: string;
}

export interface ScenarioData {
  id: string;
  synthetic: true;
  requirement: {
    requirementId: string;
    title: string;
    description: string;
    criticality: string;
    securitySensitive: boolean;
    affectedAreas: string[];
    illustrativeValues: unknown;
  };
  acceptanceCriteria: AcceptanceCriterionView[];
  tests: TestView[];
  coverageMap: CoverageMapView[];
  defects: DefectView[];
  riskRules: {
    riskLevelsByArea: Record<string, string>;
    criticalAreas: string[];
    evaluationOrder: string[];
    gateRules: Array<{ id: string; condition: string; decision: string }>;
    coverageThreshold: unknown;
  };
  /** Untouched source docs, for the collapsed "Technical Details" raw view. */
  raw: {
    requirement: unknown;
    existingTests: unknown;
    knownDefects: unknown;
    riskRules: unknown;
  };
}

export function getScenario(id: string): ScenarioData | null {
  if (!SCENARIOS.some((s) => s.id === id)) return null;

  const reqDoc = loadDataset("requirement") as any;
  const testDoc = loadDataset("existing-tests") as any;
  const defDoc = loadDataset("known-defects") as any;
  const rulesDoc = loadDataset("risk-rules") as any;

  const r = reqDoc.requirement;

  return {
    id,
    synthetic: true,
    requirement: {
      requirementId: r.requirementId,
      title: r.title,
      description: r.description,
      criticality: r.criticality,
      securitySensitive: r.securitySensitive,
      affectedAreas: r.affectedAreas,
      illustrativeValues: r.illustrativeValues,
    },
    acceptanceCriteria: r.acceptanceCriteria.map((ac: any) => ({
      id: ac.id, area: ac.area, critical: ac.critical, text: ac.text,
    })),
    tests: testDoc.tests.map((t: any) => ({
      testId: t.testId, title: t.title, area: t.area, testType: t.testType,
      coverageType: t.coverageType, status: t.status, covers: t.covers, note: t.note,
    })),
    coverageMap: testDoc.coverageByAcceptanceCriterion.map((c: any) => ({
      acceptanceCriterionId: c.acceptanceCriterionId, area: c.area,
      mappedTests: c.mappedTests, activeTests: c.activeTests, covered: c.covered,
    })),
    defects: defDoc.defects.map((d: any) => ({
      defectId: d.defectId, severity: d.severity, status: d.status, area: d.area,
      security: d.security, relatedAcceptanceCriteria: d.relatedAcceptanceCriteria,
      description: d.description,
    })),
    riskRules: {
      riskLevelsByArea: rulesDoc.riskLevelsByArea,
      criticalAreas: rulesDoc.criticalAcceptanceCriteriaRule?.criticalAreas ?? [],
      evaluationOrder: rulesDoc.releaseGateRules?.evaluationOrder ?? [],
      gateRules: rulesDoc.releaseGateRules?.rules ?? [],
      coverageThreshold:
        (rulesDoc.insufficientCoverageRule?.conditions ?? []).find((x: any) => x.id === "COV-3")
          ?.illustrativeThreshold ?? null,
    },
    raw: {
      requirement: reqDoc,
      existingTests: testDoc,
      knownDefects: defDoc,
      riskRules: rulesDoc,
    },
  };
}
