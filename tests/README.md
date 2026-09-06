# tests/

**160 tests**, run by Node's built-in test runner (`node --test`) — no test
framework dependency. All tests are **offline and deterministic**: the AI
reasoning step is always a stub or a recorded fixture, never a live API call.

```bash
npm test         # node --test "tests/**/*.test.ts"
npm run check    # typecheck + tests
```

| File | Tests | Covers |
| --- | ---: | --- |
| `releaseGate.test.ts` | 43 | Every gate rule in isolation and in combination; precedence (`GATE-1 → … → GATE-5`); fail-safe on malformed / missing input; determinism and non-mutation; the four helper predicates. |
| `mcpServer.test.ts` | 22 | The four tools exist, take no parameters, and return their `data/*.json` file verbatim; output conforms to the Phase 2 structure; the datasets assemble into a valid `ReleaseFindings`; `dataLoader`. |
| `agentOutputValidation.test.ts` | 36 | `validateAgentFindings()` accepts the valid fixture; rejects non-objects, every malformed field, every missing key, and all seven forbidden decision keys. |
| `findingsAdapter.test.ts` | 14 | `projectSecurityFailureSeverities()` (Phase 2 rule → `["critical","high"]`, ordering, single-severity, throws when absent/empty); the adapter builds a valid `ReleaseFindings`, is deterministic, takes facts from data not commentary, and fails safe on provenance / referential / dataset mismatches. |
| `releaseAssessment.test.ts` | 16 | The in-process pipeline reaches the gate; the assessment decision is exactly `gate.decision` on every path (valid, healthy → `GO`, malformed, incomplete, ungrounded, pro-shipping narrative); the LLM cannot supply or override a decision; the Phase 3 gate behaviour is unchanged. |
| `n8nWorkflow.test.ts` | 20 | The workflow JSON is valid; the 7 expected nodes are present; the connections form one linear chain; commands reference only whitelisted `src/pipelineCli.ts` steps; no URLs / credentials / secrets; the workflow (and `pipelineCli.ts`) define no gate rules of their own. |
| `pipelineCli.test.ts` | 9 | End-to-end runs of `runPipeline()` with a stubbed AI-reasoning step: the report decision equals `evaluateReleaseGate()`'s on every path; fail-safe paths; `fetchDatasetsViaMcp()` against the live MCP server; the offline `PIPELINE_AGENT_FINDINGS_FILE` placeholder drives a full run. |
| `geminiAgent.test.ts` | 10 | `buildGeminiPrompt()` / `parseGeminiResponse()` (pure, offline); `createGeminiAnalyzeFn()` wired against a fake client — no network call, no key needed. |

Shared fixtures: `fixtures.ts` (gate `ReleaseFindings` builders) and
`agentFixtures.ts` (`validAgentFindings()` + dataset loaders). Neither is a
`*.test.ts` file, so the runner imports but does not execute them.
