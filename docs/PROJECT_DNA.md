# Project DNA

The enduring identity, principles and boundaries of the **AI QA Release Risk Agent** (repository name `ai-qa-release-risk-agent`; the application is titled "AI QA Release Risk & Test Strategy Agent").

This document changes rarely. It is **not** a status report: for the latest verified status read `docs/PROJECT_STATE.md`. For how to work read `docs/PROJECT_SOP.md`. For why something was decided read `docs/DECISION_LOG.md`. For evaluation and live-readiness requirements `docs/AI_EVALUATION_PLAN.md` is authoritative.

- **Created:** 2026-10-20, from the repository at commit `2fd512d`. Statements below are derived from `README.md`, `CLAUDE.md`, `docs/architecture.md`, `docs/AI_EVALUATION_PLAN.md`, `docs/STAGE2_AI_DATA_HANDLING_AUDIT.md`, `docs/MINIMUM_EVIDENCE_POLICY_PLAN.md`, `docs/QA_RELEASE_RISK_AGENT_MARKET_RESEARCH.md` and the code. Where the evidence does not settle a question it is listed in section F as **UNRESOLVED**.
- **Update rule:** change this file only when an enduring principle or architecture constraint changes through an approved decision, and record that decision in `docs/DECISION_LOG.md`. These documents are kept consistent by following the workflow in `docs/PROJECT_SOP.md`, not by any automatic synchronisation.

## A. Product purpose and positioning

**What it does.** A person supplies the evidence for one proposed release: release scope and user story, acceptance criteria, test cases with results, and known defects. An AI analysis step (Gemini when enabled, otherwise an offline rules-based analyser) writes advisory QA findings and an explanation. A deterministic function, `evaluateReleaseGate()` in `src/releaseGate.ts`, turns facts derived from that evidence into one of three decisions: `GO`, `CONDITIONAL` or `NO_GO`. The interface and PDF show the decision, the rule that fired, the reasons, and the supporting evidence.

**The problem it explores** (README, "Problem"): release decisions depend on QA judgement that is inconsistent, time-pressured and hard to audit, and teams are tempted to let a language model "just decide", which is non-deterministic and not defensible. The question the project asks is whether an AI agent can speed up QA risk analysis while a deterministic gate keeps the decision safe, consistent and explainable.

**Intended users (hypothesis, not validated).** The market research report's best-supported hypothesis is a Principal or Lead Quality Engineer, QA Manager or Test Manager preparing a release recommendation. It marks this medium-low confidence and found no interviews, usage data or willingness-to-pay evidence. See F1.

**Evidence-based assessment, not autonomous approval.** This is the central distinction.
- The product analyses the evidence a person supplies. It does not run the software, run tests, browse systems, or independently verify that a test passed or a defect is real (README, "Product boundary").
- The AI layer explains risk. It never decides. The decision is computed by code from dataset-derived facts, not from the model's opinions, and the validator rejects model output containing decision-like fields.
- A `GO` from the gate means "no blocking condition in the encoded rules was found for the evidence supplied". It is not a release approval, a guarantee of quality, or a substitute for a person owning the release decision. The system prompt tells the model that people keep the final release decision, and the Evidence notice states that the decision is made by the deterministic quality gates, not by the AI.

**Prototype or demonstration, not a production product.** `README.md` states the project is not production-ready: no persistence, authentication, observability or packaging; the rules are deliberately coarse; the AI step is non-deterministic and its live behaviour is not covered by automated tests. `CLAUDE.md` defines the scope as a small public portfolio project. No document in the repository claims otherwise, and none may be written to imply otherwise without evidence (see E).

**Product principles.**
1. **Transparency.** Show which rule fired, why, and from what evidence.
2. **Traceability.** Keep acceptance criteria, tests, defects, evidence and findings linkable (criterion, test and defect ids are checked against the dataset; mismatches fail safe).
3. **Explainability.** Every decision has reasons in plain language; the Quality Gates page documents the rules.
4. **Honest uncertainty.** Say what was not verified, which mode ran, whether a live request was attempted, and what the application cannot know.

## B. Core product and quality principles

1. **No unjustified `GO` when required evidence is absent.** The gate fails safe: invalid or missing input returns `NO_GO` with rule `FAIL_SAFE`; a release with no passing test mapped to any criterion is at best `CONDITIONAL` (GATE-6); open critical defects, security failures and uncovered critical criteria are `NO_GO`. Known limits of the policy are documented, not hidden: scenarios S06 (a failing rerun beside a passing test) and S09 (33% coverage at medium risk) are recorded in `docs/AI_EVALUATION_PLAN.md` section 10 as existing gate-policy limitations. Never describe the gate as stronger than its rules.
2. **Preserve the gate.** Gate rules, their order (`GATE-1`, `GATE-2`, `GATE-3`, `GATE-4`, `GATE-6`, `GATE-5`, first match wins) and thresholds (including the illustrative 0.8 coverage ratio) change only through a separately approved task with regression tests and a recorded rationale.
3. **Traceability where supported.** Do not drop criterion, test or defect ids between the input, the datasets, the findings and the report.
4. **Rules-based versus AI-assisted analysis must be distinguishable.** The report states which mode produced the findings. Never claim "live AI" when the offline analysis ran.
5. **Provider attempts, fallbacks and uncertainty are shown accurately.** The response's `aiAttempt` field records `enabled`, `began`, `outcome` and `fallbackUsed` (`api/aiAttempt.ts`). The interface must follow it.
6. **An attempted request is not confirmed delivery.** `began: true` means the application initiated the call. It does not mean the provider received, processed or retained anything. Use "started" or "attempted", never "sent and received".
7. **No unsupported claims** about security, compliance, data residency, retention, deletion, accuracy or production readiness. Provider facts that are not established are written as unknown (see `docs/STAGE2_AI_DATA_HANDLING_AUDIT.md` section 7.5).

## C. Engineering boundaries (protected paths)

Changing any of the following requires **explicit scope approval, regression tests and a documented rationale** (an entry in `docs/DECISION_LOG.md`). General implementation approval does not cover them.

| Protected area | Why |
| --- | --- |
| `src/releaseGate.ts` (rules, order, thresholds, decision values, exported predicates) | The sole owner of the release decision. |
| `src/agentOutputValidation.ts` and the forbidden decision keys | Stops the model supplying a decision. |
| `src/findingsAdapter.ts` | Builds gate input from dataset facts, not model claims; id and provenance grounding fails safe. |
| `api/policy.ts` and the generated policy / `data/risk-rules.json` | Fixed policy. User input may supply evidence, never policy or gate rules. |
| `api/inputNormalizer.ts` (what reaches the datasets and therefore the model) | Defines what is sent to the provider; the Evidence notice is tied to it by a test. |
| `data/*.json` and `workflows/sample-agent-findings.json` | The synthetic scenario and recorded output. |
| `src/geminiAgent.ts` routing guard, `src/providerError.ts`, `src/aiCrossCheck.ts` | Fail-closed provider routing, error sanitising, AI-versus-evidence checks. |
| `tests/evaluation/scenarios.ts`, the expected decisions in it, and `APPROVED_SET_FINGERPRINT` | The fixed evaluation set. Altering it is a version change. |
| `tests/evaluation/runner.ts` and its controls | Request cap, no retries, deadline, secret scanning, retention. |
| The Stage 3B baseline digest inputs (the 16 files in `BASELINE_FILES`) | A change moves the digest and needs the recording steps in `docs/AI_EVALUATION_PLAN.md` section 20.12. |

Layering invariants (from `CLAUDE.md`, which remains in force): no decision, risk, coverage or gate logic in `api/` or `web/`; `src/pipelineCli.ts` is plumbing only; reuse the exported gate predicates, never reimplement them; `api/server.ts` binds both `127.0.0.1` and `::1` on purpose.

## D. AI and data safety

1. **Offline tests and dry-runs never contact an external AI provider.** Tests use fake clients and injected analyzers. The Stage 3B runner defaults to an offline dry-run.
2. **Live evaluation requires explicit authorisation** and satisfaction of the readiness checklist in `docs/AI_EVALUATION_PLAN.md` (sections 13, 17, 20.9 to 20.12). Approval of other work is not approval of a live run.
3. **Credentials.** Do not read `.env`, print environment variable values, test API keys, or probe provider endpoints as part of inspection. A task that needs a credential operation must say so explicitly and be authorised separately. Provider configuration (routing variables, endpoint, product) is not changed without approval.
4. **No secrets, prompts, confidential evidence or personal data** in logs, reports, test fixtures or commits. Test fixtures use obviously fake values.
5. **Keep these states distinct** in code, reports and wording: a credential is configured; the application initiated a request; the provider returned a usable response; the response was rejected by validation or grounding; the offline fallback supplied the findings.
6. **Submitted evidence.** The application cannot tell whether submitted evidence is synthetic, anonymised or real. The repository's own data is synthetic. Users are warned not to submit secrets, personal data or confidential evidence unless approved (Evidence screen notice).

## E. Evidence and reporting rules

1. **Never invent** test results, metrics, customer feedback, market data or production validation.
2. **Label statements:** verified fact, assumption, hypothesis, proposed change, completed work. Facts come from code, test output, Git history or remote checks, not from memory or earlier summaries.
3. **Record limitations and untested paths** at the end of every substantial task.
4. **Never claim a feature is deployed or pushed** without checking: the remote for a push, the running environment for a deployment.
5. **Do not trust a status document over current evidence.** If this repository's documents disagree with code, tests or Git, report the conflict (stop condition S8 in `docs/PROJECT_SOP.md` section 3).

## F. Unresolved positioning and scope questions

These are open. Do not answer them by assumption in code or documentation.

1. **Primary user, buyer and first market.** Only hypotheses exist (market research sections 1, 3, 4, 11). The report defers banking and healthcare as hardest pilot segments, although the demonstration scenario is a banking one.
2. **What would be valued:** a recommendation, an audit record, or an integration. Unresolved in the research (section 15).
3. **Regulatory applicability** to any real deployment. Not assessed; legal advice needed.
4. **Whether the project stays a Version 1 portfolio demonstration** (`CLAUDE.md`: "must stay small", one scenario, no database) or grows into a product that would need persistence, authentication, reviewer sign-off and stored records. No decision recorded.
5. **Whether the five-or-six-rule gate** is close enough to real release practice to be useful. Unresolved.
6. **Provider terms for the deployment** (tier, retention, region, logging). Unresolved; see `docs/STAGE2_AI_DATA_HANDLING_AUDIT.md` section 7.5.
