# Project State

The latest **verified** status of the AI QA Release Risk Agent. Every line carries a label:

- `VERIFIED`: checked against the repository, a test run or the remote in the session named in the line.
- `IN PROGRESS`: work exists but is not complete or not committed.
- `BLOCKED`: cannot proceed without a stated approval or fact.
- `PROPOSED`: suggested, not approved.
- `NOT VERIFIED`: claimed or previously recorded, but not re-checked.

**This document is a snapshot, not a source of truth.** Current code, test output, Git history and a fresh remote check always win. If anything here disagrees with them, report the difference and update this file (`docs/PROJECT_SOP.md` section 5). It is updated by following that workflow, not automatically.

- **Snapshot taken:** 2026-10-20 during the task that created `docs/PROJECT_DNA.md`, `docs/PROJECT_SOP.md`, `docs/PROJECT_STATE.md` and `docs/DECISION_LOG.md`.
- **Snapshot of commit:** `2fd512d151a8024d5232484fb96a852d94ced32c`. Commits made after this one are not reflected.

## 1. Repository and remote

| Item | Value | Status |
| --- | --- | --- |
| Repository root | `D:/ai-qa-release-risk-agent` | VERIFIED |
| Branch | `ui-pdf-fidelity-pass` | VERIFIED |
| HEAD | `2fd512d151a8024d5232484fb96a852d94ced32c` (`docs: record candidate Stage 3B baseline digest`) | VERIFIED |
| Remote | `origin`, an HTTPS GitHub URL with no embedded credentials | VERIFIED |
| Upstream | `origin/ui-pdf-fidelity-pass`; local branch 0 ahead and 0 behind after a fetch | VERIFIED |
| Remote branch tip | `git ls-remote` on 2026-10-20 returned `2fd512d151a8024d5232484fb96a852d94ced32c` for `refs/heads/ui-pdf-fidelity-pass`, equal to local HEAD | VERIFIED |
| `main` on the remote | `60a7889462eae04415c363c21780c1411fae51df`; this branch has not been merged into it, and no merge or pull request was made in the recorded work | VERIFIED (tip); merge status of any PR NOT VERIFIED |
| Any deployment built from this branch | Unknown: the repository has `Dockerfile`, `render.yaml` and Vercel entry points, but no check of any hosting service was made | NOT VERIFIED |

## 2. Latest completed commits (all pushed; see section 1)

| Commit | Date | Scope | Status |
| --- | --- | --- | --- |
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
| **Candidate** baseline digest at `c040fb0` and HEAD (SHA-256 over the 16 files in `BASELINE_FILES`, CRLF normalised) | `b7b5dd5fcd1e75bdb0c37a05ef4f6034063e5671db48b68b29f692209517752a`; recomputed from committed content at both commits and from the working tree by the runner | VERIFIED as a value. **PROPOSED as the baseline: not approved for live evaluation** |
| Earlier recorded digest at `7ca9224` and `5a4cc50` | `2a45ca17b006b6c71fd3ac282e013206cfc909841d7ca0fcda17686284a30a4d`; kept as history in `docs/AI_EVALUATION_PLAN.md` sections 20.1 and 20.12 | VERIFIED as a historical value; superseded as the candidate |
| What changed between them | Three digested files: `src/agentContract.ts`, `src/geminiAgent.ts`, `src/pipelineCli.ts` | VERIFIED |

A digest identifies the content of those 16 files only. It does not show that the content is safe, correct or approved.

## 4. Tests

| Run | Result | Status |
| --- | --- | --- |
| `npm run check` (typecheck plus all unit tests), 2026-10-20, working tree at `2fd512d` | exit 0; 647 tests, 128 suites, 647 pass, 0 fail, 0 cancelled, 0 skipped | VERIFIED this session |
| Per file, same session: `tests/releaseGate.test.ts` 59; `tests/evaluation.test.ts` 68; `tests/evaluationRunner.test.ts` 108; `tests/aiAttempt.test.ts` 38; `tests/webUnits.test.mjs` 85 | all pass inside the run above | VERIFIED this session |
| Stage 3B runner, offline dry-run, output outside the repository, last run 2026-10-20 before the push | four scenarios passed with the expected decisions (S01 GO/GATE-5, S05 NO_GO/GATE-1, S02 CONDITIONAL/GATE-6, S06 GO/GATE-5); `providerRequestsAttempted` 0 everywhere | VERIFIED at `c040fb0` and again before the push at `2fd512d` (the docs-only commit does not change the digest inputs); not re-run in this task |
| Disclosure end-to-end spec (`tests/e2e/dataDisclosure.spec.ts`, 6 tests) through a **scratch** Playwright configuration with the AI key forced empty | 6 passed in the working tree just before `c040fb0` was committed (the same content as HEAD for the web files) | NOT VERIFIED for the current HEAD (not re-run in this task) |
| Standard suite `npm run test:e2e` (all specs in `tests/e2e/`) | never run in the recorded work: the Chromium build the installed Playwright expects was not present on this machine when last checked (2026-10-19) | NOT VERIFIED |
| Live Gemini evaluation, live provider behaviour, latency, cost, retention | never run; there is no live evidence of any kind | NOT VERIFIED (BLOCKED by approvals, section 6) |
| n8n workflow end to end, deployed site | not run or checked | NOT VERIFIED |

## 5. Known issues and limitations

1. **Gate-policy limitations (documented, expected decisions unchanged):** S06 (a criterion with a passing and a failing mapped test counts as covered; an open high defect does not block) and S09 (33% coverage at medium risk is GO). `docs/AI_EVALUATION_PLAN.md` section 10. VERIFIED.
2. **Attempt visibility limits.** `aiAttempt.began` means the call was initiated, not that the provider received it. A child-process run in which a request genuinely begins cannot be exercised offline; it is covered by the hook, state-file and builder tests together. The processing view still shows "AI QA analysis: done" after a silent fallback. VERIFIED from the code and tests.
3. **Documentation drift** (verified by reading the files on 2026-10-20; not yet fixed):
   - `README.md` quotes 242 tests (lines 214 and 232) and `docs/architecture.md` quotes 232 (line 410); the current run is 647.
   - `docs/architecture.md` (lines 307 and 411) describes one Playwright test; `tests/e2e/` has `assessment`, `dataDisclosure`, `minimumEvidence`, `qualityGates` and `responsive` specs plus two demo specs.
   - `README.md` (lines 341 and 355) and `docs/architecture.md` (line 386) say "five" gate rules; the gate evaluates `GATE-1`, `GATE-2`, `GATE-3`, `GATE-4`, `GATE-6`, `GATE-5` (six). `README.md` says Version 1 is Phases 1 to 7; `CLAUDE.md` says Phases 1 to 8.
   - `CLAUDE.md` describes the fallback as silent; the response now records `aiAttempt` (the edited `CLAUDE.md` in the working tree notes this).
4. **Provider facts are unresolved** (tier and billing, data-use and retention terms, region, logging, model availability, key restrictions, quota). `docs/STAGE2_AI_DATA_HANDLING_AUDIT.md` section 7.5 and `docs/AI_EVALUATION_PLAN.md` sections 13, 17 and 20.9. No residency, compliance or retention claim is made anywhere. NOT VERIFIED.
5. **Positioning questions are unresolved** (`docs/PROJECT_DNA.md` section F).

## 6. Unresolved approvals (live evaluation is BLOCKED)

All items in `docs/AI_EVALUATION_PLAN.md` sections 15, 20.9 and 20.11, in particular: approval of the candidate digest; approval of the pass bars, the first batch (S01, S05, S02, S06), the request cap and the deadline; verification of the Google product, tier, terms, model and key; a dedicated restricted key and its delivery to the process; a spend ceiling and budget alert; named reviewer and stop authority; the local retention policy and storage location. None is recorded as given. The runner has never been run with `--live`.

## 7. Working tree that must be preserved (`git status --short`, 2026-10-20, before this task's edits)

```
 M .gitignore                (user: adds a video/out/ ignore rule)
 M CLAUDE.md                 (user: rewritten project instructions; being extended by this task)
?? AI_Release_Intelligence_UI_and_PDF_Design_Concepts.pdf
?? "Regression and Release Readiness Summary.png"
?? "Review PDF Design QA_files/"
?? design-proposal/
?? docs/EMPTY_EVIDENCE_DECISION_REVIEW.md
?? docs/MINIMUM_EVIDENCE_POLICY_PLAN.md
?? docs/QA_RELEASE_RISK_AGENT_MARKET_RESEARCH.md
?? video/
```

None of these is part of any commit at the snapshot commit. Do not stage, rewrite or delete them without instruction. At snapshot time the task that wrote this file had added `docs/PROJECT_DNA.md`, `docs/PROJECT_SOP.md`, `docs/PROJECT_STATE.md` and `docs/DECISION_LOG.md` as new files (committed afterwards by explicit instruction; check `git log`) and had extended `CLAUDE.md` with a start-here section. `CLAUDE.md` also carries the user's earlier uncommitted rewrite and was deliberately left uncommitted: `IN PROGRESS` until the owner decides.

## 8. Single recommended next action

**Review the `CLAUDE.md` entry-point change and decide whether to commit it** (explicit path; it also contains the user's earlier uncommitted rewrite, so decide whether that goes in the same commit; no push without a separate instruction). Until it is committed, a fresh session that reads only the committed `CLAUDE.md` will not be pointed at the four governance documents. Prerequisite: the owner's review of `docs/PROJECT_DNA.md` section F (unresolved questions) and `docs/PROJECT_SOP.md` section 2 (approval policy).

After that, the next engineering step remains `BLOCKED` on the approvals in section 6; live evaluation must not start until they are given.
