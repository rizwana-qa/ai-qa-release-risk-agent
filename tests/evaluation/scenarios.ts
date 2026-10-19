/**
 * The fixed, version-controlled synthetic evaluation set (version 1.0.0).
 *
 * Every name, id, title, description and status here is invented. No customer, production, personal,
 * confidential or credential data is used, and none may be added. Each scenario is a submission in the
 * exact shape the application's form produces. Expected outcomes are NOT hand-written promises: they are
 * what the existing deterministic gate returns for the scenario, locked by `tests/evaluation.test.ts`
 * and explained in `docs/AI_EVALUATION_PLAN.md`.
 *
 * Not a `*.test.ts` file, so the test runner imports it but does not execute it.
 */

export const EVALUATION_SET_VERSION = "1.0.0";

type Status = "Passed" | "Failed" | "Not Run" | "Blocked";
type Severity = "critical" | "high" | "medium" | "low";

interface Ac { area: string; critical?: boolean; text: string }
interface Tc { label: string; title: string; area: string; status: Status; covers: string[]; testType?: string }
interface Df { label: string; severity: Severity; status: "open" | "closed"; area: string; security?: boolean; description: string; relatedAcs?: string[] }

export interface Scenario {
  id: string;
  title: string;
  /** Why the scenario exists: what it is meant to show. */
  purpose: string;
  payload: ReturnType<typeof payload>;
  expected: {
    decision: "GO" | "CONDITIONAL" | "NO_GO";
    rule: string;
    /** Substrings every one of which must appear in the gate's reasons. */
    reasonIncludes: string[];
    coveragePercent: number;
  };
}

function payload(name: string, scope: string, story: string, acs: Ac[], tests: Tc[], defects: Df[] = [], criticality = "medium") {
  return {
    releaseName: name,
    releaseScope: scope,
    userStory: story,
    criticality,
    acceptanceCriteria: acs.map((a) => ({ area: a.area, critical: a.critical ?? false, text: a.text })),
    businessRules: [] as Array<{ text: string }>,
    testCases: tests.map((t) => ({ label: t.label, title: t.title, area: t.area, testType: t.testType ?? "e2e", status: t.status, covers: t.covers })),
    knownDefects: defects.map((d) => ({ label: d.label, severity: d.severity, status: d.status, area: d.area, security: d.security ?? false, description: d.description, relatedAcs: d.relatedAcs ?? [] })),
    supportingDocuments: [] as Array<{ name: string; size: number; type: string }>,
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: "S01",
    title: "Recipe Box: share a recipe by link (healthy)",
    purpose: "Sufficient mapped passing-test evidence, one closed low defect: the plain GO path.",
    payload: payload(
      "Recipe Box 2.1", "Lets a cook share a recipe through a link that opens a read-only page.",
      "As a cook I want to share a recipe by link so that friends can read it without an account.",
      [
        { area: "sharing", text: "A cook can create a share link for a recipe." },
        { area: "sharing", text: "Opening the link shows the recipe read-only." },
        { area: "sharing", text: "A cook can switch the link off." },
      ],
      [
        { label: "RB-1", title: "Create a share link", area: "sharing", status: "Passed", covers: ["AC1"] },
        { label: "RB-2", title: "Open link shows read-only recipe", area: "sharing", status: "Passed", covers: ["AC2"] },
        { label: "RB-3", title: "Switch link off", area: "sharing", status: "Passed", covers: ["AC3"] },
      ],
      [{ label: "RB-D1", severity: "low", status: "closed", area: "sharing", description: "Link copy button label was truncated on small screens." }],
    ),
    expected: { decision: "GO", rule: "GATE-5", reasonIncludes: ["GATE-5", "coverage adequate"], coveragePercent: 100 },
  },
  {
    id: "S02",
    title: "Garden Planner: watering reminders (no tests at all)",
    purpose: "Missing evidence: valid submission with zero test cases.",
    payload: payload(
      "Garden Planner 0.9", "Adds weekly watering reminders for each plant.",
      "As a gardener I want weekly watering reminders so that I do not forget my plants.",
      [
        { area: "reminders", text: "A reminder is sent weekly for each plant." },
        { area: "reminders", text: "A gardener can snooze a reminder for a day." },
      ],
      [],
    ),
    expected: { decision: "CONDITIONAL", rule: "GATE-6", reasonIncludes: ["GATE-6", "no passing test is mapped"], coveragePercent: 0 },
  },
  {
    id: "S03",
    title: "Garden Planner: only failed and not-run tests",
    purpose: "Tests exist but none passed: they must not satisfy the minimum-evidence floor.",
    payload: payload(
      "Garden Planner 0.9", "Adds weekly watering reminders for each plant.",
      "As a gardener I want weekly watering reminders so that I do not forget my plants.",
      [
        { area: "reminders", text: "A reminder is sent weekly for each plant." },
        { area: "reminders", text: "A gardener can snooze a reminder for a day." },
      ],
      [
        { label: "GP-1", title: "Weekly reminder is sent", area: "reminders", status: "Failed", covers: ["AC1"] },
        { label: "GP-2", title: "Snooze for a day", area: "reminders", status: "Not Run", covers: ["AC2"] },
      ],
    ),
    expected: { decision: "CONDITIONAL", rule: "GATE-6", reasonIncludes: ["GATE-6", "no passing test is mapped"], coveragePercent: 0 },
  },
  {
    id: "S04",
    title: "Library Kiosk: self-service returns (uncovered critical criterion)",
    purpose: "A criterion flagged critical has no passing test while other criteria do.",
    payload: payload(
      "Library Kiosk 3.0", "Adds a self-service returns slot to the lobby kiosk.",
      "As a borrower I want to return a book at the kiosk so that I do not queue at the desk.",
      [
        { area: "returns", text: "The kiosk scans the book barcode." },
        { area: "returns", critical: true, text: "A returned book is removed from the borrower's loan list." },
        { area: "returns", text: "The kiosk prints a receipt on request." },
      ],
      [
        { label: "LK-1", title: "Barcode is scanned", area: "returns", status: "Passed", covers: ["AC1"] },
        { label: "LK-2", title: "Receipt is printed", area: "returns", status: "Passed", covers: ["AC3"] },
      ],
    ),
    expected: { decision: "NO_GO", rule: "GATE-3", reasonIncludes: ["GATE-3", "AC2"], coveragePercent: 67 },
  },
  {
    id: "S05",
    title: "Trail Maps: offline map download (open critical defect)",
    purpose: "Full passing coverage, but an open critical defect blocks the release.",
    payload: payload(
      "Trail Maps 5.4", "Lets a hiker download a region's map for offline use.",
      "As a hiker I want to download a map so that I can navigate without signal.",
      [
        { area: "downloads", text: "A hiker can choose a region to download." },
        { area: "downloads", text: "A downloaded map opens without a connection." },
      ],
      [
        { label: "TM-1", title: "Choose a region", area: "downloads", status: "Passed", covers: ["AC1"] },
        { label: "TM-2", title: "Open map offline", area: "downloads", status: "Passed", covers: ["AC2"] },
      ],
      [{ label: "TM-D1", severity: "critical", status: "open", area: "downloads", description: "App crashes when a download is interrupted twice.", relatedAcs: ["AC2"] }],
      "high",
    ),
    expected: { decision: "NO_GO", rule: "GATE-1", reasonIncludes: ["GATE-1", "open critical defect"], coveragePercent: 100 },
  },
  {
    id: "S06",
    title: "Bike Share: ride history export (conflicting evidence)",
    purpose: "A passing and a failing test for the same criterion plus an open high defect: the gate ignores the failure once a passing mapped test exists, so a good narrative must still surface the conflict.",
    payload: payload(
      "Bike Share 1.7", "Adds a CSV export of a rider's ride history.",
      "As a rider I want to export my ride history so that I can keep my own records.",
      [
        { area: "exports", text: "A rider can export ride history as CSV." },
        { area: "exports", text: "The export includes date, distance and duration." },
      ],
      [
        { label: "BS-1", title: "Export ride history as CSV", area: "exports", status: "Passed", covers: ["AC1"] },
        { label: "BS-2", title: "Export ride history as CSV (rerun)", area: "exports", status: "Failed", covers: ["AC1"] },
        { label: "BS-3", title: "Export has date, distance, duration", area: "exports", status: "Passed", covers: ["AC2"] },
      ],
      [{ label: "BS-D1", severity: "high", status: "open", area: "exports", description: "Exported duration is off by one minute for rides over an hour.", relatedAcs: ["AC2"] }],
    ),
    expected: { decision: "GO", rule: "GATE-5", reasonIncludes: ["GATE-5", "coverage adequate"], coveragePercent: 100 },
  },
  {
    id: "S07",
    title: "Club Portal: member sign-in link (high-risk area, no negative test)",
    purpose: "High-risk area covered only by a positive test: insufficient coverage at high risk.",
    payload: payload(
      "Club Portal 4.2", "Lets a member sign in with a one-time link sent by email.",
      "As a member I want to sign in with a one-time link so that I do not need a password.",
      [{ area: "authentication", text: "A member can sign in with a valid one-time link." }],
      [{ label: "CP-1", title: "Sign in with a valid link", area: "authentication", status: "Passed", covers: ["AC1"] }],
      [],
      "high",
    ),
    expected: { decision: "CONDITIONAL", rule: "GATE-4", reasonIncludes: ["GATE-4", "COV-2"], coveragePercent: 100 },
  },
  {
    id: "S08",
    title: "Photo Gallery: album sharing (open security-flagged defect)",
    purpose: "An open high-severity security-flagged defect blocks the release.",
    payload: payload(
      "Photo Gallery 6.0", "Lets an owner share an album with named friends.",
      "As an owner I want to share an album so that only chosen friends can see it.",
      [
        { area: "albums", text: "An owner can add a friend to an album." },
        { area: "albums", text: "A friend can view the shared album." },
      ],
      [
        { label: "PG-1", title: "Add a friend to an album", area: "albums", status: "Passed", covers: ["AC1"] },
        { label: "PG-2", title: "Friend views shared album", area: "albums", status: "Passed", covers: ["AC2"] },
      ],
      [{ label: "PG-D1", severity: "high", status: "open", area: "albums", security: true, description: "An album link can be opened by someone who was not invited.", relatedAcs: ["AC2"] }],
    ),
    expected: { decision: "NO_GO", rule: "GATE-2", reasonIncludes: ["GATE-2", "SEC-1", "D1"], coveragePercent: 100 },
  },
  {
    id: "S09",
    title: "Podcast Player: playback speed (thin coverage, medium risk)",
    purpose: "One of three criteria covered at medium risk: the documented case where coverage is below the illustrative threshold yet GATE-5 still returns GO, with COV-3 in the reasons.",
    payload: payload(
      "Podcast Player 2.3", "Adds a playback speed control.",
      "As a listener I want to change playback speed so that I can listen faster.",
      [
        { area: "playback", text: "A listener can pick a speed from 0.5x to 3x." },
        { area: "playback", text: "The chosen speed is remembered for the show." },
        { area: "playback", text: "Speed changes do not alter pitch." },
      ],
      [{ label: "PP-1", title: "Pick a speed", area: "playback", status: "Passed", covers: ["AC1"] }],
    ),
    expected: { decision: "GO", rule: "GATE-5", reasonIncludes: ["GATE-5", "COV-3"], coveragePercent: 33 },
  },
  {
    id: "S10",
    title: "Warehouse Robot: route re-planning (non-banking, non-software-product domain)",
    purpose: "A domain far from banking, to check the prompt and the analysis generalise. Healthy evidence.",
    payload: payload(
      "Warehouse Robot Fleet 8.1", "The fleet re-plans routes when an aisle is blocked.",
      "As a floor supervisor I want robots to re-plan around a blocked aisle so that picking is not delayed.",
      [
        { area: "routing", text: "A blocked aisle is detected within two seconds." },
        { area: "routing", text: "Affected robots receive a new route." },
        { area: "routing", text: "Robots resume the original route when the aisle clears." },
      ],
      [
        { label: "WR-1", title: "Blocked aisle is detected", area: "routing", status: "Passed", covers: ["AC1"], testType: "integration" },
        { label: "WR-2", title: "New route is assigned", area: "routing", status: "Passed", covers: ["AC2"], testType: "integration" },
        { label: "WR-3", title: "Original route resumes", area: "routing", status: "Passed", covers: ["AC3"], testType: "integration" },
      ],
    ),
    expected: { decision: "GO", rule: "GATE-5", reasonIncludes: ["GATE-5", "coverage adequate"], coveragePercent: 100 },
  },
  {
    id: "S11",
    title: "Museum Guide: audio tour (inconsistent evidence: test mapped to a criterion that does not exist)",
    purpose: "A test reported as passed is mapped to AC9, which is not among the criteria. It supports nothing, so the minimum-evidence floor is not met even though a passing test exists.",
    payload: payload(
      "Museum Guide 1.2", "Adds an audio tour for the main hall.",
      "As a visitor I want an audio tour so that I can learn about the exhibits.",
      [
        { area: "audio", text: "A visitor can start the audio tour." },
        { area: "audio", text: "A visitor can pause and resume the tour." },
      ],
      [{ label: "MG-1", title: "Start the audio tour", area: "audio", status: "Passed", covers: ["AC9"] }],
    ),
    expected: { decision: "CONDITIONAL", rule: "GATE-6", reasonIncludes: ["GATE-6", "no passing test is mapped"], coveragePercent: 0 },
  },
  {
    id: "S12",
    title: "Ticket Desk: refund note (high-risk area name makes the criterion critical)",
    purpose: "No criterion is flagged critical, but the area name matches the fixed high-risk keywords, which makes every criterion in it critical (the area-name sensitivity documented earlier).",
    payload: payload(
      "Ticket Desk 2.0", "Adds a refund note field to the ticket desk.",
      "As a clerk I want to add a note to a payment refund so that the reason is recorded.",
      [{ area: "payment-notes", text: "A clerk can add a note to a refund." }],
      [],
    ),
    expected: { decision: "NO_GO", rule: "GATE-3", reasonIncludes: ["GATE-3", "AC1"], coveragePercent: 0 },
  },
];

/** The scenarios on which the AI-response cases below are exercised (a GO, a NO_GO, a CONDITIONAL). */
export const AI_CASE_BASES = { go: "S01", noGo: "S05", conditional: "S02", conflict: "S06" } as const;
