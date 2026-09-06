# Example — end-to-end assessment for `REQ-BEN-001`

`release-report.REQ-BEN-001.json` is the report produced by running the full
pipeline over the one synthetic scenario:

> "Add a beneficiary and allow an authenticated customer to transfer money to the
> beneficiary after authentication."

## How it was generated

Offline mode — no API key, using a **synthetic recorded** AI-agent output
(`workflows/sample-agent-findings.json`) in place of a live model call:

```bash
PIPELINE_AGENT_FINDINGS_FILE=./workflows/sample-agent-findings.json \
  node src/pipelineCli.ts run --state ./.pipeline-run/state.json
```

The same six steps run when the n8n workflow executes, and when
`GEMINI_API_KEY` is set the `analyze` step calls Gemini 3.6 Flash for real instead of
reading the recorded file. The recorded findings are illustrative synthetic data,
not real analysis.

## Reading the report

| Field | Source | Meaning |
| --- | --- | --- |
| `releaseDecision` | **`evaluateReleaseGate()` only** | `NO_GO` |
| `firedRule` | gate | `GATE-2` — the security-failure rule |
| `reasons` | gate | why GATE-2 fired: `SEC-1` (open security defect `DEF-004`) and `SEC-2` (security criterion `AC-8` has no active test) |
| `aiQaExplanation` | the LLM (Gemini) | plain-language narrative — advisory only |
| `identifiedRisks`, `coverageAssessment`, `missingScenarios`, `defectReview`, `regressionPriorities` | the LLM (Gemini) | the structured analysis — advisory only |
| `dataProvenance` | the LLM, cross-checked by the adapter | proves the analysis was grounded in the real dataset (8 criteria, 11 tests, 5 defects) |
| `agentOutputValid` / `adapterOk` | pipeline | both `true` here |
| `pipelineTrace` | pipeline | the five executed steps, all `ok`, ending `deterministic-release-gate → NO_GO (GATE-2)` |

## The point

The LLM's narrative describes the risks and could be read either way by a human.
The **decision is not the LLM's**: the deterministic gate saw an open
`security: true` defect at qualifying severity (`DEF-004`) and a `security`-area
acceptance criterion with no active test (`AC-8`), and returned `NO_GO` under
rule `GATE-2`. Change the data (close `DEF-004`, re-activate the `AC-8` test) and
the same pipeline returns `GO` under `GATE-5` — again from the gate, not the LLM.

## Regenerate

```bash
npm test            # 160 tests, includes a check that this scenario yields NO_GO / GATE-2
npm run check       # typecheck + tests
```
