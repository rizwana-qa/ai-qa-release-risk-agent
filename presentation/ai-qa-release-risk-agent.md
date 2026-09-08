---
marp: true
title: AI QA Release Risk & Test Strategy Agent
description: How an AI agent assists release-risk assessment while a deterministic rules layer — not the model — makes the GO / NO-GO decision.
paginate: true
theme: default
---

<!-- _class: lead -->

# AI QA Release Risk & Test Strategy Agent

**The AI explains the risk. Deterministic rules make the decision.**

A portfolio project demonstrating AI-assisted Quality Engineering
with a hard, auditable safety boundary.

<small>Synthetic data only · no real systems · not production advice</small>

---

## The problem

Release sign-off today is:

- **Slow** — someone reads the spec, the test inventory and the defect list, then writes a risk narrative by hand.
- **Inconsistent** — two reviewers, two answers; the same release assessed twice can differ.
- **Hard to defend** — "we felt it was fine" doesn't survive an audit.

Teams want to point an LLM at it. But an LLM decision is
**not reproducible, not auditable, and can fail *open*** — a confident wrong "GO".

---

## The idea

> Let the AI do the reading and the explaining.
> Let a **fixed rule set** — written by humans, run by code — make the call.

**The language model** summarises the change, lists risks, reviews coverage and
defects, proposes regression priorities, and writes the plain-language "why".

**The deterministic gate** takes structured *facts* and returns
**GO / NO-GO / CONDITIONAL** — the same answer every time.

The model may phrase the "why". It cannot change the "what".

---

## How it helps people

| Who | What they get |
| --- | --- |
| **QA lead / release manager** | A fast, consistent risk read; the cross-referencing of spec ↔ tests ↔ defects is done for them. |
| **Engineering leadership** | A decision with the rule that fired and the reasons attached — defensible in a review or audit. |
| **Information security** | Security checks are explicit gate rules, not a reviewer's memory. |
| **Everyone** | Fail-safe: a broken model or a broken pipeline resolves to **NO-GO**, never a false GO. |

---

## The single scenario (kept deliberately small)

> *"Add a beneficiary and allow an authenticated customer to transfer money to that beneficiary."*
> requirement id: `REQ-BEN-001`

Four synthetic datasets describe it:

- **requirement.json** — the change, its affected areas, acceptance criteria
- **existing-tests.json** — the current test inventory
- **known-defects.json** — open / closed defects
- **risk-rules.json** — the QA risk-scoring rules the gate applies

---

## Architecture — the layer stack

```
  Layer 0   Human-authored ground truth      requirement / tests / defects /
            (datasets + risk rules)          risk-rules JSON

  Layer 1   MCP server — 4 read-only tools   get_requirement · get_existing_tests
                                             get_known_defects · get_risk_rules
                          |
  Layer 2   AI reasoning (Gemini, via API)   <-- the only place a model runs
            -> structured findings + text        (optional; falls back to rules)
                          |
  Layer 3   Output validation                <-- rejects malformed output
                                                 OR any AI-supplied decision
                          |
  Layer 4   Deterministic adapter            -> gate input from dataset FACTS
                          |
  Layer 5   Deterministic gate               evaluateReleaseGate()
            -> GO / NO_GO / CONDITIONAL       <-- SOLE decision authority
                          |
  Layer 6   Report assembly                  decision (verbatim) · KPIs ·
                                             risk register · trace · PDF
                          |
  Layer 7   Web UI                           renders the decision; never computes one
```

---

## Layer 0 — Human-authored ground truth   ·   `[HUMAN]`

Everything downstream is anchored here.

- The **requirement, tests and defects** are the facts of the release.
- **`risk-rules.json`** is policy-as-config: which areas are high-risk, what
  "insufficient coverage" means (`COV-1/2/3`), what a "security failure" is
  (`SEC-1/2`), and the gate rules themselves (`GATE-1…5`).

> Humans decide *what the rules are*. The model never edits this layer.

---

## Layer 1 — MCP server (the interface)   ·   `[CODE]`

Exposes exactly **four read-only tools** — no writes, no side effects:

| Tool | Returns |
| --- | --- |
| `get_requirement` | the spec for the change |
| `get_existing_tests` | the current test inventory |
| `get_known_defects` | known / open defects |
| `get_risk_rules` | the QA risk-scoring rules |

A clean, inspectable boundary between "the data" and "the reasoning".

---

## Layer 2 — AI reasoning   ·   `[AI — API key used here, and only here]`

**Gemini 3.6 Flash** reads the context and returns **structured findings**:
change summary · identified risks · coverage assessment · missing scenarios ·
defect review · regression priorities · a plain-language explanation.

| `GEMINI_API_KEY` | Behaviour |
| --- | --- |
| **Not set** (default) | Rules-based analysis of the same evidence — **fully offline, no API call** |
| **Set** | Live Gemini call; on failure/timeout it **falls back** to the rules-based path |

> This layer affects *wording and emphasis only*. It has no vote in the outcome.

---

## Layer 3 — Output validation   ·   `[CODE — human guardrail]`

Before anything the model said is used, a validator:

- checks the **shape** of the findings (schema), and
- **strips / rejects any decision the model tried to make** — a `releaseDecision`
  field, a "GO", an approval.

If validation fails → the pipeline **fails safe**.

> The one-sentence rule of the whole project lives here:
> *the model does not get to decide.*

---

## Layer 4 — Deterministic adapter   ·   `[CODE]`

Converts the **dataset facts** — not the model's prose — into the exact input
the gate expects (`ReleaseFindings`):

- affected areas + their risk levels
- acceptance criteria (which are critical, which have active tests)
- defects (status, severity, security flag)
- test coverage by type (positive / negative / boundary)

> Grounding step: the gate can only ever see verifiable facts.

---

## Layer 5 — The deterministic gate   ·   `[CODE — the decision]`

`evaluateReleaseGate()` — pure function: no I/O, no randomness, no clock.
Rules run **in order; first match wins**.

| Rule | Condition | Decision |
| --- | --- | --- |
| **GATE-1** | open **critical** defect | **NO GO** |
| **GATE-2** | security failure (`SEC-1` open security defect / `SEC-2` security AC uncovered) | **NO GO** |
| **GATE-3** | **critical** acceptance criterion, zero active coverage | **NO GO** |
| **GATE-4** | change risk **high** *and* coverage **insufficient** | **CONDITIONAL** |
| **GATE-5** | none of the above | **GO** |
| **FAIL_SAFE** | findings invalid / pipeline broke | **NO GO** |

Output: `decision` · `firedRule` · `reasons[]`.

---

## Layer 6 — Report assembly   ·   `[CODE]`

Builds the artefacts a human reads:

- **Executive decision** (verbatim from Layer 5) + gate id + top blockers
- **KPIs** — Change Risk · Test Coverage · Security Risk
- **Risk register** — AI risks + regression priorities + open defects; gate-cited rows flagged
- **Decision rationale** — applied rule ids, missing-evidence list
- **Decision trace** — every pipeline step, pass/fail
- **Management PDF** — dedicated light-theme A4 report, same data (screen and PDF can't disagree)

---

## Layer 7 — Web UI   ·   `[CODE — renders, never decides]`

- Workspace → the user provides Context + Evidence
- Six real pipeline stages run (not a simulation)
- The report renders `report.releaseDecision` **as-is**

> The front end contains **no** risk / coverage / security / decision logic,
> and never shows a client-side "GO" fallback.

---

## Step by step — one assessment, end to end

1. **Human** supplies release context + QA evidence, clicks **Analyze**.
2. `prepare-context` — normalise inputs to a server-generated requirement id.
3. `prepare-evidence` — assemble datasets as facts (via the 4 MCP tools).
4. `ai-analysis` — **Gemini** (or offline rules) produces findings + narrative.
5. `validate` — schema check; **any AI-supplied decision is rejected**.
6. `gate` — `evaluateReleaseGate()` applies GATE-1…5 → **decision + rule + reasons**.
7. `assemble` — report + PDF.
8. **Human** reads the decision, the reasons and the full trace.

---

## Where the AI (API) is used — and where it is **not**

| Step | Engine |
| --- | --- |
| Read the evidence, write the risk narrative | **AI (Gemini API)** |
| Identify risks & gaps, rank regression | **AI** — advisory only |
| Define what "high risk" / "insufficient" mean | **Human** — `risk-rules.json` |
| Validate output, strip any AI decision | **Code** |
| Facts → gate input, run the gate | **Code** |
| **Produce GO / NO-GO / CONDITIONAL** | **Code** — never the model |

*One of seven layers touches the API — the reasoning layer. It never touches the decision.*

---

## Where human control is placed

1. **The rules** — `risk-rules.json` and the gate code: human-authored, version-controlled, code-reviewed.
2. **The evidence** — nothing is scraped or executed; a person supplies requirement, tests, defects.
3. **The trigger** — the pipeline runs only when a person clicks *Analyze*.
4. **The guardrail** — the validation layer removes any decision the model attempts.
5. **The authority** — `evaluateReleaseGate()` is the *sole* decision owner, by construction and by test.
6. **The review** — the decision, its rule and its reasons are surfaced for a human to accept or challenge.

> **AI proposes. Human-defined rules dispose.**

---

## Fail-safe by construction

Any of these → **NO-GO / `FAIL_SAFE`**, never a false GO:

- the model call errors or times out *and* the rules fallback can't produce valid findings
- the model returns malformed output
- the model tries to supply a decision
- the adapter can't build a valid gate input
- an unexpected exception anywhere in the pipeline

The report states *why* it failed safe and shows no green light.

---

## What you get out

- A **decision** (`GO` / `NO_GO` / `CONDITIONAL`) with the **rule that fired** and the **reasons**.
- An **executive report**: KPIs, risk register, rationale, recommended next actions.
- A full **decision trace** — every step, pass/fail, for audit.
- A dedicated **management PDF** from the same data.
- Identical output for identical input — **reproducible**.

---

## Tech & scope

**Stack:** Gemini · MCP · n8n · Node.js · TypeScript · JSON · GitHub
**Front end:** dependency-free static app + Node built-in HTTP server (Vercel adapters included)

**Out of scope (on purpose):** company / client / customer data · real banking
systems · databases · cloud infra · multi-agent designs · extra scenarios ·
invented metrics · production-readiness claims.

---

<!-- _class: lead -->

## Takeaway

**Use the LLM for language. Use code for the verdict.**

- One of seven layers calls the API — the reasoning layer.
- Human-authored rules and a pure deterministic gate own the decision.
- Every outcome is explained, traced, reproducible, and fails safe.
