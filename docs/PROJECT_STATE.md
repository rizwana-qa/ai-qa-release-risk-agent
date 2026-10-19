# Project State

The latest **verified** status of the AI QA Release Risk Agent. Every line carries a label:

- `VERIFIED`: checked against the repository, a test run or the remote in the session named in the line.
- `IN PROGRESS`: work exists but is not complete or not committed.
- `BLOCKED`: cannot proceed without a stated approval or fact.
- `PROPOSED`: suggested, not approved.
- `NOT VERIFIED`: claimed or previously recorded, but not re-checked.

**This document is a snapshot, not a source of truth.** Current code, test output, Git history and a fresh remote check always win. If anything here disagrees with them, report the difference and update this file (`docs/PROJECT_SOP.md` section 5). It is updated by following that workflow, not automatically.

- **Snapshot taken:** 2026-10-20 during the task that created `docs/PROJECT_DNA.md`, `docs/PROJECT_SOP.md`, `docs/PROJECT_STATE.md` and `docs/DECISION_LOG.md`. **Updated** 2026-10-20 by the release documentation task, after the Production release: sections 1 to 5, 7 and 8 were revised and section 9 added. The remote and Production checks in sections 1 and 9 were read 2026-10-19 22:10 to 22:31 UTC; the test results in sections 3 and 4 come from runs made before the push and were not repeated.
- **Snapshot of commit:** `fc380947f14e344a105473043b5dfaa90204c092` (`fc38094`), the tip of `main`, `origin/main` and `ui-pdf-fidelity-pass`. Commits made after this one are not reflected. The first snapshot was taken at `2fd512d`.

## 1. Repository and remote

| Item | Value | Status |
| --- | --- | --- |
| Repository root | `D:/ai-qa-release-risk-agent` | VERIFIED |
| Branch | `ui-pdf-fidelity-pass` | VERIFIED |
| HEAD | `fc380947f14e344a105473043b5dfaa90204c092` (`fix: keep the default PDF at four pages when aiAttempt is neutral`), equal to local `main` | VERIFIED 2026-10-19 22:27 UTC |
| Remote | `origin`, an HTTPS GitHub URL with no embedded credentials | VERIFIED |
| Upstream | `origin/ui-pdf-fidelity-pass` | VERIFIED (tip equals local HEAD, next row) |
| Remote branch tips | `git ls-remote` returned `fc380947f14e344a105473043b5dfaa90204c092` for both `refs/heads/main` and `refs/heads/ui-pdf-fidelity-pass`, equal to local HEAD | VERIFIED 2026-10-19 22:27 UTC |
| `main` on the remote | `fc38094`, fast-forwarded from `60a7889462eae04415c363c21780c1411fae51df` (no merge commit; merge base `60a7889`). 21 commits, 64 files, +9982/-1562. The local reflog of `origin/main` records the push at 2026-10-20 02:08:32 +04:00 (22:08:32 UTC); GitHub's public event feed did not list it when checked at 22:31 UTC. No pull request was made. | VERIFIED |
| Hosting | The Vercel Production deployment of `main` is `fc38094` (section 9). Whether a Render deployment exists or was updated was not checked. | VERIFIED (Vercel); NOT VERIFIED (Render) |

## 2. Latest completed commits (all pushed and now on `main`; see section 1)

| Commit | Date | Scope | Status |
| --- | --- | --- | --- |
| `fc38094` | 2026-10-20 | `web/components.js` and `tests/webUnits.test.mjs`: the PDF layer prints only an `aiAttempt` warning (a request began and gave no usable findings, or none could start); the neutral notes stay on screen only, so the default report keeps its four pages. The earlier `c040fb0` print note had pushed it to five pages. 2 files | VERIFIED (`git log`; the four-page result was checked locally before the commit, not in Production) |
| `69ba93e` | 2026-10-20 | Docs only: adds `docs/PROJECT_DNA.md`, `docs/PROJECT_SOP.md`, `docs/PROJECT_STATE.md` and `docs/DECISION_LOG.md` | VERIFIED (`git log` subject) |
| `2fd512d` | 2026-10-20 | Docs only: section 20.12 of `docs/AI_EVALUATION_PLAN.md` records the candidate baseline digest next to the earlier one | VERIFIED |
| `c040fb0` | 2026-10-19 | `aiAttempt`: an additive response field `{ enabled, began, outcome, fallbackUsed }` recording whether a live AI request began before an offline fallback. A hook in the provider-backed analyze function fires immediately before the request and the pipeline writes it to its state file first. Shown in the report, Technical Details and PDF layer. Also corrects the fixture mode label, drops the hard-coded model name from the mode label, and fixes stale README, architecture and web README wording. 17 files | VERIFIED (in HEAD: `api/aiAttempt.ts`, `tests/aiAttempt.test.ts`) |
| `5a4cc50` | 2026-10-19 | Stage 2 disclosure: a notice on the Evidence screen, before Analyze, of what is sent to Gemini when enabled, what is not, the offline fallback and the failed-attempt case; a guarantee-pattern e2e check; unit tests tying the notice to what the normaliser sends; `docs/STAGE2_AI_DATA_HANDLING_AUDIT.md` | VERIFIED |
| `7ca9224` | 2026-10-19 | Stage 3B baseline: 12 synthetic evaluation scenarios, the controlled runner (dry-run default, cap of 4 requests, no retries, batch deadline, secret scanning, retention), the evaluation plan, and the Stage 1/2 hardening it exercises (response schema, fail-closed routing guard, error sanitising, AI-versus-evidence cross-check, generic system prompt, dataset wording). 18 files | VERIFIED |
| `35a7089`, `6eac2fd`, `1659f61`, `a5cc7d0` | 2026-10-19 | UI restyle with design tokens; sidebar workflow and decision dashboard redesign; the read-only Quality Gates page and API; the minimum-evidence gate rule GATE-6 | VERIFIED (from `git log` subjects) |
| `a744efe` and earlier | 2026-09-06 to 2026-10-17 | Initial Version 1, Vercel support, UI and PDF work | VERIFIED (from `git log` subjects) |

## 3. Evaluation baseline

| Item | Value | Status |
| --- | --- | --- |
| Scenario set version | `1.0.0` | VERIFIED |
| Scenario fingerprint (SHA-256 of the four approved scenarios' content and expected values) | `4cafeed74581c8e925c910f54b767db9a5c2b120b268668d39fc1cb3b30ae01c`; matches the pinned constant and an independent recomputation | VERIFIED 2026-10-20 |
| **Candidate** baseline digest at `c040fb0`, `2fd512d` and `fc38094` (SHA-256 over the 16 files in `BASELINE_FILES`, CRLF normalised) | `b7b5dd5fcd1e75bdb0c37a05ef4f6034063e5671db48b68b29f692209517752a`; recomputed from committed content at `c040fb0` and `2fd512d`, from the working tree by the runner, and reported unchanged by the Stage 3B dry run on a clean export of `main` at `fc38094` before the push (not re-run in the documentation task) | VERIFIED as a value. **PROPOSED as the baseline: not approved for live evaluation** |
| Earlier recorded digest at `7ca9224` and `5a4cc50` | `2a45ca17b006b6c71fd3ac282e013206cfc909841d7ca0fcda17686284a30a4d`; kept as history in `docs/AI_EVALUATION_PLAN.md` sections 20.1 and 20.12 | VERIFIED as a historical value; superseded as the candidate |
| What changed between them | Three digested files: `src/agentContract.ts`, `src/geminiAgent.ts`, `src/pipelineCli.ts` | VERIFIED |

A digest identifies the content of those 16 files only. It does not show that the content is safe, correct or approved.

## 4. Tests

| Run | Result | Status |
| --- | --- | --- |
| `npm run check` (typecheck plus all unit tests) on a clean `git archive` export of `main` at `fc38094`, run in the release session before the push | exit 0; 648 tests, 648 pass, 0 fail | VERIFIED in the release session; not re-run in the documentation task |
| Earlier run, 2026-10-20, working tree at `2fd512d` | exit 0; 647 tests, 128 suites, 647 pass. The one extra test at `fc38094` is the PDF-layer test added in that commit (`tests/webUnits.test.mjs`, now 86). Per-file counts then: `tests/releaseGate.test.ts` 59; `tests/evaluation.test.ts` 68; `tests/evaluationRunner.test.ts` 108; `tests/aiAttempt.test.ts` 38 | VERIFIED then; superseded by the row above |
| Stage 3B runner, offline dry-run, output outside the repository, on a clean export of `main` at `fc38094` before the push | four scenarios passed with the expected decisions (S01 GO/GATE-5, S05 NO_GO/GATE-1, S02 CONDITIONAL/GATE-6, S06 GO/GATE-5); `providerRequestsAttempted` 0 everywhere; digest unchanged (section 3) | VERIFIED in the release session; not re-run in the documentation task |
| Functional Playwright specs (everything in `tests/e2e/` except the two demo-recording specs; this includes `dataDisclosure.spec.ts`; `playwright test --list` with the same configuration reports 28 tests in 5 files) through a **scratch** configuration with the AI key and routing variables forced empty, using the installed Chrome | 28 passed, 0 failed. By the release session's record this ran on the branch working tree after the PDF fix and on a clean export of `main` before the push | VERIFIED in the release session; not re-run in the documentation task |
| Standard suite `npm run test:e2e` (all specs in `tests/e2e/`) | never run in the recorded work: the Chromium build the installed Playwright expects was not present on this machine when last checked (2026-10-19) | NOT VERIFIED |
| Production checks after the release (health, new routes, environment variables, one synthetic assessment) | see section 9 | VERIFIED |
| PDF output and a visual check of the screens **in Production** | not done; the four-page PDF was checked only locally | NOT VERIFIED |
| Live Gemini evaluation, live provider behaviour, latency, cost, retention | never run; there is no live evidence of any kind | NOT VERIFIED (BLOCKED by approvals, section 6) |
| n8n workflow end to end | not run or checked | NOT VERIFIED |

## 5. Known issues and limitations

1. **Gate-policy limitations (documented, expected decisions unchanged):** S06 (a criterion with a passing and a failing mapped test counts as covered; an open high defect does not block) and S09 (33% coverage at medium risk is GO). `docs/AI_EVALUATION_PLAN.md` section 10. VERIFIED.
2. **Attempt visibility limits.** `aiAttempt.began` means the call was initiated, not that the provider received it. A child-process run in which a request genuinely begins cannot be exercised offline; it is covered by the hook, state-file and builder tests together. The processing view still shows "AI QA analysis: done" after a silent fallback. VERIFIED from the code and tests.
3. **Documentation drift** (verified by reading the files on 2026-10-20; not yet fixed):
   - `README.md` quotes 242 tests (lines 214 and 232) and `docs/architecture.md` quotes 232 (line 410); the run before the push was 648 (`fc38094`).
   - `docs/architecture.md` (lines 307 and 411) describes one Playwright test; `tests/e2e/` has `assessment`, `dataDisclosure`, `minimumEvidence`, `qualityGates` and `responsive` specs plus two demo specs.
   - `README.md` (lines 341 and 355) and `docs/architecture.md` (line 386) say "five" gate rules; the gate evaluates `GATE-1`, `GATE-2`, `GATE-3`, `GATE-4`, `GATE-6`, `GATE-5` (six). `README.md` says Version 1 is Phases 1 to 7; `CLAUDE.md` says Phases 1 to 8.
   - `CLAUDE.md` describes the fallback as silent; the response now records `aiAttempt` (the edited `CLAUDE.md` in the working tree notes this).
4. **Provider facts are unresolved** (tier and billing, data-use and retention terms, region, logging, model availability, key restrictions, quota). `docs/STAGE2_AI_DATA_HANDLING_AUDIT.md` section 7.5 and `docs/AI_EVALUATION_PLAN.md` sections 13, 17 and 20.9. No residency, compliance or retention claim is made anywhere. NOT VERIFIED.
5. **Positioning questions are unresolved** (`docs/PROJECT_DNA.md` section F).
6. **The push of `fc38094` to `main` produced no Vercel build.** That SHA had been built as a Preview 11 minutes earlier. The project's Ignored Build Step is `Automatic`, which Vercel describes as skipping builds for commits with a previously deployed SHA (setting and help text VERIFIED). That this setting caused the missing build is an inference: no Vercel log or event states it (`docs/DECISION_LOG.md` D-017). If the inference is right, a future fast-forward of `main` to an already-previewed commit would behave the same. No settings were changed.
7. **Unexplained API behaviour.** The two `create_deployment` calls used to create the Production deployment both returned HTTP 403 errors, yet one Production deployment (`dpl_2hmM7mtaRRMEDhiMactYm1QQ1T6y`) appeared. Which call created it is unknown (D-017). NOT VERIFIED.

## 6. Unresolved approvals (live evaluation is BLOCKED)

All items in `docs/AI_EVALUATION_PLAN.md` sections 15, 20.9 and 20.11, in particular: approval of the candidate digest; approval of the pass bars, the first batch (S01, S05, S02, S06), the request cap and the deadline; verification of the Google product, tier, terms, model and key; a dedicated restricted key and its delivery to the process; a spend ceiling and budget alert; named reviewer and stop authority; the local retention policy and storage location. None is recorded as given. The runner has never been run with `--live`.

## 7. Working tree that must be preserved (`git status --short`, 2026-10-20, before this task's edits)

```
 M .gitignore                (user: adds a video/out/ ignore rule)
 M CLAUDE.md                 (user: rewritten project instructions, plus the "Start here" section added with the governance documents)
?? AI_Release_Intelligence_UI_and_PDF_Design_Concepts.pdf
?? "Regression and Release Readiness Summary.png"
?? "Review PDF Design QA_files/"
?? design-proposal/
?? docs/EMPTY_EVIDENCE_DECISION_REVIEW.md
?? docs/MINIMUM_EVIDENCE_POLICY_PLAN.md
?? docs/QA_RELEASE_RISK_AGENT_MARKET_RESEARCH.md
?? video/
```

None of these is part of any commit, including `fc38094`; the list above was re-checked with `git status --short` at the start of the release documentation task and was unchanged. Do not stage, rewrite or delete them without instruction. The four governance documents were committed in `69ba93e`; this update to two of them is uncommitted. `CLAUDE.md` carries the user's earlier uncommitted rewrite plus the start-here section and was deliberately left uncommitted: `IN PROGRESS` until the owner decides.

## 8. Single recommended next action

**Review the `CLAUDE.md` entry-point change and decide whether to commit it** (explicit path; it also contains the user's earlier uncommitted rewrite, so decide whether that goes in the same commit; no push without a separate instruction). Until it is committed, a fresh session that reads only the committed `CLAUDE.md` will not be pointed at the four governance documents. Prerequisite: the owner's review of `docs/PROJECT_DNA.md` section F (unresolved questions) and `docs/PROJECT_SOP.md` section 2 (approval policy).

After that, the next engineering step remains `BLOCKED` on the approvals in section 6; live evaluation must not start until they are given.

Not an action item, but plan for it: before the next release, decide how `main` will get a Production build when its commit has already been built as a Preview (section 5 item 6, `docs/DECISION_LOG.md` D-017). Changing the Vercel Ignored Build Step is a project-setting change that needs the owner's approval.

## 9. Production deployment (Vercel), verified after the release

All values below were read on 2026-10-19 between 22:17 and 22:27 UTC (2026-10-20 local) unless a time is given. Nothing was read from or written to environment-variable values, and no provider was called.

| Item | Value | Status |
| --- | --- | --- |
| Project and repository | Vercel project `ai-qa-release-risk-agent`, connected to `rizwana-qa/ai-qa-release-risk-agent` | VERIFIED |
| Production URL | `https://ai-qa-release-risk-agent.vercel.app`, the existing and only project domain; it is aliased to the deployment below and was not changed. Requested without a session, the Production domain answered HTTP 200 while the new deployment's own `*.vercel.app` URL answered HTTP 302 (Vercel sign-in) | VERIFIED |
| Production branch | `main` ("Every commit pushed to the main branch will create a Production Deployment", Settings, Environments, Production) | VERIFIED |
| Current Production deployment | `dpl_2hmM7mtaRRMEDhiMactYm1QQ1T6y`: state `READY`, target `production`, source `git`, ref `main`, commit `fc380947f14e344a105473043b5dfaa90204c092`. Created 22:21:50 UTC, ready 22:22:21 UTC. Aliases include `ai-qa-release-risk-agent.vercel.app`; `aliasError` null | VERIFIED |
| Previous Production deployment | `dpl_DwQ7kR2YNdq4bqYMjvRvgi6ihcCo`: commit `60a7889`, created 2026-10-19 21:05 UTC (a redeploy; the dashboard names `RX5FTvaxP` as its source), listed by Vercel as a rollback candidate | VERIFIED (listing); rollback never exercised |
| Preview of the same commit | `dpl_BzTCYAK1QMKDVounmLjoLocqVo5K`: `READY`, ref `ui-pdf-fidelity-pass`, built 21:57 UTC | VERIFIED |
| Health | `GET /api/health` returned HTTP 200, body `{"ok":true,"synthetic":true}` (22:22 and 22:27 UTC) | VERIFIED |
| New code is served | `GET /api/quality-gates` returned HTTP 200 (9474 bytes) after returning 404 until the deployment was ready; the served `app.js`, `components.js`, `workspace.js` and `gates.js` contain the new `aiAttempt` and Quality Gates code | VERIFIED |
| Environment variables | The project's variable list is empty (Vercel API: no variables, 0 hidden Production variables), so there is no `GEMINI_API_KEY`. Names and counts only; no values read | VERIFIED |
| Synthetic assessment (one request) | `POST /api/assess/custom` with the S01 fixture from `tests/evaluation/scenarios.ts`: HTTP 200 in 0.4 s; `mode: "rules-based"`; `aiAttempt` = `{ enabled: false, began: false, outcome: "not-attempted", fallbackUsed: false }`; `releaseDecision` GO from `GATE-5`, matching the offline expectation for S01; `decisionAuthority` states the deterministic gate; `agentOutputValid` and `adapterOk` true. The response mentions `GEMINI_API_KEY` only in explanatory text, and contains no key-shaped string | VERIFIED |
| Gemini in Production | No request to any provider is possible from this deployment because no key is configured; the assessment in this check reported that none was attempted | VERIFIED (by the response and the empty variable list) |
| Not checked in Production | PDF/print output; a browser walk-through of the screens, including Quality Gates and mobile layout; runtime logs; Google-side usage counters; the standard `npm run test:e2e` | NOT VERIFIED |
| Why the push did not build | The Git integration built nothing for the push. Vercel's Automatic Ignored Build Step skips an already-built SHA (section 5 item 6), which is an inference, not a logged cause (D-017). A Production deployment was created through the Vercel API instead | VERIFIED (no build, setting); cause NOT directly observed |
