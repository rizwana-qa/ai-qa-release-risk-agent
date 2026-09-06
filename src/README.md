# src/

Application code for Version 1. All modules are small, strict TypeScript, run
directly by Node's native TypeScript execution (no build step needed).

| Module | Phase | Responsibility |
| --- | --- | --- |
| `releaseGate.ts` | 3 | **The deterministic decision.** `evaluateReleaseGate(input) → { decision, firedRule, reasons }` (`GO` / `NO_GO` / `CONDITIONAL`), plus the pure predicates (`changeRiskLevel`, `criticalAcceptanceCriteria`, `insufficientCoverage`, `securityFailure`) and `validateFindings()`. No I/O, no randomness, no time. Invalid input → `NO_GO` / `FAIL_SAFE`. |
| `dataLoader.ts` | 4 | Read and parse `data/*.json` — `loadDataset(name)`. The one deliberate side effect. |
| `mcpServer.ts` | 4 | MCP server (stdio) exposing four read-only, no-parameter tools: `get_requirement`, `get_existing_tests`, `get_known_defects`, `get_risk_rules`. Each returns its data file verbatim. `createServer()` builds it; `main()` runs it. |
| `agentContract.ts` | 5 | The LLM ↔ pipeline contract: `AgentFindings` schema (no decision field), `AGENT_ANALYSIS_STEPS` (the 7 steps), `AGENT_SYSTEM_PROMPT`, `FORBIDDEN_OUTPUT_KEYS`, `AnalyzeFn` / `AgentContext`. |
| `agentOutputValidation.ts` | 5 | `validateAgentFindings(raw)` — strict structural validation; rejects malformed / incomplete output and any decision field; never fills defaults. |
| `findingsAdapter.ts` | 5 | `adaptAgentFindingsToReleaseFindings()` — deterministic; builds `ReleaseFindings` from **dataset facts** (not the LLM), runs grounding checks, and `projectSecurityFailureSeverities()` (formalises the SEC-1 severities → `["critical","high"]`). |
| `releaseAssessment.ts` | 5 | `runReleaseAssessment({ analyze, loadDataset? })` — the in-process pipeline: load → analyze → validate → adapt → gate → assemble. `analyze` is injected for deterministic testing. The decision is always taken from `evaluateReleaseGate()`. |
| `geminiAgent.ts` | 5 | Production wiring: a live Gemini 3.6 Flash call (`createGeminiAnalyzeFn()`) sending it the already-retrieved datasets directly (no tool loop needed), plus a CLI `main()`. Performs I/O; needs `GEMINI_API_KEY`. Its prompt-building and response-parsing are pure and unit-tested (`tests/geminiAgent.test.ts`); the live call itself is not imported by the rest of the suite. |
| `mcpDataClient.ts` | 6 | `fetchDatasetsViaMcp()` — connect to `mcpServer.ts` and call the four tools. Transport plumbing only. |
| `pipelineCli.ts` | 6 | The seam the n8n workflow drives: the six steps (`fetch-data`, `analyze`, `validate`, `adapt`, `gate`, `assemble`) as CLI subcommands over a JSON state file, plus `runPipeline()`. Plumbing only — every step delegates to a module above; no QA or decision logic here. |

## Run

```bash
npm run mcp          # start the MCP server (stdio)
npm run agent        # full assessment with a live Gemini call (needs GEMINI_API_KEY)
node src/pipelineCli.ts run --state ./.pipeline-run/state.json   # the pipeline
```

Offline (no API key): set
`PIPELINE_AGENT_FINDINGS_FILE=./workflows/sample-agent-findings.json` first.

See `../docs/architecture.md` for how the pieces fit together.
