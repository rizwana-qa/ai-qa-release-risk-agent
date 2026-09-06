/**
 * Synthetic user-assessment payloads for the custom-assessment tests.
 * Not a `*.test.ts` file, so the runner imports but does not execute it.
 */

export function coachingPayload() {
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
    supportingDocuments: [{ name: "BRD.pdf", size: 2048, type: "application/pdf" }],
  };
}

/** All critical criteria covered by passing tests, no blocking defects, medium-risk areas -> GO. */
export function healthyPayload() {
  return {
    releaseName: "Release A",
    releaseScope: "Adds a self-service reporting export to the analytics dashboard.",
    userStory: "As an analyst I want to export a report to CSV so that I can share it offline.",
    criticality: "medium",
    acceptanceCriteria: [
      { area: "Reporting", critical: true, text: "User can export the current report to CSV." },
      { area: "Reporting", critical: false, text: "Export includes the applied filters." },
      { area: "Notifications", critical: false, text: "User is notified when the export is ready." },
    ],
    businessRules: [],
    testCases: [
      { label: "T1", title: "Export report to CSV happy path", area: "Reporting", testType: "e2e", status: "Passed", covers: ["AC1"] },
      { label: "T2", title: "Export reflects active filters", area: "Reporting", testType: "integration", status: "Passed", covers: ["AC2"] },
      { label: "T3", title: "Reject export with no columns selected", area: "Reporting", testType: "integration", status: "Passed", covers: ["AC1"] },
      { label: "T4", title: "Notify on export completion", area: "Notifications", testType: "integration", status: "Passed", covers: ["AC3"] },
    ],
    knownDefects: [
      { label: "D1", severity: "Low", status: "Closed", area: "Reporting", security: false, description: "Historic off-by-one in row count, fixed." },
    ],
    supportingDocuments: [],
  };
}

/** High-risk area + insufficient coverage, no NO_GO trigger -> CONDITIONAL / GATE-4. */
export function conditionalPayload() {
  return {
    releaseName: "Release B",
    releaseScope: "Adds passwordless sign-in via one-time email link to the authentication flow.",
    userStory: "As a user I want to sign in with a one-time email link so that I do not need a password.",
    criticality: "high",
    acceptanceCriteria: [
      { area: "Authentication", critical: true, text: "User receives a one-time sign-in link and can authenticate with it." },
      { area: "Authentication", critical: false, text: "A used or expired link is rejected." },
      { area: "Dashboard", critical: false, text: "After sign-in the user lands on their dashboard." },
    ],
    businessRules: [],
    testCases: [
      { label: "T1", title: "Sign in with a valid one-time link", area: "Authentication", testType: "e2e", status: "Passed", covers: ["AC1"] },
      { label: "T2", title: "Land on dashboard after sign-in", area: "Dashboard", testType: "e2e", status: "Passed", covers: ["AC2"] },
    ],
    knownDefects: [],
    supportingDocuments: [],
  };
}

/** Story + scope + one critical security criterion, no evidence at all -> NO_GO / GATE-2. */
export function noEvidenceSecurityPayload() {
  return {
    releaseScope: "Introduces an admin API for exporting user records.",
    userStory: "As an administrator I want to export user records via an API so that I can run audits.",
    criticality: "critical",
    acceptanceCriteria: [
      { area: "Security", critical: true, text: "Only authorized administrators can call the export API." },
    ],
    testCases: [],
    knownDefects: [],
  };
}
