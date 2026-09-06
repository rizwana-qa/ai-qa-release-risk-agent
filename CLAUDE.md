# CLAUDE.md

Guidance for any AI assistant (and humans) working in this repository.

## What this project is

**AI QA Release Risk & Test Strategy Agent** — a small, public, personal
portfolio project demonstrating AI-assisted Quality Engineering.

It shows how an AI agent can help a QA engineer:

1. Understand a proposed change
2. Identify QA risks
3. Review existing test coverage
4. Identify missing test scenarios
5. Review known defects
6. Prioritize regression testing
7. Explain the overall release risk

...while a **deterministic rules layer**, not the LLM, makes the final
GO / NO-GO / CONDITIONAL release decision.

## The single synthetic scenario

The entire project is built around **one completely synthetic banking change**:

> "Add a beneficiary and allow a customer to transfer money to the beneficiary
> after authentication."

There is no other scenario in Version 1. Do not add more.

## Core rule: keep Version 1 small

Version 1 must stay **small and easy to understand**. Favor readable code and a
simple architecture over completeness or cleverness. If a change would make the
project meaningfully larger or more complex, **stop and ask first**.

## Scope boundaries — do NOT introduce

- Company data, company code, or client information
- Customer / personal information
- Real banking systems or real integrations
- Databases
- Cloud infrastructure
- Multiple AI agents (Version 1 is a single agent)
- Unnecessary integrations or dependencies

## The four MCP tools (Version 1)

The MCP server will eventually expose exactly these four read-only tools:

| Tool | Purpose |
| --- | --- |
| `get_requirement` | Return the requirement/spec for the change |
| `get_existing_tests` | Return the current test inventory |
| `get_known_defects` | Return known/open defects |
| `get_risk_rules` | Return the QA risk-scoring rules |

No other tools in Version 1.

## Deterministic release gate (the LLM does NOT decide this)

The final release decision is computed by code from structured inputs:

- Critical defect open → **NO GO**
- Security failure → **NO GO**
- Critical requirement with no coverage → **NO GO**
- High-risk change + insufficient coverage → **CONDITIONAL**
- Otherwise → **GO**

The LLM (Gemini) may *explain* the reasoning and *summarize* risk, but must not
independently produce the final release decision. The decision is always the
output of the rules layer.

## Public project rules

- Synthetic data only.
- Never use employer or client information.
- Never expose credentials, secrets, internal URLs, or proprietary content.
- Do not invent or cite metrics.
- Do not claim production readiness.
- Keep code readable.
- Keep architecture simple.
- Keep Version 1 small.
- Ask before adding major scope.
- Run validation/tests after meaningful changes.

## Phase discipline

Work proceeds in explicit phases. Do not jump ahead a phase without approval.

**Version 1 is complete (Phases 1–7 delivered):** foundation, synthetic dataset,
deterministic gate, MCP server, LLM reasoning layer (Gemini 3.6 Flash), n8n workflow, and
polish/write-up. See `README.md` → "Phases delivered" and `docs/architecture.md`.

Any further work is a **new, separately-approved effort** — and the scope
boundaries above (no databases, no cloud, no extra agents, no extra scenarios,
keep it small) still apply. Do not add scope without asking.

## Technology stack

Gemini · n8n · MCP · Node.js · TypeScript · JSON · GitHub

## Working agreement

- Small, reviewable changes.
- Explain trade-offs briefly; recommend, don't sprawl.
- After a meaningful change, run whatever validation/tests exist.
- When in doubt about scope, ask.
