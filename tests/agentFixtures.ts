/**
 * Fixtures for the Phase 5 reasoning-layer tests.
 *
 * `validAgentFindings()` is a synthetic, well-formed example of what the LLM is
 * expected to return for the single Phase 2 scenario. Its `dataProvenance`
 * matches the real synthetic dataset (8 acceptance criteria, 11 tests, 5
 * defects, REQ-BEN-001). No live model is ever called in tests.
 */

import { loadDataset, type DatasetName } from "../src/dataLoader.ts";
import type { AgentFindings } from "../src/agentContract.ts";

export function validAgentFindings(): AgentFindings {
  return {
    schemaVersion: 1,
    changeSummary:
      "Adds a beneficiary and lets an authenticated customer transfer money to that beneficiary after authentication.",
    identifiedRisks: [
      { area: "authentication", description: "Step-up authentication may be skippable inside an already-elevated session.", severity: "high" },
      { area: "money-transfer", description: "Moving money to a newly added payee is a high blast-radius action.", severity: "high" },
      { area: "security", description: "Sensitive fields (OTP, full account id) could leak in responses or logs.", severity: "high" },
      { area: "authorization", description: "Ownership checks must cover transfer, not just viewing.", severity: "medium" },
    ],
    coverageAssessment: [
      { acceptanceCriterionId: "AC-1", covered: true, notes: "Add + list beneficiary covered." },
      { acceptanceCriterionId: "AC-2", covered: true, notes: "Happy-path step-up only; no failure case." },
      { acceptanceCriterionId: "AC-3", covered: true, notes: "Two negative validation tests." },
      { acceptanceCriterionId: "AC-4", covered: true, notes: "One cross-customer denial test." },
      { acceptanceCriterionId: "AC-5", covered: true, notes: "Transfer happy path." },
      { acceptanceCriterionId: "AC-6", covered: true, notes: "Login failure only; not transfer-session invalidation." },
      { acceptanceCriterionId: "AC-7", covered: true, notes: "Balance and non-positive amount checked." },
      { acceptanceCriterionId: "AC-8", covered: false, notes: "Only mapped test is quarantined." },
    ],
    missingScenarios: [
      "Transfer to a beneficiary owned by another customer is rejected.",
      "Step-up authentication failure blocks adding a beneficiary.",
      "Sensitive values are absent from logs (with an active test).",
    ],
    defectReview: [
      { defectId: "DEF-001", stillRelevant: true, notes: "Open validation gap on beneficiary name length." },
      { defectId: "DEF-002", stillRelevant: false, notes: "Closed; dedupe on account identifier." },
      { defectId: "DEF-003", stillRelevant: false, notes: "Closed; idempotency key on transfer submit." },
      { defectId: "DEF-004", stillRelevant: true, notes: "Open security defect: step-up not re-challenged." },
      { defectId: "DEF-005", stillRelevant: true, notes: "Low-severity beneficiary-id existence oracle." },
    ],
    regressionPriorities: [
      { area: "money-transfer", priority: "high", rationale: "High inherent risk and a prior critical defect." },
      { area: "authentication", priority: "high", rationale: "Open security-flagged defect on step-up." },
      { area: "security", priority: "high", rationale: "Critical criterion AC-8 has no active test." },
      { area: "authorization", priority: "medium", rationale: "Only one denial test present." },
    ],
    releaseRiskExplanation:
      "The change spans authentication, authorization, money movement and security. Coverage is broadly " +
      "present, but the security acceptance criterion (AC-8) has no active test and an open security defect " +
      "(DEF-004) affects step-up authentication. Regression testing should concentrate on transfers and " +
      "authentication paths.",
    dataProvenance: {
      requirementId: "REQ-BEN-001",
      acceptanceCriteriaCount: 8,
      existingTestCount: 11,
      knownDefectCount: 5,
      riskRulesScenario: "REQ-BEN-001",
    },
  };
}

/** Deep clone of the valid fixture (so tests can mutate freely). */
export function cloneValidAgentFindings(): AgentFindings {
  return structuredClone(validAgentFindings());
}

/** A loader that returns the real synthetic datasets unchanged. */
export function realDatasetLoader(): (name: DatasetName) => unknown {
  return (name) => loadDataset(name);
}

/**
 * A loader that returns a "healthy" variant of the datasets: AC-8 gets an active
 * test, the open security defect is closed, and the money-transfer area gets an
 * active negative test. The dataset counts are unchanged, so the same
 * `validAgentFindings()` provenance still matches.
 */
export function healthyDatasetLoader(): (name: DatasetName) => unknown {
  return (name) => {
    const data = structuredClone(loadDataset(name)) as any;
    if (name === "existing-tests") {
      for (const t of data.tests) {
        if (t.testId === "TEST-SEC-001") t.status = "active";
        if (t.testId === "TEST-XFER-003") t.area = "money-transfer";
      }
    }
    if (name === "known-defects") {
      for (const d of data.defects) {
        if (d.defectId === "DEF-004") d.status = "closed";
      }
    }
    return data;
  };
}
