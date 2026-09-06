# web/ — assessment workspace (presentation layer)

A dependency-free browser workspace for the AI QA Release Risk & Test Strategy
agent. It is a **presentation and interaction layer only** — it collects the
user's release context and QA evidence, sends it to the backend, and renders the
values the existing pipeline returns. It contains no risk, coverage, security, or
release-decision logic. Every interpolated value passes through the escaping
helpers in `format.js`; nothing from user input or an uploaded file is ever
executed, `eval`'d, or written to the DOM unescaped.

- `index.html` — page shell (header, workflow steps, Demo / Regression menu, footer)
- `styles.css` — design system (light theme, theme-agnostic, no external assets)
- `icons.js` — inline SVG icon set
- `format.js` — display helpers (HTML/attribute escaping, label casing, decision
  label that never fabricates `GO`, scenario grouping)
- `upload.js` — client-side parsing of `json` / `csv` / `txt` evidence into rows
  or notes; `pdf` / `docx` / `xlsx` are kept as reference metadata only (no
  document-parsing libraries); executables, scripts, archives, and markup are
  rejected
- `workspace.js` — the input form: editable acceptance-criteria / business-rule /
  test-case / defect rows, a live *preview* of what has been entered (never the
  authoritative coverage numbers), and the Analyze gate (enabled only once a
  release scope, a user story, and at least one acceptance criterion are present)
- `components.js` — the processing stepper and the report renderers
- `app.js` — view state machine (workspace → processing → report), SSE streaming
  with a blocking fetch fallback, and the Demo / Regression fixture flow

Served by `api/server.ts` (Node built-ins only). The final `GO` / `NO_GO` /
`CONDITIONAL` decision always comes from `evaluateReleaseGate()` via the existing
`src/pipelineCli.ts` steps; the workspace only displays it, and it never shows a
decision from a client-side fallback.

## Run

```
npm run demo
```

Then open **http://localhost:8080**.

1. Fill in **Step 1 — Release context** and at least one **acceptance criterion**.
2. Add **QA evidence** (test cases, defects, documents) — optional. If you leave
   it empty the report says the evidence is insufficient; it does not invent
   tests or results.
3. Click **Analyze Release Risk** and review the report.

Custom assessments run in **rules-based mode** (offline analysis of your
submitted evidence; no live model call), reported honestly in Technical Details
as `Execution mode: Rules based`. The **Demo / Regression fixture** menu runs the
built-in `REQ-BEN-001` scenario through the recorded/live path.

## Product boundary

The workspace analyses supplied evidence. It does not execute the application,
replace automated testing, crawl URLs, run Playwright or Postman, access
production, or independently verify whether a defect or a passing test is real.
