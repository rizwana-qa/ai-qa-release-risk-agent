/**
 * Stage 3B controlled evaluation runner (docs/AI_EVALUATION_PLAN.md, sections 11 to 20).
 *
 * Runs the four approved scenarios, S01, S05, S02, S06, in that order, through the EXISTING pipeline
 * (`runPipeline`) with the EXISTING analyze function (`createGeminiAnalyzeFn`). It adds controls around
 * that call and nothing else: it creates no second client, bypasses no validation, guard, sanitiser or
 * gate, and changes no application behaviour.
 *
 *   node tests/evaluation/runner.ts                      dry-run (default): offline analyzer, zero provider requests
 *   node tests/evaluation/runner.ts --live               live: needs the explicit opt-in below AND a clean environment
 *
 * Controls:
 *  - Dry-run is the default. Live mode needs `--live`; there is no environment-variable way in.
 *  - Hard cap of 4 assessment attempts and 1 provider call per scenario, enforced by a meter around the
 *    analyze function. There are no retries. A failed live call is NOT repeated: the application's own
 *    offline rules-based fallback result is recorded, labelled distinctly from a Gemini result.
 *  - Fails closed: the scenario set, its fingerprint, limits and output locations are verified first.
 *  - Live preflight (always the real one): the existing provider-routing guard, GEMINI_API_KEY present (value
 *    never read into any output), GEMINI_MODEL pinned explicitly, and GEMINI_TIMEOUT_MS, if set, in bounds.
 *  - A batch deadline: no scenario starts after it, and a scenario still running when it passes is recorded as
 *    an unknown result, never as a success. Cancelling a local promise does not cancel a request already sent.
 *  - The first stop condition halts the batch; remaining scenarios are recorded as not run.
 *  - Unexpected exceptions anywhere in a scenario are caught, recorded as an infrastructure stop, and end the
 *    batch. If the record itself cannot be written, the run says so and prints the counts it holds in memory.
 *  - Output is written outside the repository only. Nothing containing a secret-shaped string or an
 *    environment secret value is ever written. Credentials are never accepted as arguments.
 *  - Local retention (default 7 days, configurable): expired run records, raw-response files and stale temporary
 *    pipeline state created by this runner are removed; nothing else is touched. This does NOT delete provider-side
 *    copies: only the owner can establish what the provider retains.
 *  - Evidence the automated checks flag (id-shaped tokens absent from the evidence, cross-check contradictions,
 *    decision-like keys, fallbacks) is marked `flagged` and printed. The automated checks do NOT detect every
 *    unsupported free-text assertion, so a live run always requires human review (H1 to H4).
 *
 * Programmatic seams (`analyzeFactory`, `scenarios`, `env`, `now`, `git`, `repoRoot`, `clock`, `stateRoot`) exist
 * for offline tests. The command line reaches none of them. Combining a seam that could weaken a control with the
 * real provider path is refused, and a record states whether the analyzer was the default or an injected one.
 *
 * Offline tests prove these controls with fake analyzers. They prove nothing about live provider behaviour.
 */

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EVALUATION_SET_VERSION, SCENARIOS, type Scenario } from "./scenarios.ts";
import { normalizeAssessmentInput } from "../../api/inputNormalizer.ts";
import { analyzeEvidence } from "../../api/evidenceAnalyzer.ts";
import { runPipeline } from "../../src/pipelineCli.ts";
import { assertDeveloperApiRouting, createGeminiAnalyzeFn } from "../../src/geminiAgent.ts";
import { sanitizeProviderError } from "../../src/providerError.ts";
import { FORBIDDEN_OUTPUT_KEYS, type AnalyzeFn } from "../../src/agentContract.ts";
import { CROSS_CHECK_STEP } from "../../src/aiCrossCheck.ts";

/* ------------------------------ fixed plan ------------------------------ */

/** The only scenarios the first batch may run, and the only order. Changing this is a plan change. */
export const APPROVED_ORDER = ["S01", "S05", "S02", "S06"] as const;
export const HARD_MAX_ATTEMPTS = 4;
export const MAX_ATTEMPTS_PER_SCENARIO = 1;
export const DEFAULT_RETENTION_DAYS = 7;
/** Maximum duration of one batch. Four calls at the 20 s provider default fit with a wide margin. */
export const DEFAULT_MAX_BATCH_MS = 120_000;
export const MAX_BATCH_MS_BOUNDS = [10, 900_000] as const;
/** The provider timeout the runner will accept (milliseconds), when GEMINI_TIMEOUT_MS is set. */
export const PROVIDER_TIMEOUT_BOUNDS = [1_000, 60_000] as const;
export const APPROVED_SET_VERSION = "1.0.0";
/** SHA-256 of the four approved scenarios' content and expected values. Update together with the version. */
export const APPROVED_SET_FINGERPRINT = "4cafeed74581c8e925c910f54b767db9a5c2b120b268668d39fc1cb3b30ae01c";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Every source file the runner executes (its static import closure), repo-relative. The digest of their
 * contents is recorded with every run, so a result can be tied to an exact code baseline even while the
 * working tree holds unrelated uncommitted work. A test fails if this list drifts from the real imports.
 * The digest identifies content only; it does not show that the content is safe.
 */
export const BASELINE_FILES = [
  "api/evidenceAnalyzer.ts", "api/inputNormalizer.ts", "api/policy.ts",
  "src/agentContract.ts", "src/agentOutputValidation.ts", "src/aiCrossCheck.ts", "src/dataLoader.ts", "src/findingsAdapter.ts",
  "src/geminiAgent.ts", "src/mcpDataClient.ts", "src/pipelineCli.ts", "src/providerError.ts", "src/releaseAssessment.ts", "src/releaseGate.ts",
  "tests/evaluation/runner.ts", "tests/evaluation/scenarios.ts",
] as const;
const RAW_PREFIX = "s3b-raw-";
const RESULT_PREFIX = "s3b-run-";
const STATE_PREFIX = "s3b-state-";
const STALE_STATE_MS = 24 * 3_600_000;
/** Steps whose failure means the live batch did not produce usable findings (mirrors the application's fallback). */
const LIVE_FAILURE_STEPS = ["ai-reasoning", "validate-structured-findings", "deterministic-adapter"];

export class ConfigError extends Error {}

/** The audit record could not be written. `summary` holds the counts known in memory; no audit file exists. */
export class RecordWriteError extends Error {
  readonly summary: string;
  constructor(message: string, summary: string) {
    super(message);
    this.summary = summary;
  }
}

export type RunMode = "dry-run" | "live";
export type ScenarioMode = "offline-dry-run" | "gemini" | "rules-based-fallback" | "not-run";

export interface StopCondition { code: string; detail: string }

export interface ScenarioRecord {
  scenarioId: string;
  title: string;
  startedAt: string | null;
  finishedAt: string | null;
  assessmentAttempts: number;
  providerRequestsAttempted: number;
  mode: ScenarioMode;
  expected: { decision: string; rule: string };
  observed: { decision: string | null; rule: string | null };
  /** Validation of the analyze attempt that ran first (the live one in live mode). */
  validation: { agentOutputValid: boolean | null; adapterOk: boolean | null };
  fallback: { used: boolean; reason: string | null };
  crossCheck: { confirmed: number; heuristic: number };
  /** Automated measures; informational unless a stop condition says otherwise. Human review is separate. */
  measures: { unknownIdTokens: string[]; forbiddenKeysInResponse: string[] };
  /**
   * `flagged` means the automated checks found something a human must look at. `clean` means they found nothing;
   * it is NOT a finding that the narrative is accurate. `not-applicable`: no AI output was involved.
   */
  evidenceCheck: { status: "not-applicable" | "clean" | "flagged"; reasons: string[] };
  trace: Array<{ step: string; ok: boolean | null; detail: string }>;
  outcome: "pass" | "fail" | "not-run";
  stopConditions: StopCondition[];
  rawSaved: boolean;
}

export interface BatchRecord {
  evaluationSetVersion: string;
  setFingerprint: string;
  runId: string;
  mode: RunMode;
  /** `default-gemini`: the real analyze function. `injected`: a caller-supplied one (tests only; not a valid live result). `offline`: dry-run. */
  analyzerSource: "default-gemini" | "injected" | "offline";
  status: "completed" | "stopped" | "blocked";
  startedAt: string;
  finishedAt: string;
  git: { head: string; workingTreeDirty: boolean | null };
  baseline: { fileCount: number; sha256: string };
  nodeVersion: string;
  model: string | null;
  timeoutMs: number;
  maxBatchMs: number;
  elapsedMs: number;
  planned: { scenarios: string[]; maxAssessmentAttempts: number; maxAttemptsPerScenario: number; maxAutomaticRetries: 0 };
  actual: { assessmentAttempts: number; providerRequestsAttempted: number; fallbackRuns: number };
  scenarios: ScenarioRecord[];
  stop: (StopCondition & { scenarioId: string | null }) | null;
  retention: { rawStored: boolean; days: number; purgedFiles: number; purgedRecords: number; purgedState: number; purgeFailures: number };
  /** Live runs always require human review (H1 to H4); the automated checks cannot establish accuracy. */
  humanReview: { required: boolean; flaggedScenarios: string[]; note: string };
  notes: string[];
}

export interface RunnerOptions {
  mode: RunMode;
  scenarioIds?: readonly string[];
  maxAttempts?: number;
  maxBatchMs?: number;
  outDir?: string;
  rawDir?: string;
  retentionDays?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Monotonic millisecond clock for the batch deadline (default `performance.now`). */
  clock?: () => number;
  /** Where temporary pipeline state lives (default: the system temporary directory). */
  stateRoot?: string;
  /** Builds the live analyze function. Called only in live mode, only after preflight, at most once. */
  analyzeFactory?: () => AnalyzeFn;
  git?: () => { head: string; workingTreeDirty: boolean | null };
  repoRoot?: string;
  /** Scenario source; default is the fixed set. Overridable only so tests can prove the verification fails closed. */
  scenarios?: Scenario[];
}

/* ------------------------------ verification ----------------------------- */

export function fingerprintOf(scenarios: Scenario[]): string {
  const pick = APPROVED_ORDER.map((id) => {
    const s = scenarios.find((x) => x.id === id);
    return s ? { id: s.id, title: s.title, purpose: s.purpose, payload: s.payload, expected: s.expected } : { id, missing: true };
  });
  return createHash("sha256").update(JSON.stringify(pick)).digest("hex");
}

/** Real path of `p`, resolving links through the nearest existing ancestor even if `p` itself does not exist yet. */
function canonical(p: string): string {
  let current = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(current), ...tail.reverse()); } catch { /* not there yet */ }
    const parent = dirname(current);
    if (parent === current) return resolve(p);
    tail.push(current.slice(parent.length).replace(/^[\\/]+/, ""));
    current = parent;
  }
}

function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => {
    const r = canonical(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function assertOutsideRepo(path: string, what: string, repoRoot = REPO_ROOT): void {
  if (!path || !isAbsolute(resolve(path))) throw new ConfigError(`${what} is not a usable path.`);
  if (isInside(path, repoRoot)) throw new ConfigError(`${what} must be outside the repository.`);
}

/** SHA-256 over the baseline files (line endings normalised so the digest matches the committed form). Fails closed if any is missing. */
export function baselineDigest(root = REPO_ROOT): { fileCount: number; sha256: string } {
  const hash = createHash("sha256");
  for (const rel of BASELINE_FILES) {
    const file = join(root, rel);
    if (!existsSync(file)) throw new ConfigError(`A baseline file is missing: ${rel}.`);
    hash.update(rel).update("\0").update(readFileSync(file, "utf8").replace(/\r\n/g, "\n")).update("\0");
  }
  return { fileCount: BASELINE_FILES.length, sha256: hash.digest("hex") };
}

function verifyConfig(o: RunnerOptions, scenarios: Scenario[], repoRoot: string): { ids: string[]; maxAttempts: number; retentionDays: number; maxBatchMs: number } {
  if (o.mode !== "dry-run" && o.mode !== "live") throw new ConfigError("Mode must be dry-run or live.");
  const ids = [...(o.scenarioIds ?? APPROVED_ORDER)];
  if (ids.length !== APPROVED_ORDER.length || ids.some((id, i) => id !== APPROVED_ORDER[i])) {
    throw new ConfigError(`Scenario list must be exactly ${APPROVED_ORDER.join(", ")} in that order.`);
  }
  if (EVALUATION_SET_VERSION !== APPROVED_SET_VERSION) throw new ConfigError("Evaluation set version does not match the approved version.");
  if (fingerprintOf(scenarios) !== APPROVED_SET_FINGERPRINT) throw new ConfigError("Scenario content does not match the approved fingerprint.");
  const maxAttempts = o.maxAttempts ?? HARD_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > HARD_MAX_ATTEMPTS) {
    throw new ConfigError(`Maximum attempts must be an integer from 1 to ${HARD_MAX_ATTEMPTS}.`);
  }
  const retentionDays = o.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) throw new ConfigError("Retention days must be an integer from 1 to 365.");
  const maxBatchMs = o.maxBatchMs ?? DEFAULT_MAX_BATCH_MS;
  if (!Number.isInteger(maxBatchMs) || maxBatchMs < MAX_BATCH_MS_BOUNDS[0] || maxBatchMs > MAX_BATCH_MS_BOUNDS[1]) {
    throw new ConfigError(`The batch deadline must be an integer from ${MAX_BATCH_MS_BOUNDS[0]} to ${MAX_BATCH_MS_BOUNDS[1]} milliseconds.`);
  }
  if (!o.outDir) throw new ConfigError("An output directory is required.");
  assertOutsideRepo(o.outDir, "The output directory", repoRoot);
  if (o.rawDir) assertOutsideRepo(o.rawDir, "The raw-response directory", repoRoot);
  return { ids, maxAttempts, retentionDays, maxBatchMs };
}

/**
 * The real provider path must not be combined with a seam that could weaken a control: a different environment
 * than the one the provider code will read, a different repository root, or a different clock.
 */
function assertNoSeamsWithRealProvider(o: RunnerOptions): void {
  if (o.mode !== "live" || o.analyzeFactory) return;
  if ((o.env && o.env !== process.env) || o.repoRoot || o.clock) {
    throw new ConfigError("The real provider path cannot be combined with a custom environment, repository root or clock.");
  }
}

/** Default live preflight. Reads presence and bounds only; never returns or prints a value. Always runs in live mode. */
export function defaultPreflight(env: NodeJS.ProcessEnv): void {
  assertDeveloperApiRouting(env);
  if (!(env.GEMINI_API_KEY ?? "").trim()) throw new Error("Live evaluation was not started: GEMINI_API_KEY is not set.");
  if (!(env.GEMINI_MODEL ?? "").trim()) throw new Error("Live evaluation was not started: pin GEMINI_MODEL explicitly (after verifying availability).");
  const timeout = (env.GEMINI_TIMEOUT_MS ?? "").trim();
  if (timeout !== "") {
    const n = Number(timeout);
    if (!Number.isInteger(n) || n < PROVIDER_TIMEOUT_BOUNDS[0] || n > PROVIDER_TIMEOUT_BOUNDS[1]) {
      throw new Error(`Live evaluation was not started: GEMINI_TIMEOUT_MS must be an integer from ${PROVIDER_TIMEOUT_BOUNDS[0]} to ${PROVIDER_TIMEOUT_BOUNDS[1]}.`);
    }
  }
}

/* ----------------------------- safety scanning --------------------------- */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/AIza[0-9A-Za-z_-]{20,}/, "Google API key shape"],
  [/\bya29\.[0-9A-Za-z._-]{10,}/, "OAuth token shape"],
  [/\bsk-[A-Za-z0-9_-]{16,}/, "secret key shape"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i, "bearer token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
];
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

/** Names of what was found, never the matched text. A false positive halts the run: that is the safe direction. */
export function findSensitive(text: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const hits: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    const v = value?.trim();
    if (v && v.length >= 8 && SECRET_ENV_NAME.test(name) && text.includes(v)) hits.push(`value of environment variable ${name}`);
  }
  for (const [re, label] of SECRET_PATTERNS) if (re.test(text)) hits.push(label);
  return hits;
}

const safeText = (t: unknown, env: NodeJS.ProcessEnv): string => (typeof t === "string" && t.trim() !== "" ? sanitizeProviderError(t, env) : "");

function collectKeys(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const v of value) collectKeys(v, out, depth + 1); return; }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) { out.add(k.toLowerCase()); collectKeys(v, out, depth + 1); }
}
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out, depth + 1);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
}

const ID_TOKEN = /\b[A-Z]{1,5}-?[A-Z]?\d{1,3}\b/g;
const GENERIC_TOKEN = /^(GATE|COV|SEC|REQ)-?\d+$/;
const normId = (t: string): string => t.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Id-shaped tokens in the AI's text that appear nowhere in the scenario's evidence (measure M4; informational).
 * Two passes: upper-case id shapes anywhere, and, for every id prefix the evidence itself uses (AC, D, RB-, ...),
 * the same prefix in any case with an optional space or hyphen ("ac99", "AC 98"). It cannot see a claim that
 * names no id, a wrong claim about a real id, or an id written some other way. It does not detect hallucination.
 */
export function unknownIdTokens(aiResponse: unknown, evidence: unknown): string[] {
  const evidenceTokens = JSON.stringify(evidence).match(ID_TOKEN) ?? [];
  const known = new Set(evidenceTokens.map(normId));
  const strings: string[] = [];
  collectStrings(aiResponse, strings);
  const text = strings.join("\n");
  const found = new Set<string>(text.match(ID_TOKEN) ?? []);

  const prefixes = new Set(evidenceTokens.map((t) => t.replace(/\d+$/, "").replace(/[^A-Za-z]/g, "")).filter(Boolean));
  for (const letters of prefixes) {
    const body = letters.split("").join("[-\\s]?");
    const sep = letters.length >= 2 ? "[-\\s]?" : "-?"; // a single letter never takes a space ("D 5" is not an id)
    const re = new RegExp(`(?<![A-Za-z0-9])${body}${sep}\\d{1,3}(?!\\d)`, "gi");
    for (const m of text.match(re) ?? []) found.add(m.toUpperCase().replace(/\s+/g, ""));
  }
  const unknown = new Set<string>();
  for (const t of found) if (!known.has(normId(t)) && !GENERIC_TOKEN.test(t)) unknown.add(t);
  return [...unknown].sort();
}

/** Whether the deterministic result equals the locked expectation: decision, rule and every reason fragment. */
export function matchesExpected(expected: Scenario["expected"], decision: string | null, rule: string | null, reasons: string[]): boolean {
  const text = reasons.join(" ");
  return decision === expected.decision && rule === expected.rule && expected.reasonIncludes.every((part) => text.includes(part));
}

/* --------------------------------- meter -------------------------------- */

/** Counts every call to the analyze function and refuses any beyond the per-scenario or batch limit, or after close. */
export class RequestMeter {
  total = 0;
  violations = 0;
  closed = false;
  readonly perScenario = new Map<string, number>();
  readonly cap: number;
  readonly perScenarioMax: number;
  constructor(cap: number, perScenarioMax = MAX_ATTEMPTS_PER_SCENARIO) {
    this.cap = cap;
    this.perScenarioMax = perScenarioMax;
  }

  wrap(scenarioId: string, inner: AnalyzeFn, capture: (response: unknown) => void): AnalyzeFn {
    return async (context) => {
      if (this.closed) throw new Error("Evaluation closed: no further provider requests are permitted.");
      const used = this.perScenario.get(scenarioId) ?? 0;
      if (used >= this.perScenarioMax || this.total >= this.cap) {
        this.violations++;
        throw new Error("Evaluation request limit reached: no further provider requests are permitted.");
      }
      this.perScenario.set(scenarioId, used + 1);
      this.total++; // counted before the call, so a call that fails early still counts (conservative)
      const response = await inner(context);
      capture(response);
      return response;
    };
  }
}

/* ------------------------------ local retention -------------------------- */

const isOurs = (name: string, prefix: string): boolean => name.startsWith(prefix) && /\.json(\.partial)?$/.test(name);

/**
 * Deletes expired files this runner created, and nothing else: regular files named `<prefix>*.json` (or
 * `.json.partial`) directly inside `dir`. Age is the OLDER of the time written inside the file and the file's
 * modification time, so a wrong or future time inside a file cannot keep it past the period; malformed content
 * falls back to the modification time. Links, directories and anything unreadable are reported in `failures`
 * (names only) and neither followed nor removed.
 */
function purgeExpiredFiles(dir: string, prefix: string, timeKey: string, retentionDays: number, now: Date, failures: string[]): number {
  if (!existsSync(dir)) return 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { failures.push("(directory unreadable)"); return 0; }
  let deleted = 0;
  for (const name of names) {
    if (!isOurs(name, prefix)) continue;
    const file = join(dir, name);
    try {
      const info = lstatSync(file);
      if (!info.isFile()) { failures.push(name); continue; }
      let writtenAt = info.mtimeMs;
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        const t = typeof parsed[timeKey] === "string" ? Date.parse(parsed[timeKey] as string) : NaN;
        if (Number.isFinite(t)) writtenAt = Math.min(writtenAt, t);
      } catch { /* unreadable or partial content: the modification time decides */ }
      if (now.getTime() - writtenAt > retentionDays * 86_400_000) { rmSync(file); deleted++; }
    } catch {
      failures.push(name);
    }
  }
  return deleted;
}

/** Expired raw-response files (`s3b-raw-*`) in `rawDir`. */
export function purgeExpiredRaw(rawDir: string, retentionDays: number, now: Date, failures: string[] = []): number {
  return purgeExpiredFiles(rawDir, RAW_PREFIX, "savedAt", retentionDays, now, failures);
}

/** Expired run records (`s3b-run-*`) in `outDir`. */
export function purgeExpiredRecords(outDir: string, retentionDays: number, now: Date, failures: string[] = []): number {
  return purgeExpiredFiles(outDir, RESULT_PREFIX, "startedAt", retentionDays, now, failures);
}

/**
 * Removes stale temporary pipeline state directories (`s3b-state-*`) under `root`. A directory is removed only if
 * it is a real directory (not a link), owned by this user where the platform reports ownership, older than 24 hours,
 * and holds nothing but the regular files the runner itself writes (`S<nn>-dry|live|fallback.json`). Anything else
 * with that prefix is reported in `failures` and left alone.
 */
export function purgeStaleState(root: string, now: Date, failures: string[] = []): number {
  if (!existsSync(root)) return 0;
  let names: string[];
  try { names = readdirSync(root); } catch { failures.push("(directory unreadable)"); return 0; }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let deleted = 0;
  for (const name of names) {
    if (!name.startsWith(STATE_PREFIX)) continue;
    const dirPath = join(root, name);
    try {
      const info = lstatSync(dirPath);
      if (!info.isDirectory()) { failures.push(name); continue; }
      if (uid !== null && info.uid !== uid) { failures.push(name); continue; }
      if (now.getTime() - info.mtimeMs <= STALE_STATE_MS) continue; // recent: possibly in use
      const entries = readdirSync(dirPath);
      const ours = entries.every((e) => /^S\d{2}-(dry|live|fallback)\.json$/.test(e) && lstatSync(join(dirPath, e)).isFile());
      if (!ours) { failures.push(name); continue; }
      rmSync(dirPath, { recursive: true });
      deleted++;
    } catch {
      failures.push(name);
    }
  }
  return deleted;
}

/** Write via a `.partial` file and rename, so a crash never leaves a truncated record under the final name. */
function writeAtomic(path: string, text: string): void {
  const partial = `${path}.partial`;
  try {
    writeFileSync(partial, text, { encoding: "utf8", mode: 0o600 });
    renameSync(partial, path);
  } catch (err) {
    try { rmSync(partial, { force: true }); } catch { /* nothing more can be done */ }
    throw err;
  }
}

/* --------------------------------- runner -------------------------------- */

function defaultGit(): { head: string; workingTreeDirty: boolean | null } {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
    return { head, workingTreeDirty: dirty };
  } catch {
    return { head: "unknown", workingTreeDirty: null };
  }
}

const HUMAN_REVIEW_NOTE = "Automated checks do not detect every unsupported free-text assertion. A live run is not accepted until a person has completed the H1 to H4 review.";

const notRun = (s: Scenario): ScenarioRecord => ({
  scenarioId: s.id, title: s.title, startedAt: null, finishedAt: null, assessmentAttempts: 0, providerRequestsAttempted: 0,
  mode: "not-run", expected: { decision: s.expected.decision, rule: s.expected.rule }, observed: { decision: null, rule: null },
  validation: { agentOutputValid: null, adapterOk: null }, fallback: { used: false, reason: null }, crossCheck: { confirmed: 0, heuristic: 0 },
  measures: { unknownIdTokens: [], forbiddenKeysInResponse: [] }, evidenceCheck: { status: "not-applicable", reasons: [] },
  trace: [], outcome: "not-run", stopConditions: [], rawSaved: false,
});

/** A scenario entry reduced to ids and counts, used when the full record must be withheld. */
function notRunLike(r: ScenarioRecord): ScenarioRecord {
  return {
    scenarioId: r.scenarioId, title: "", startedAt: null, finishedAt: null, assessmentAttempts: r.assessmentAttempts, providerRequestsAttempted: r.providerRequestsAttempted,
    mode: r.mode, expected: { decision: r.expected.decision, rule: r.expected.rule }, observed: { decision: null, rule: null },
    validation: { agentOutputValid: null, adapterOk: null }, fallback: { used: r.fallback.used, reason: null }, crossCheck: { confirmed: 0, heuristic: 0 },
    measures: { unknownIdTokens: [], forbiddenKeysInResponse: [] }, evidenceCheck: { status: "flagged", reasons: ["withheld"] },
    trace: [], outcome: r.outcome, stopConditions: [], rawSaved: r.rawSaved,
  };
}

type Timed<T> = { timedOut: false; value: T } | { timedOut: true };

/** Settles with `timedOut` once `ms` pass. The timer is not unref'd, so a hung call cannot let the process exit unnoticed. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<Timed<T>> {
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => resolveP({ timedOut: true }), Math.max(1, ms));
    work.then(
      (value) => { clearTimeout(timer); resolveP({ timedOut: false, value }); },
      (err) => { clearTimeout(timer); rejectP(err); },
    );
  });
}

export async function runBatch(options: RunnerOptions): Promise<BatchRecord> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? (() => performance.now());
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const all = options.scenarios ?? SCENARIOS;
  assertNoSeamsWithRealProvider(options);
  const { ids, maxAttempts, retentionDays, maxBatchMs } = verifyConfig(options, all, repoRoot);
  const scenarios = ids.map((id) => all.find((s) => s.id === id)!);
  const startedAt = now();
  const t0 = clock();
  const runId = `${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const timeoutMs = Number(env.GEMINI_TIMEOUT_MS) || 20_000;
  const stateRoot = options.stateRoot ?? tmpdir();

  const record: BatchRecord = {
    evaluationSetVersion: EVALUATION_SET_VERSION, setFingerprint: APPROVED_SET_FINGERPRINT, runId, mode: options.mode,
    analyzerSource: options.mode === "dry-run" ? "offline" : options.analyzeFactory ? "injected" : "default-gemini", status: "completed",
    startedAt: startedAt.toISOString(), finishedAt: startedAt.toISOString(), git: (options.git ?? defaultGit)(),
    baseline: baselineDigest(), nodeVersion: process.version,
    model: options.mode === "live" ? (env.GEMINI_MODEL ?? "").trim() || null : null, timeoutMs, maxBatchMs, elapsedMs: 0,
    planned: { scenarios: ids, maxAssessmentAttempts: maxAttempts, maxAttemptsPerScenario: MAX_ATTEMPTS_PER_SCENARIO, maxAutomaticRetries: 0 },
    actual: { assessmentAttempts: 0, providerRequestsAttempted: 0, fallbackRuns: 0 },
    scenarios: scenarios.map(notRun), stop: null,
    retention: { rawStored: false, days: retentionDays, purgedFiles: 0, purgedRecords: 0, purgedState: 0, purgeFailures: 0 },
    humanReview: { required: options.mode === "live", flaggedScenarios: [], note: HUMAN_REVIEW_NOTE }, notes: [],
  };
  if (record.analyzerSource === "injected") record.notes.push("An injected analyzer was used: this is a test run and is not a valid live result.");

  mkdirSync(options.outDir!, { recursive: true });
  const purgeFailures: string[] = [];
  record.retention.purgedRecords = purgeExpiredRecords(options.outDir!, retentionDays, startedAt, purgeFailures);
  if (options.rawDir) {
    mkdirSync(options.rawDir, { recursive: true });
    record.retention.purgedFiles = purgeExpiredRaw(options.rawDir, retentionDays, startedAt, purgeFailures);
  }
  const stateFailures: string[] = [];
  record.retention.purgedState = purgeStaleState(stateRoot, startedAt, stateFailures);
  record.retention.purgeFailures = purgeFailures.length + stateFailures.length;

  const summary = () =>
    `status ${record.status}; assessment attempts ${record.actual.assessmentAttempts}; provider requests attempted ${record.actual.providerRequestsAttempted}; fallbacks ${record.actual.fallbackRuns}`;

  const finish = (): BatchRecord => {
    record.finishedAt = now().toISOString();
    record.elapsedMs = Math.round(clock() - t0);
    record.humanReview.flaggedScenarios = record.scenarios.filter((r) => r.evidenceCheck.status === "flagged").map((r) => r.scenarioId);
    let text = JSON.stringify(record, null, 2);
    const hits = findSensitive(text, env);
    if (hits.length > 0) {
      // Fail closed: the full record is not retained. Keep only counts and codes, so the attempt count survives.
      const minimal = {
        evaluationSetVersion: record.evaluationSetVersion, runId, mode: record.mode, status: "stopped", planned: record.planned, actual: record.actual,
        stop: { code: "sensitive-data", detail: "The full record matched a secret pattern and was withheld.", scenarioId: record.stop?.scenarioId ?? null },
        humanReview: record.humanReview,
      };
      text = JSON.stringify(minimal, null, 2);
      if (findSensitive(text, env).length > 0) throw new RecordWriteError("Refusing to write any evaluation record: even the minimal record matched a secret pattern. No audit file exists for this run.", summary());
      record.status = "stopped";
      record.stop = { code: "sensitive-data", detail: "The full record matched a secret pattern and was withheld; only counts were kept.", scenarioId: record.stop?.scenarioId ?? null };
      record.scenarios = record.scenarios.map((r) => notRunLike(r));
    }
    try {
      writeAtomic(join(options.outDir!, `${RESULT_PREFIX}${runId}.json`), text);
    } catch {
      throw new RecordWriteError("The evaluation record could not be written. No audit file exists for this run.", summary());
    }
    return record;
  };

  // Expired data that cannot be removed means the stated retention cannot be honoured: do not start a live run.
  if (purgeFailures.length > 0 || stateFailures.length > 0) {
    if (options.mode === "live" && purgeFailures.length > 0) {
      record.status = "blocked";
      record.stop = { code: "retention-cleanup-failed", detail: `${purgeFailures.length} expired record or raw-response file(s) could not be removed; resolve this before a live run.`, scenarioId: null };
      return finish();
    }
    record.notes.push(`${purgeFailures.length + stateFailures.length} expired or stale file(s) or director(ies) could not be removed.`);
  }

  // Live preflight and construction of the one analyze function. Nothing is built in dry-run.
  let liveAnalyze: AnalyzeFn | null = null;
  if (options.mode === "live") {
    try {
      defaultPreflight(env); // always the real guard; it cannot be replaced
      liveAnalyze = (options.analyzeFactory ?? (() => createGeminiAnalyzeFn()))();
    } catch (err) {
      record.status = "blocked";
      record.stop = { code: "preflight-failed", detail: safeText(err instanceof Error ? err.message : "Preflight failed.", env), scenarioId: null };
      return finish();
    }
  }

  const stateDir = mkdtempSync(join(stateRoot, STATE_PREFIX));
  const meter = new RequestMeter(maxAttempts);
  const control = { aborted: false };
  let invalidResponses = 0;
  try {
    for (let i = 0; i < scenarios.length; i++) {
      const s = scenarios[i]!;
      if (record.actual.assessmentAttempts >= maxAttempts) {
        record.status = "stopped";
        record.stop = { code: "attempt-cap", detail: `The cap of ${maxAttempts} assessment attempts was reached.`, scenarioId: s.id };
        break;
      }
      const elapsed = clock() - t0;
      if (elapsed >= maxBatchMs) {
        record.status = "stopped";
        record.stop = { code: "deadline-exceeded", detail: `The batch deadline of ${maxBatchMs} ms had passed before this scenario started; it was not run.`, scenarioId: s.id };
        break;
      }
      record.actual.assessmentAttempts++;

      let rec: ScenarioRecord;
      const work = runScenario(s, { options, env, now, meter, liveAnalyze, stateDir, runId, record, control });
      work.catch(() => { /* a late rejection after the deadline must not crash the process */ });
      try {
        const timed = await withDeadline(work, maxBatchMs - elapsed);
        if (timed.timedOut) {
          // The call may still be in flight. Nothing it later does is kept, and it is never reported as a success.
          control.aborted = true;
          meter.closed = true;
          rec = notRun(s);
          rec.startedAt = now().toISOString();
          rec.finishedAt = rec.startedAt;
          rec.assessmentAttempts = 1;
          rec.providerRequestsAttempted = meter.perScenario.get(s.id) ?? 0;
          rec.outcome = "fail";
          rec.stopConditions.push({ code: "deadline-exceeded", detail: `The batch deadline of ${maxBatchMs} ms passed while this scenario was running; its result is unknown and the request may still be in flight.` });
          rec.evidenceCheck = { status: "flagged", reasons: ["The scenario did not finish before the batch deadline; no result can be relied on."] };
        } else {
          rec = timed.value;
        }
      } catch (err) {
        // Anything unexpected, wherever it happened: record it, count what the meter saw, and stop. No retry.
        rec = notRun(s);
        rec.startedAt = now().toISOString();
        rec.finishedAt = rec.startedAt;
        rec.assessmentAttempts = 1;
        rec.providerRequestsAttempted = meter.perScenario.get(s.id) ?? 0;
        rec.outcome = "fail";
        rec.stopConditions.push({ code: "infrastructure", detail: safeText(err instanceof Error ? err.message : "Unexpected error.", env) || "Unexpected error." });
        rec.evidenceCheck = { status: "flagged", reasons: ["The scenario ended with an unexpected error; no result can be relied on."] };
      }
      record.scenarios[i] = rec;
      record.actual.providerRequestsAttempted = meter.total;
      if (rec.mode === "rules-based-fallback") record.actual.fallbackRuns++;
      // A provider failure (timeout, error, blocked) is counted as a fallback; only a response that arrived but was rejected counts as invalid.
      if (rec.fallback.used && rec.fallback.reason !== "ai-reasoning") invalidResponses++;

      const stops = [...rec.stopConditions];
      if (meter.violations > 0) stops.push({ code: "request-limit", detail: "A request beyond the limits was attempted and refused." });
      if (invalidResponses >= 2) stops.push({ code: "repeated-invalid", detail: "Two analyze attempts produced invalid or ungrounded findings." });
      if (record.actual.fallbackRuns >= 2) stops.push({ code: "live-path-unusable", detail: "Two live attempts fell back to the rules-based analysis." });
      if (stops.length > 0) {
        rec.stopConditions = stops;
        record.status = "stopped";
        record.stop = { ...stops[0]!, scenarioId: s.id };
        break; // no continuation after a stop; remaining scenarios stay "not-run"
      }
    }
  } finally {
    control.aborted = true; // anything still running after this point may not write or record anything
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* reported by the stale-state sweep of a later run */ }
  }
  return finish();
}

interface RunCtx {
  options: RunnerOptions; env: NodeJS.ProcessEnv; now: () => Date; meter: RequestMeter; liveAnalyze: AnalyzeFn | null;
  stateDir: string; runId: string; record: BatchRecord; control: { aborted: boolean };
}

async function runScenario(s: Scenario, ctx: RunCtx): Promise<ScenarioRecord> {
  const { env, options } = ctx;
  const rec = notRun(s);
  rec.startedAt = ctx.now().toISOString();
  rec.assessmentAttempts = 1;

  const norm = normalizeAssessmentInput(s.payload as any);
  if (!norm.ok) {
    rec.outcome = "fail";
    rec.stopConditions.push({ code: "infrastructure", detail: "The scenario did not normalise." });
    rec.finishedAt = ctx.now().toISOString();
    return rec;
  }
  const offline = analyzeEvidence(norm.datasets, norm.context, norm.coverageStats);
  const run = (analyze: AnalyzeFn, tag: string) =>
    runPipeline({ stateFile: join(ctx.stateDir, `${s.id}-${tag}.json`), scenario: norm.provenance.requirementId, fetchDatasets: async () => norm.datasets as any, analyze });

  let report: Awaited<ReturnType<typeof runPipeline>>;
  let captured: unknown = null;
  const before = ctx.meter.total;
  if (options.mode === "dry-run") {
    report = await run(async () => offline, "dry");
    rec.mode = "offline-dry-run";
  } else {
    report = await run(ctx.meter.wrap(s.id, ctx.liveAnalyze!, (r) => { captured = r; }), "live");
    rec.mode = "gemini";
  }
  if (ctx.control.aborted) return rec; // the batch deadline passed while this was running: discard everything
  rec.providerRequestsAttempted = ctx.meter.total - before;
  rec.validation = { agentOutputValid: report.agentOutputValid, adapterOk: report.adapterOk };

  const failedStep = (report.pipelineTrace as Array<{ step: string; ok?: boolean }>).find((t) => LIVE_FAILURE_STEPS.includes(t.step) && t.ok === false);
  let finalReport = report;
  if (options.mode === "live" && failedStep) {
    // One attempt only. The application's own offline fallback is recorded, labelled as a fallback.
    rec.fallback = { used: true, reason: safeText(failedStep.step, env) };
    finalReport = await run(async () => offline, "fallback");
    rec.mode = "rules-based-fallback";
    if (ctx.control.aborted) return rec;
  }

  const guardFailure = (report.pipelineTrace as Array<{ step: string; detail?: string }>).some((t) => t.step === "ai-reasoning" && /was not attempted/.test(t.detail ?? ""));
  if (guardFailure) rec.stopConditions.push({ code: "infrastructure", detail: "The provider guard refused the request (configuration)." });

  const crossDetail = (report.pipelineTrace as Array<{ step: string; detail?: string }>).find((t) => t.step === CROSS_CHECK_STEP)?.detail ?? "";
  rec.crossCheck = { confirmed: (crossDetail.match(/\[confirmed\]/g) ?? []).length, heuristic: (crossDetail.match(/\[heuristic\]/g) ?? []).length };
  // The trace of the first (live) attempt is the informative one; a fallback re-run is summarised by `fallback`.
  rec.trace = (report.pipelineTrace as Array<{ step: string; ok?: boolean; detail?: string }>).map((t) => ({ step: t.step, ok: t.ok ?? null, detail: safeText(t.detail ?? "", env) }));

  rec.observed = { decision: finalReport.releaseDecision ?? null, rule: finalReport.firedRule ?? null };
  const matches = matchesExpected(s.expected, rec.observed.decision, rec.observed.rule, finalReport.reasons ?? []);
  rec.outcome = matches ? "pass" : "fail";
  if (!matches) rec.stopConditions.push({ code: "decision-mismatch", detail: `Observed ${rec.observed.decision}/${rec.observed.rule}, expected ${s.expected.decision}/${s.expected.rule}.` });

  const responseForReview = captured ?? (options.mode === "dry-run" ? offline : null);
  if (captured !== null) {
    const keys = new Set<string>();
    collectKeys(captured, keys);
    rec.measures.forbiddenKeysInResponse = [...FORBIDDEN_OUTPUT_KEYS].map((k) => String(k).toLowerCase()).filter((k) => keys.has(k));
    if (rec.measures.forbiddenKeysInResponse.length > 0) rec.stopConditions.push({ code: "override-attempt", detail: `The AI response contained decision-like keys: ${rec.measures.forbiddenKeysInResponse.join(", ")}.` });
  }
  if (responseForReview) rec.measures.unknownIdTokens = unknownIdTokens(responseForReview, { datasets: norm.datasets, payload: s.payload });

  // Evidence check: anything the automated checks flag is marked for human review. A scenario cannot read as clean
  // when an id is unknown, the evidence contradicts the AI, the AI tried to decide, or the AI result was not used.
  if (options.mode === "dry-run") {
    rec.evidenceCheck = { status: "not-applicable", reasons: ["Dry-run: no AI output was involved."] };
  } else {
    const reasons: string[] = [];
    if (rec.measures.unknownIdTokens.length > 0) reasons.push(`Id-shaped tokens not found in the evidence: ${rec.measures.unknownIdTokens.join(", ")}.`);
    if (rec.crossCheck.confirmed > 0) reasons.push(`${rec.crossCheck.confirmed} confirmed contradiction(s) with the structured evidence.`);
    if (rec.crossCheck.heuristic > 0) reasons.push(`${rec.crossCheck.heuristic} heuristic warning(s).`);
    if (rec.measures.forbiddenKeysInResponse.length > 0) reasons.push("The AI response contained decision-like keys.");
    if (rec.fallback.used) reasons.push("The AI result was rejected or unavailable; the result shown is the rules-based fallback.");
    rec.evidenceCheck = { status: reasons.length > 0 ? "flagged" : "clean", reasons };
  }

  // Raw response for human review: live Gemini output only, outside the repository, scanned first.
  if (options.mode === "live" && options.rawDir && captured !== null && !ctx.control.aborted) {
    const file = { evaluationSetVersion: EVALUATION_SET_VERSION, scenarioId: s.id, runId: ctx.runId, savedAt: ctx.now().toISOString(), syntheticDataOnly: true, response: captured };
    const text = JSON.stringify(file, null, 2);
    if (findSensitive(text, env).length > 0) {
      rec.stopConditions.push({ code: "sensitive-data", detail: "A raw response matched a secret pattern and was not saved." });
    } else {
      writeAtomic(join(options.rawDir, `${RAW_PREFIX}${ctx.runId}-${s.id}.json`), text);
      rec.rawSaved = true;
      ctx.record.retention.rawStored = true;
    }
  }

  const hits = findSensitive(JSON.stringify(rec), env);
  if (hits.length > 0) {
    rec.trace = [];
    rec.stopConditions.push({ code: "sensitive-data", detail: `The scenario record matched ${hits.join(", ")}; its trace was withheld.` });
  }
  rec.finishedAt = ctx.now().toISOString();
  return rec;
}

/* ----------------------------------- CLI --------------------------------- */

export interface CliArgs { live: boolean; outDir?: string; rawDir?: string; retentionDays?: number; maxAttempts?: number; maxBatchSeconds?: number }

/** Accepts only the documented flags. Unknown arguments are rejected without being echoed (they could be credentials). */
export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { live: false };
  const valueOf = (i: number): string => { const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) throw new ConfigError("A flag is missing its value."); return v; };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--live": args.live = true; break;
      case "--out-dir": args.outDir = valueOf(i++); break;
      case "--raw-dir": args.rawDir = valueOf(i++); break;
      case "--retention-days": args.retentionDays = Number(valueOf(i++)); break;
      case "--max-attempts": args.maxAttempts = Number(valueOf(i++)); break;
      case "--max-batch-seconds": args.maxBatchSeconds = Number(valueOf(i++)); break;
      default: throw new ConfigError("Unknown argument. Allowed: --live, --out-dir, --raw-dir, --retention-days, --max-attempts, --max-batch-seconds.");
    }
  }
  return args;
}

export async function runCli(argv: string[], io: { out: (s: string) => void; err: (s: string) => void }, overrides: Partial<RunnerOptions> = {}): Promise<number> {
  try {
    const args = parseCliArgs(argv);
    const record = await runBatch({
      mode: args.live ? "live" : "dry-run",
      outDir: args.outDir ?? join(tmpdir(), "qa-agent-stage3b"),
      rawDir: args.rawDir, retentionDays: args.retentionDays, maxAttempts: args.maxAttempts,
      maxBatchMs: args.maxBatchSeconds === undefined ? undefined : args.maxBatchSeconds * 1000,
      ...overrides,
    });
    io.out(`Stage 3B runner (${record.mode}) ${record.status}. Attempts ${record.actual.assessmentAttempts}/${record.planned.maxAssessmentAttempts}; provider requests attempted ${record.actual.providerRequestsAttempted}; fallbacks ${record.actual.fallbackRuns}.\n`);
    if (record.analyzerSource === "injected") io.out("NOTE: an injected analyzer was used; this is a test run, not a valid live result.\n");
    for (const r of record.scenarios) {
      io.out(`  ${r.scenarioId}  ${r.outcome.padEnd(7)} ${r.mode.padEnd(22)} expected ${r.expected.decision}/${r.expected.rule}  observed ${r.observed.decision ?? "-"}/${r.observed.rule ?? "-"}  evidence: ${r.evidenceCheck.status}\n`);
      for (const reason of r.evidenceCheck.status === "flagged" ? r.evidenceCheck.reasons : []) io.out(`      REVIEW: ${reason}\n`);
    }
    if (record.stop) io.out(`Stopped: ${record.stop.code}${record.stop.scenarioId ? ` at ${record.stop.scenarioId}` : ""}. ${record.stop.detail}\n`);
    io.out(`Record: ${RESULT_PREFIX}${record.runId}.json in the output directory. Local cleanup does not delete provider-side copies; the runner does not control or know what the provider retains.\n`);
    if (record.humanReview.required) io.out(`Human review required: ${record.humanReview.note}\n`);
    if (record.status !== "completed" || !record.scenarios.every((r) => r.outcome === "pass")) return 1;
    return record.humanReview.flaggedScenarios.length > 0 ? 3 : 0; // 3: gate-correct, but evidence is flagged for review
  } catch (err) {
    if (err instanceof RecordWriteError) {
      io.err(`Error: ${safeText(err.message, process.env)}\nKnown in memory only (no audit file): ${err.summary}\n`);
      return 2;
    }
    io.err(`${err instanceof ConfigError ? "Configuration error" : "Error"}: ${safeText(err instanceof Error ? err.message : "", process.env)}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2), { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }).then(
    (code) => process.exit(code),
    () => { process.stderr.write("Error: the runner failed unexpectedly.\n"); process.exit(2); },
  );
}
