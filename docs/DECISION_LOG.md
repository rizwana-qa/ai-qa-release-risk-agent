# Decision Log

Material decisions for the AI QA Release Risk Agent, recoverable from the repository's documents, code and Git history. Append new entries at the end; do not rewrite old ones except to mark them superseded (`docs/PROJECT_SOP.md` section 5).

**How to read the dates and approvals.** A date is the date of the commit or document that records the decision. The repository does not record who approved a decision or when. Where the plan documents say a decision was made (for example "[DECIDED]") that is quoted as written; the approval itself is not independently verifiable from Git. Details that could not be recovered are marked **uncertain**.

Status values: `accepted`, `rejected`, `proposed`, `superseded`.

---

## D-001. A deterministic gate owns the release decision; the AI only advises
- **Date:** 2026-09-06 (initial commit `b4a541a`; the first-written rule in `README.md` and `CLAUDE.md`). Exact decision date **uncertain**.
- **Decision:** Only `evaluateReleaseGate()` produces `GO`, `CONDITIONAL` or `NO_GO`. The model explains risk, never decides, and output containing decision-like keys is rejected. The gate input is built from dataset facts, not model claims.
- **Context:** README "Problem": LLM-made release decisions are non-deterministic and not defensible; the project explores whether AI can speed up QA analysis while a deterministic gate keeps the decision safe and explainable.
- **Alternatives:** letting the LLM decide (rejected in the README as indefensible).
- **Status:** accepted.
- **Evidence:** `README.md`, `CLAUDE.md` invariants, `src/releaseGate.ts`, `src/agentOutputValidation.ts`, `src/findingsAdapter.ts`, `docs/MINIMUM_EVIDENCE_POLICY_PLAN.md` section 1 item 4.
- **Revisit if:** the product is repositioned so that a person must sign the decision, or the gate becomes configurable per organisation. Either would be a new decision, not an edit of this one.

## D-002. Keep Version 1 small: one synthetic scenario, no databases or extra agents
- **Date:** 2026-09-06 (initial commit `b4a541a`, original `CLAUDE.md` "Core rule: keep Version 1 small"). **Uncertain** beyond that.
- **Decision:** One synthetic banking scenario (`REQ-BEN-001`); no company, client or customer data; no real banking integration, database, extra scenarios or multiple agents; no invented metrics or production-readiness claims; ask before adding major scope or dependencies.
- **Status:** accepted for Version 1. Whether the project outgrows this is open (`docs/PROJECT_DNA.md` section F4).
- **Evidence:** `CLAUDE.md`, `README.md` "Limitations & non-goals".
- **Note:** the web application later accepts user-submitted evidence (`api/inputNormalizer.ts`); the repository's own data stays synthetic.
- **Revisit if:** the owner decides to build toward pilots (persistence, authentication, reviewer sign-off, stored records) as the market research suggests would be needed.

## D-003. Deploy primarily as a Docker image on Render; Vercel serverless as a secondary path
- **Date:** 2026-09-06 (`dc95aa5`, `7350bbe`).
- **Decision:** Because the pipeline spawns child processes and writes temporary files, the primary target is the Docker image on Render; Vercel entry points reuse the in-process pipeline.
- **Status:** accepted.
- **Evidence:** `docs/deployment.md`, `Dockerfile`, `render.yaml`, `vercel.json`, `api/_vercelShared.ts`.
- **Revisit if:** the hosting target changes. Whether any host currently builds from the working branch is **not verified**.

## D-004. Web interface redesign and design tokens
- **Date:** 2026-10-16 to 2026-10-19 (`0374d26`, `f7aa7c4`, `cfa9852`, `a744efe`, `6eac2fd`, `35a7089`).
- **Decision:** A staged light enterprise workspace (sidebar workflow, decision dashboard), a PDF layer that matches the web decision screen, and a calmer design-token restyle. Presentation only; no decision logic in `web/`.
- **Status:** accepted (committed and pushed).
- **Evidence:** the commit history above. Rationale beyond the commit subjects is **uncertain**; no design document is committed (`design-proposal/` is untracked user work).

## D-005. Minimum-evidence rule GATE-6: no passing mapped test means at most CONDITIONAL
- **Date:** 2026-10-19 (`a5cc7d0`); the plan document is `docs/MINIMUM_EVIDENCE_POLICY_PLAN.md` (untracked).
- **Decision:** At least one passing test mapped to a criterion is the minimum for GO eligibility; otherwise `CONDITIONAL`. Three decision values stay. The gate stays authoritative. Existing critical-risk, security and defect rules stay. GATE-6 is additive: evaluated after GATE-4 and before GATE-5, so no gate was renumbered and the 0.8 illustrative threshold is unchanged. Where GATE-4 and GATE-6 would both apply, GATE-4 is reported (its existing id is kept).
- **Context:** `docs/EMPTY_EVIDENCE_DECISION_REVIEW.md` found that a submission with zero tests could return GO.
- **Alternatives considered:** the review's Option A (make the limitation prominent and pin current behaviour) versus changing the gate. The plan lists decisions marked "[DECIDED]" that imply a gate change. Its own header says "plan only, awaiting approval"; the approval is evidenced only by the later implementation commit and is not recorded in the document.
- **Status:** accepted (implemented and tested).
- **Evidence:** `src/releaseGate.ts` (`EVALUATION_ORDER`), `tests/releaseGate.test.ts`, the plan document.
- **Revisit if:** the product decides that failing mapped tests, or low coverage at medium risk, should affect the decision (see D-011).

## D-006. A read-only Quality Gates page that evaluates nothing
- **Date:** 2026-10-19 (`1659f61`).
- **Decision:** Publish the rules and fixed policy in the interface from `GATE_RULES` and `EVALUATION_ORDER`; a test fails if its prose drifts from the rules; headings use presentation-only case conversion.
- **Status:** accepted.
- **Evidence:** `api/qualityGates.ts`, `web/gates.js`, `tests/qualityGates.test.ts`, `CLAUDE.md`.

## D-007. Harden the Gemini integration (Stage 1 and 2)
- **Date:** 2026-10-19 (`7ca9224`; analysis in `docs/STAGE2_AI_DATA_HANDLING_AUDIT.md`).
- **Decision:** Constrain the model with a response schema and a generic system prompt; refuse to call (fail closed) if any of seven SDK routing variables is set; pin the Developer API with `vertexai:false` and take the key only from `GEMINI_API_KEY`; sanitise provider errors; add a deterministic AI-versus-evidence cross-check; stop telling the model that submitted evidence is synthetic.
- **Context:** the audit found the SDK can switch product or endpoint from the environment, errors could reach reports, and the dataset wording made claims the application cannot know.
- **Status:** accepted (implemented, tested offline).
- **Evidence:** `src/geminiAgent.ts`, `src/providerError.ts`, `src/aiCrossCheck.ts`, `api/inputNormalizer.ts`, `tests/dataHandling.test.ts`, `tests/geminiHardening.test.ts`.
- **Revisit if:** the SDK is upgraded (the routing list was read from version 1.52.0) or a different provider product is approved.

## D-008. A fixed synthetic evaluation set whose expected results come from the real gate
- **Date:** 2026-10-19 (`7ca9224`).
- **Decision:** Twelve invented scenarios (one non-banking); expected decisions, rules and reasons were derived by running the real gate offline, not hand-written; gate correctness is evaluated separately from AI narrative quality; the gate stays authoritative.
- **Status:** accepted.
- **Evidence:** `tests/evaluation/scenarios.ts`, `tests/evaluation.test.ts`, `docs/AI_EVALUATION_PLAN.md` sections 1 and 3.
- **Revisit if:** a scenario or expected value must change. That is a version change of the set and of its fingerprint.

## D-009. The Stage 3B runner: offline by default, tightly capped
- **Date:** 2026-10-19 (`7ca9224`).
- **Decision:** The runner defaults to dry-run; live mode needs an explicit `--live`; only S01, S05, S02, S06 in that order; at most four requests, one attempt per scenario, no retries; a batch deadline; secret scanning; local retention (7 days default); evidence flagged for human review; every record states whether the analyzer was the real one.
- **Status:** accepted as tooling. It has never been run live.
- **Evidence:** `tests/evaluation/runner.ts`, `tests/evaluationRunner.test.ts`, `docs/AI_EVALUATION_PLAN.md` sections 12 to 20.
- **Revisit if:** a different batch, cap or deadline is approved.

## D-010. The first live evaluation plan, pass bars and operating limits
- **Date:** proposed 2026-10-19 in `docs/AI_EVALUATION_PLAN.md` sections 11, 12 and 14.
- **Decision (proposed):** the measurable bars M1 to M9, the human-review criteria H1 to H4, a first batch of S01, S05, S02, S06, four requests, zero retries, the stop conditions in section 6.
- **Status:** **proposed**. The plan states these require owner approval before any live run; none is recorded as approved.
- **Revisit:** when the owner approves or changes them. They must be fixed before live output is seen.

## D-011. S06 and S09 are recorded as existing gate-policy limitations, not changed
- **Date:** 2026-10-19 (`docs/AI_EVALUATION_PLAN.md` section 10).
- **Decision:** Keep their expected decisions (both GO) and the gate unchanged; classify AI disagreements that stem from them as policy-limitation disagreements and report them rather than excluding them.
- **Status:** accepted for the evaluation. Whether the policy itself should change is a separate, unmade product decision.
- **Revisit if:** the owner decides failing mapped tests or low coverage at medium risk must influence the decision.

## D-012. Disclose external AI processing before analysis, without promising anything about the provider
- **Date:** 2026-10-19 (`5a4cc50`).
- **Decision:** An Evidence-screen notice before Analyze lists what is sent when Gemini is enabled and what is not; states that offline analysis makes no provider request and that a failed live attempt may already have sent the evidence; warns against secrets, personal data and confidential evidence; makes no residency, compliance, retention, deletion or security promise. An end-to-end check rejects promises but allows honest statements of uncertainty.
- **Status:** accepted.
- **Evidence:** `web/workspace.js`, `tests/e2e/dataDisclosure.spec.ts`, `tests/webUnits.test.mjs`, `docs/STAGE2_AI_DATA_HANDLING_AUDIT.md` sections 7.7 and 7.8.
- **Revisit if:** the provider terms are verified, or the application learns whether Gemini is enabled before submission (that needs a new API field).

## D-013. Record whether a live request began, as an additive `aiAttempt` field
- **Date:** 2026-10-19 (`c040fb0`).
- **Decision:** `{ enabled, began, outcome, fallbackUsed }`, set by a hook fired immediately before the provider request and written to the pipeline state first; `began` means initiated, not received; reporting only, never an input to validation, the adapter or the gate; booleans and fixed values only. An optional trailing `deps.createLiveAnalyze` on the in-process runners is a test seam not reachable from requests or the command line.
- **Context:** the report keeps one trace entry per step and the in-process path starts each run fresh, so a rules-based report after a failed live attempt looked the same as one where Gemini was disabled.
- **Alternatives considered:** changing the trace deduplication (rejected: it would change every trace display and test); inferring the attempt from key presence (rejected: configuration is not an attempt).
- **Status:** accepted (implemented, committed, pushed).
- **Evidence:** `api/aiAttempt.ts`, `src/geminiAgent.ts`, `src/pipelineCli.ts`, `tests/aiAttempt.test.ts`, `docs/STAGE2_AI_DATA_HANDLING_AUDIT.md` section 7.8.
- **Revisit if:** a provider-side receipt signal becomes available, or the response contract is versioned.

## D-014. Keep the old baseline digest as history and record a new one as a candidate
- **Date:** 2026-10-20 (`2fd512d`).
- **Decision:** `docs/AI_EVALUATION_PLAN.md` keeps `2a45ca17...` (commits `7ca9224`, `5a4cc50`) and records `b7b5dd5f...` (commit `c040fb0`) as a **candidate**, not approved for live evaluation. The scenario fingerprint is unchanged.
- **Status:** accepted as a record. The candidate's approval is **proposed**, not given.
- **Evidence:** `docs/AI_EVALUATION_PLAN.md` section 20.12; digests recomputed from committed content.
- **Revisit if:** any of the 16 digested files changes.

## D-015. Keep project knowledge in four governance documents
- **Date:** 2026-10-20 (this change).
- **Decision:** `docs/PROJECT_DNA.md` (enduring principles), `docs/PROJECT_SOP.md` (workflow and approvals), `docs/PROJECT_STATE.md` (verified snapshot) and this log, linked from `CLAUDE.md`; kept current by explicit workflow rules, not automatic synchronisation.
- **Status:** **proposed** until the owner reviews and commits them.
- **Revisit if:** the documents drift from the repository despite the rules, or are replaced by tooling.

## Q-001. Positioning: who is the user and what is valued? (open question)
- **Date:** 2026-10-19 (the research date stated in the untracked `docs/QA_RELEASE_RISK_AGENT_MARKET_RESEARCH.md`).
- **Question:** primary user, buyer, first industry, and whether a recommendation, an audit record or an integration is the valued thing.
- **Status:** **proposed** hypotheses only (medium-low to low confidence; no primary data). Not decided. Banking and healthcare are suggested to be deferred as the hardest pilot segments.
- **Revisit:** after customer interviews or pilot evidence, which the research recommends and which does not exist yet.

## D-016. Release `fc38094` to Vercel Production by fast-forward merge
- **Date:** 2026-10-20 (local, +04:00). The push was at 02:08 local, which is 2026-10-19 22:08 UTC; the Production checks ran 2026-10-19 22:17 to 22:27 UTC.
- **Decision:** The owner authorised releasing the verified branch `ui-pdf-fidelity-pass` to Vercel Production: re-verify, merge into `main` without force, run `npm run check` and the relevant tests on the result, push `main`, then verify the Production deployment before calling it live. Restrictions given: no Gemini and no `GEMINI_API_KEY`, no provider call, no force-push or check bypass, no change to the Production domain, Vercel project settings or environment variables, no claim of success until Vercel shows `READY` and the Production URL is verified. The authorisation was given in the session; Git does not record it.
- **What was done (confirmed):** `main` moved from `60a7889462eae04415c363c21780c1411fae51df` to `fc380947f14e344a105473043b5dfaa90204c092` by fast-forward (no merge commit; merge base `60a7889`): 21 commits, 64 files, +9982/-1562, no deletions or renames, no dependency or manifest changes. The push was not forced.
- **What this puts into Production (confirmed from the diff):** GATE-6 (D-005), so a submission with no passing mapped test now returns `CONDITIONAL` instead of possibly `GO`; the Quality Gates page (D-006); the Gemini hardening (D-007), which only matters when a key is configured; the data-handling notice (D-012); `aiAttempt` (D-013); the PDF four-page fix in `fc38094`.
- **Validation before the push (recorded from the release session; none of it was re-run for this documentation update):** `npm run check` exit 0 with 648 of 648 tests passing on a clean export of `main`; the Stage 3B dry run completed four of four scenarios as expected with `providerRequestsAttempted` 0 and the candidate digest unchanged (D-014); 28 functional Playwright tests passed through a scratch configuration with the AI key forced empty. The standard `npm run test:e2e` was never run.
- **Status:** accepted (executed). The outcome and a detour are in D-017.
- **Evidence:** `git ls-remote` (`main` and `ui-pdf-fidelity-pass` both at `fc38094`), the local reflog of the remote-tracking ref `origin/main` for the push time (a local Git record, not GitHub's or Vercel's history), `docs/PROJECT_STATE.md` sections 1, 4 and 9.
- **Note on D-003:** that entry marks any host building from the working branch as not verified. For Vercel it is now verified (Preview deployments of the branch and a Production deployment of `main`). Whether a Render deployment exists or was updated is still not verified; D-003's primary target is unchanged.
- **Revisit if:** the release must be reversed. Vercel lists the previous Production deployment `dpl_DwQ7kR2YNdq4bqYMjvRvgi6ihcCo` (commit `60a7889`) as a rollback candidate; a rollback was never tried, and it would also remove GATE-6 from Production.

## D-017. The push of `fc38094` to `main` produced no Vercel build; a fresh Production deployment was created instead of promoting the Preview
- **Date:** 2026-10-20 (local, +04:00); the events ran 2026-10-19 22:08 to 22:31 UTC.
- **Confirmed facts:**
  1. `main` was pushed to GitHub at 22:08:32 UTC according to the local reflog of `origin/main`. GitHub's public event feed did not list the push when checked at 22:31 UTC, so GitHub does not confirm that time. `git ls-remote` showed `main` at `fc38094` at 22:10, 22:17, 22:19, 22:27 and 22:31 UTC.
  2. Vercel had already built that SHA as a Preview (`dpl_BzTCYAK1QMKDVounmLjoLocqVo5K`, ref `ui-pdf-fidelity-pass`, created 21:57:07 UTC). Until the Production deployment described under "What happened" existed, GitHub held exactly one Vercel deployment record (environment Preview) and one Vercel commit status for the SHA, both from 21:57 UTC (checked 22:17 to 22:19 UTC). At the re-check of 22:31 UTC a second record (environment Production) and a second status ("Deployment has completed") also existed, both created 22:22:22 UTC.
  3. For about 13 minutes after the push, until the manual step below, Vercel had no Production deployment for `fc38094`, GitHub had no Production deployment record or Vercel status for it, and the Production URL still served the old code (`/api/quality-gates` returned 404). No failed, canceled or skipped entry appeared in the deployment listings (API and the dashboard's top rows).
  4. Project settings, read-only in the dashboard: Production branch tracking `main`; Ignored Build Step behaviour `Automatic`, described by Vercel as "skips builds for commits with a previously deployed SHA"; no deploy hooks. `vercel.json` has no `ignoreCommand` or `git` key.
  5. GitHub holds Production deployment records created by `vercel[bot]` on 2026-09-06 and 2026-09-07 for earlier commits of `main` (for example `60a7889`), so the integration has built `main` before.
- **Inference, not observed:** the Automatic Ignored Build Step is why the push to `main` built nothing. No Vercel log or event says so. A lost webhook delivery cannot be ruled out because the webhook delivery log was not accessible. The explanation fits every item above and the setting's own description, so it is the working explanation, not a confirmed cause.
- **Options considered:** (a) promote the existing `READY` Preview to Production: no rebuild, but the deployment's recorded ref would stay `ui-pdf-fidelity-pass` and it would carry Preview build metadata (the application reads no `VERCEL_*` variable: a search of `api/`, `src/`, `web/` and `tests/` found none); (b) create a fresh Production deployment from `main` at `fc38094` through the Vercel API with `forceNew`, which gives Production provenance (ref `main`); (c) push a new commit to `main`, rejected because it changes Git history; (d) change the Ignored Build Step, not done because it modifies a Vercel project setting and needs the owner's approval. The owner approved (b).
- **What happened (confirmed):** `create_deployment` was called with `forceNew: 1`, target `production`, GitHub source `rizwana-qa/ai-qa-release-risk-agent`, ref `main`, sha `fc38094`, and no project settings override. Both attempts returned HTTP 403 errors ("Reached the max retries per request limit" and "You don't have permission to create a Production Deployment for this project"). A deployment was nevertheless created: `dpl_2hmM7mtaRRMEDhiMactYm1QQ1T6y` (created 22:21:50 UTC, source `git`, ref `main`, commit `fc38094`, `READY` at 22:22:21 UTC, aliased to `ai-qa-release-risk-agent.vercel.app`). The Production listing then held exactly that one new deployment. **Unknown:** which call created it, and why the API reported errors. No further create call was made. This is an open anomaly.
- **Final outcome (confirmed):** Production serves `fc38094`. `/api/health` returned 200; `/api/quality-gates` returned 200; the project has no environment variables, so no `GEMINI_API_KEY`; one synthetic S01 assessment returned `mode: "rules-based"`, `aiAttempt.enabled: false`, GO from `GATE-5`. Details: `docs/PROJECT_STATE.md` section 9.
- **Not verified:** PDF output and a visual check of the screens in Production, runtime logs, Google-side counters, the standard `npm run test:e2e`.
- **Status:** accepted (executed). The 403-but-created behaviour is open.
- **Evidence:** read-only Vercel deployment listings and dashboard settings pages; GitHub's public statuses, check-runs and deployments for the SHA; the local reflog of `origin/main` for the push time; the release verification in `docs/PROJECT_STATE.md` section 9.
- **Revisit if:** another release fast-forwards `main` to a SHA that already has a Preview; it would likely not auto-deploy. Options, all **proposed** and none decided: merge with a merge commit so `main` gets a new SHA; promote the Preview; redeploy by hand; or change the Ignored Build Step (owner decision, changes a Vercel setting). Also revisit if the Vercel connection's permissions or the `create_deployment` behaviour are examined.
