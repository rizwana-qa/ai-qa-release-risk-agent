/**
 * Test fixtures.
 *
 * These objects mirror the Phase 2 synthetic dataset (`data/*.json`) but are
 * hard-coded here so the gate and its tests stay independent of file I/O.
 * All values are synthetic and illustrative — no real company, customer,
 * banking, or production information.
 */

import type { ReleaseFindings } from "../src/releaseGate.ts";

/** Faithful in-memory copy of the Phase 2 synthetic dataset for REQ-BEN-001. */
const BASE: ReleaseFindings = {
  affectedAreas: [
    "authentication",
    "beneficiary-management",
    "money-transfer",
    "authorization",
    "security",
    "validation",
  ],
  acceptanceCriteria: [
    { id: "AC-1", area: "beneficiary-management", critical: false },
    { id: "AC-2", area: "authentication", critical: true },
    { id: "AC-3", area: "validation", critical: false },
    { id: "AC-4", area: "authorization", critical: true },
    { id: "AC-5", area: "money-transfer", critical: true },
    { id: "AC-6", area: "authentication", critical: true },
    { id: "AC-7", area: "validation", critical: false },
    { id: "AC-8", area: "security", critical: true },
  ],
  defects: [
    { defectId: "DEF-001", severity: "high", status: "open", area: "validation", security: false },
    { defectId: "DEF-002", severity: "medium", status: "closed", area: "beneficiary-management", security: false },
    { defectId: "DEF-003", severity: "critical", status: "closed", area: "money-transfer", security: false },
    { defectId: "DEF-004", severity: "high", status: "open", area: "authentication", security: true },
    { defectId: "DEF-005", severity: "low", status: "open", area: "authorization", security: true },
  ],
  tests: [
    { testId: "TEST-AUTH-001", area: "authentication", testType: "integration", coverageType: "positive", status: "active", covers: ["AC-2"] },
    { testId: "TEST-AUTH-002", area: "authentication", testType: "integration", coverageType: "negative", status: "active", covers: ["AC-6"] },
    { testId: "TEST-BEN-001", area: "beneficiary-management", testType: "e2e", coverageType: "positive", status: "active", covers: ["AC-1"] },
    { testId: "TEST-BEN-002", area: "beneficiary-management", testType: "integration", coverageType: "positive", status: "active", covers: ["AC-1"] },
    { testId: "TEST-VAL-001", area: "validation", testType: "unit", coverageType: "negative", status: "active", covers: ["AC-3"] },
    { testId: "TEST-VAL-002", area: "validation", testType: "unit", coverageType: "negative", status: "active", covers: ["AC-3"] },
    { testId: "TEST-AUTHZ-001", area: "authorization", testType: "integration", coverageType: "negative", status: "active", covers: ["AC-4"] },
    { testId: "TEST-XFER-001", area: "money-transfer", testType: "e2e", coverageType: "positive", status: "active", covers: ["AC-5"] },
    { testId: "TEST-XFER-002", area: "money-transfer", testType: "integration", coverageType: "boundary", status: "active", covers: ["AC-7"] },
    { testId: "TEST-XFER-003", area: "validation", testType: "unit", coverageType: "negative", status: "active", covers: ["AC-7"] },
    { testId: "TEST-SEC-001", area: "security", testType: "integration", coverageType: "negative", status: "quarantined", covers: ["AC-8"] },
  ],
  riskRules: {
    riskLevelsByArea: {
      authentication: "high",
      "beneficiary-management": "medium",
      "money-transfer": "high",
      authorization: "high",
      security: "high",
      validation: "medium",
    },
    criticalAreas: ["authentication", "authorization", "money-transfer", "security"],
    coverageRatioThreshold: 0.8,
    securityFailureSeverities: ["critical", "high"],
  },
};

/**
 * The Phase 2 dataset exactly as authored. With this data the gate returns
 * NO_GO via GATE-2 (DEF-004 open security defect; AC-8 security criterion has
 * only a quarantined test).
 */
export function baseFindings(): ReleaseFindings {
  return structuredClone(BASE);
}

/**
 * A deliberately healthy variant that the gate passes (GO / GATE-5):
 *   - TEST-SEC-001 reactivated  -> AC-8 has active coverage
 *   - DEF-004 closed            -> no open security defect
 *   - TEST-XFER-003 re-homed to the money-transfer area -> that high-risk area
 *     has an active negative test (COV-2 satisfied)
 */
export function healthyFindings(): ReleaseFindings {
  const f = baseFindings();
  setTestStatus(f, "TEST-SEC-001", "active");
  setDefectStatus(f, "DEF-004", "closed");
  setTestArea(f, "TEST-XFER-003", "money-transfer");
  return f;
}

/* ------------------------------- mutators -------------------------------- */
/* Small, explicit helpers so each test reads as "healthy data, then one change". */

export function setDefectStatus(f: ReleaseFindings, defectId: string, status: "open" | "closed"): void {
  const d = f.defects.find((x) => x.defectId === defectId);
  if (!d) throw new Error(`fixture: unknown defect ${defectId}`);
  d.status = status;
}

export function setDefectSeverity(f: ReleaseFindings, defectId: string, severity: ReleaseFindings["defects"][number]["severity"]): void {
  const d = f.defects.find((x) => x.defectId === defectId);
  if (!d) throw new Error(`fixture: unknown defect ${defectId}`);
  d.severity = severity;
}

export function setTestStatus(f: ReleaseFindings, testId: string, status: "active" | "quarantined"): void {
  const t = f.tests.find((x) => x.testId === testId);
  if (!t) throw new Error(`fixture: unknown test ${testId}`);
  t.status = status;
}

export function setTestArea(f: ReleaseFindings, testId: string, area: string): void {
  const t = f.tests.find((x) => x.testId === testId);
  if (!t) throw new Error(`fixture: unknown test ${testId}`);
  t.area = area;
}
