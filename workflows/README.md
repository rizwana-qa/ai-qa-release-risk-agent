# n8n workflow — Release Risk Assessment

`release-risk-assessment.n8n.json` orchestrates the existing Phase 2–5 pipeline
for the single synthetic scenario **REQ-BEN-001**. It is an **orchestration layer
only**: every node shells out to `src/pipelineCli.ts`, which delegates to the
already-built components. No QA risk logic and no release-decision logic live in
the workflow.

## Nodes (linear)

| # | Node | Command | Component reused |
| - | ---- | ------- | ---------------- |
| 1 | Manual Trigger | — | n8n built-in |
| 2 | Retrieve QA Data (MCP) | `node src/pipelineCli.ts fetch-data` | Phase 4 MCP tools via `src/mcpServer.ts` |
| 3 | AI Reasoning | `node src/pipelineCli.ts analyze` | Phase 5 `createGeminiAnalyzeFn()` |
| 4 | Validate Structured Findings | `node src/pipelineCli.ts validate` | Phase 5 `validateAgentFindings()` |
| 5 | Deterministic Adapter | `node src/pipelineCli.ts adapt` | Phase 5 `adaptAgentFindingsToReleaseFindings()` |
| 6 | Deterministic Release Gate | `node src/pipelineCli.ts gate` | Phase 3 `evaluateReleaseGate()` — **sole decision owner** |
| 7 | Assemble Release Report | `node src/pipelineCli.ts assemble` | field copy only, no logic |

Steps pass state through one JSON file: `./.pipeline-run/state.json` (git-ignored,
regenerated per run).

## The decision stays code-owned

`evaluateReleaseGate()` is the only thing that produces `GO` / `NO_GO` /
`CONDITIONAL`. The gate step runs on every path — if validation or the adapter
fails, it is handed deliberately-invalid input and returns `NO_GO` / `FAIL_SAFE`.
Node 4 rejects any LLM output that contains a decision field, so a model-generated
verdict can never reach or override the gate.

## Environment (placeholders — nothing secret is stored in the workflow)

Run n8n with the **repository root** as the working directory. Then set **one** of:

| Variable | Purpose |
| -------- | ------- |
| `GEMINI_API_KEY` | Run the real Gemini 3.6 Flash reasoning step. |
| `PIPELINE_AGENT_FINDINGS_FILE=./workflows/sample-agent-findings.json` | Offline demo run using a synthetic recorded model output. |

`sample-agent-findings.json` is synthetic, illustrative data — not real analysis.

## Import

n8n → *Workflows* → *Import from File* → select `release-risk-assessment.n8n.json`.
The workflow is inactive (`"active": false`) and has no credentials attached.

## Run without n8n

```
PIPELINE_AGENT_FINDINGS_FILE=./workflows/sample-agent-findings.json node src/pipelineCli.ts run
```
