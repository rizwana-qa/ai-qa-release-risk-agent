// Report + processing renderers. Every value shown here comes from the backend
// response. This file contains NO risk / coverage / security / decision logic —
// the release decision is read verbatim from `report.releaseDecision`, which is
// produced only by the deterministic QA gate. All interpolated values pass
// through the escaping helpers in format.js.

import { ICONS } from "./icons.js";
import {
  esc, headingCase, humanizeArea, displayArea, formatFreeText, upper, decisionLabel, decisionClass,
  severityClass, priorityClass, coverageClass, testStatusClass, groupScenarios, formatTraceDetail,
} from "./format.js";

/* -------------------------------- primitives ---------------------------- */

const badge = (text, cls) => `<span class="badge ${cls}">${esc(text)}</span>`;

/** Trim to a word boundary near `max` chars, appending an ellipsis. Display only. */
function clip(s, max) {
  s = String(s ?? "").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[.,;:\s]+$/, "") + "…";
}

/** "acceptanceCriteriaCount" -> "Acceptance criteria count". Display only. */
function humanizeKey(k) {
  return String(k)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

function accordion(id, { icon, title, meta = "", open = false, ai = false }, bodyHtml) {
  return `<section class="acc${open ? " open" : ""}${ai ? " card--ai" : ""}" data-acc="${esc(id)}">
    <button class="acc__head" type="button" aria-expanded="${open ? "true" : "false"}" aria-controls="acc-body-${esc(id)}">
      <span class="ico">${icon}</span>
      <h3>${esc(headingCase(title))}</h3>
      <span class="acc__meta">${meta}<span class="chev">${ICONS.chevron}</span></span>
    </button>
    <div class="acc__body" id="acc-body-${esc(id)}">${bodyHtml}</div>
  </section>`;
}

const tableWrap = (head, rows) =>
  `<div class="tablewrap"><table class="data"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;

/* --------------------------- page chrome primitives --------------------- */

/** Sticky footer action bar shared by every screen after the input stages. */
function actionBar(hint, buttons) {
  return `<div class="actbar"><div class="container actbar__in">
    <div class="actbar__hint">${hint}</div>
    <div class="actbar__btns">${buttons}</div>
  </div></div>`;
}

function pageHead(stageNo, title, sub) {
  return `<div class="pagehead">
    <div><span class="eyebrow">Stage ${stageNo} of 5</span><h1 id="page-h" tabindex="-1">${esc(headingCase(title))}</h1>${sub ? `<p>${esc(sub)}</p>` : ""}</div>
  </div>`;
}

/** The execution-mode label, unchanged from the Technical details panel: it is
 * promoted to a visible chip so the mode is never hidden. */
function modeLabel(mode) {
  return mode === "gemini" ? "AI analysis: Gemini 3.6 Flash"
    : mode === "recorded" ? "Recorded"
    : "QA analysis mode: Rules based";
}

/* ------------------------------ processing view ------------------------- */

export function processingView(stages, { failed = false } = {}) {
  const iconFor = (s) =>
    s.status === "done" ? ICONS.check
      : s.status === "failed" ? ICONS.x
      : s.status === "running" ? ICONS.spinner
      : ICONS.dot;
  const stateText = (s) =>
    s.status === "done" ? "Completed"
      : s.status === "failed" ? "Failed"
      : s.status === "running" ? "Running" : "Pending";

  const steps = stages.map((s) => `
    <div class="pstep pstep--${s.status}">
      <div class="pstep__bar"></div>
      <div class="pstep__icon">${iconFor(s)}</div>
      <div class="pstep__label">${esc(s.label)}</div>
      <div class="pstep__state">${stateText(s)}</div>
      ${s.detail ? `<div class="pstep__state" style="text-transform:none;letter-spacing:0;color:var(--ink-2)">${esc(s.detail)}</div>` : ""}
    </div>`).join("");

  const foot = failed
    ? `<div class="banner mt-3" role="alert">
        <span class="ico">${ICONS.alert}</span>
        <div><b>The assessment did not complete.</b> No release decision is shown. You can retry or start a new assessment.</div>
      </div>`
    : `<p class="mode-note mt-3">This runs the real pipeline. Each stage is a genuine step, not a simulation, and usually takes a few seconds.</p>`;

  const bar = failed
    ? actionBar("<b>The assessment did not complete.</b> No release decision is shown.",
        `<button class="btn btn--ghost" type="button" data-act="new">New assessment</button>
         <button class="btn" type="button" data-act="retry">Retry</button>`)
    : actionBar("<b>Analysis in progress.</b> Navigation is paused until it finishes.",
        `<button class="btn" type="button" aria-disabled="true" aria-busy="true">${ICONS.spinner} Analyzing…</button>`);

  return `${pageHead(3, "Analyze release risk", "The pipeline normalises your input, runs the QA analysis, then evaluates the deterministic release gate.")}
  <div class="proc">
    <section class="card" aria-labelledby="proc-h">
      <div class="card__head"><span class="ico">${ICONS.cpu}</span><h2 id="proc-h">Analyzing Release Risk</h2></div>
      <div class="card__body">
        <div class="stepper">${steps}</div>
        ${foot}
      </div>
    </section>
  </div>${bar}`;
}

export function needsInputView({ missing = [], problems = [] }) {
  const items = [...missing.map((m) => `Required: ${m}`), ...problems];
  return `${pageHead(3, "Analyze release risk")}
  <div class="proc"><div class="banner banner--warn" role="alert">
    <span class="ico">${ICONS.alert}</span>
    <div>
      <b>More information is needed before this release can be assessed.</b>
      <ul>${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
    </div>
  </div></div>${actionBar("<b>More information is needed.</b>", `<button class="btn" type="button" data-act="edit">Back to workspace</button>`)}`;
}

/* ------------------------------- report view -------------------------- */

const REVIEW_TABS = [
  ["risk", "Risk signals"],
  ["coverage", "Test coverage"],
  ["scenarios", "Missing scenarios"],
  ["defects", "Known defects"],
  ["regression", "Regression"],
  ["ai", "AI analysis"],
];

/**
 * Render the completed assessment.
 *
 * `stage` selects one of the two report screens — "review" (findings and risk
 * signals, Stage 4) or "decision" (the release decision report, Stage 5). With
 * no `stage` every section is rendered, which is what the unit tests and the
 * print layer rely on. `tab` is the visible Review tab; the other panels stay
 * in the DOM, hidden, so switching tabs never re-renders or refetches anything.
 */
export function reportView(result, { stage, tab = "risk" } = {}) {
  const report = result?.report || null;
  const summary = result?.summary || null;
  const cov = result?.coverageStats || null;
  const ctx = result?.context || {};
  const meta = result?.meta || {};
  const mode = result?.mode || "rules-based";

  const decision = report?.releaseDecision ?? null;
  const decisionClean = ["GO", "NO_GO", "CONDITIONAL"].includes(decision);
  const pipelineBroke = report && (report.agentOutputValid !== true || report.adapterOk !== true);

  if (!report) {
    return `<div class="report">${errorView("The pipeline did not return a report. No release decision can be shown.")}</div>`;
  }

  const problems = (pipelineBroke || !decisionClean) ? `<div class="banner" role="alert">
      <span class="ico">${ICONS.alert}</span>
      <div><b>The assessment completed with problems.</b>
      ${!decisionClean
        ? "The pipeline did not produce a valid decision; the deterministic gate failed safe. "
        : "The AI analysis or its adaptation did not validate cleanly; the deterministic gate failed safe. "}
      See the reasons and the decision trace below.</div>
    </div>` : "";

  const assessmentId = esc(ctx.requirementId || report.dataProvenance?.requirementId || report.scenario || "—");
  const assessmentName = esc(ctx.releaseName || ctx.userStory || report.scenario || "Release assessment");
  const description = ctx.releaseScope || ctx.userStory || "";
  const stageNo = stage === "review" ? 4 : 5;
  const stageTitle = headingCase(stage === "review" ? "Review findings & risk signals" : "Release decision");

  const head = `<header class="report__head">
      <div class="report__ident">
        <span class="eyebrow">Stage ${stageNo} of 5 · ${stageTitle}</span>
        <h1 id="page-h" tabindex="-1">${assessmentName}</h1>
        <div class="report__meta">
          <span class="report__idtag">${assessmentId}</span>
          ${ctx.criticality ? badge(`${upper(ctx.criticality)} criticality`, "b-info") : ""}
          ${badge(modeLabel(mode), "b-out")}
        </div>
        ${description && stage !== "review" ? `<p class="report__subtitle">${esc(clip(String(description), 200))}</p>` : ""}
      </div>
      <div class="report__actions">
        <button class="btn btn--ghost" type="button" data-act="print">${ICONS.print} Print / PDF</button>
      </div>
    </header>`;

  const review = reviewStage(report, summary, cov, ctx, meta, mode, decision, stage ? tab : null);
  const decisionHtml = decisionStage(result, report, summary, cov, ctx, meta, mode, decision);

  const body = stage === "review" ? `${head}${problems}${reviewStrip(report, decision)}${review}`
    : stage === "decision" ? `${head}${problems}${decisionHtml}`
    : `${head}${problems}${decisionHtml}${review}`;

  const bar = stage === "review"
    ? actionBar("AI findings are advisory. The release decision comes from the deterministic gate.",
        `<button class="btn btn--ghost" type="button" data-act="edit">← Edit evidence</button>
         <button class="btn" type="button" data-nav="decision">Continue to Decision →</button>`)
    : stage === "decision"
      ? actionBar("Decision produced by the deterministic QA gate.",
          `<button class="btn btn--ghost" type="button" data-nav="review">← Review findings</button>
           <button class="btn" type="button" data-act="new">${ICONS.refresh} New assessment</button>`)
      : "";

  return `<div class="report report--enter">
    ${body}
    ${bar}
    ${printReport(result, report, summary, cov, ctx, meta, decision)}
  </div>`;
}

/* ---- decision stage ------------------------------------------------------ */

function decisionStage(result, report, summary, cov, ctx, meta, mode, decision) {
  return [
    decisionHero(report, summary, cov, decision),
    kpiRow(report, summary, cov),
    `<div class="cols2">${executionCard(cov)}${openDefectsCard(ctx)}</div>`,
    readinessCard(report, summary),
    findingsCard(report, ctx),
    `<div class="cols2">${insightsCard(report, summary, cov)}${recommendationsCard(report)}</div>`,
    decisionTraceAccordion(report, ctx, cov),
    technicalAccordion(result, report, meta, mode),
    historyEmptyState(),
  ].join("\n");
}

/** Wording for an unavailable metric — never a bare "N/A", never anything that
 * could read as success. */
function kpiUnavailable(kind) {
  return kind === "security" ? "Scan not provided" : "Not calculated";
}

function kpiCard(label, value, cls, supporting, icon) {
  const mark = cls === "danger" ? ICONS.x : cls === "warn" ? ICONS.alert : cls === "ok" ? ICONS.check : ICONS.help;
  return `<div class="kpi kpi--${cls}">
    <span class="kpi__label"><span class="kpi__icon">${icon}</span>${esc(label)}</span>
    <span class="kpi__value">${mark}<span>${esc(value)}</span></span>
    <span class="kpi__sub">${esc(supporting || "")}</span>
  </div>`;
}

/** The single most prominent element on the page: the GO / NO GO / CONDITIONAL
 * value and its gate identifier, with the gate's own reasoning beside it. Every
 * value is read verbatim from the deterministic gate; the state is carried by
 * the word, an icon and the bar colour — never by colour alone. */
function decisionHero(report, summary, cov, decision) {
  const ringIcon = decision === "GO" ? ICONS.check
    : decision === "NO_GO" ? ICONS.x
    : decision === "CONDITIONAL" ? ICONS.alert : ICONS.help;
  return `<section class="exec-grid" aria-label="Release decision">
    <div class="decision-box ${decisionClass(decision)}" role="group" aria-label="Release decision">
      <span class="decision-box__label">Release Decision</span>
      <div class="decision-box__row">
        <span class="decision-box__ring" aria-hidden="true">${ringIcon}</span>
        <span class="decision-box__value">${esc(decisionLabel(decision))}</span>
      </div>
      <span class="decision-box__meta">Deterministic gate${report.firedRule ? ` · <span class="mono">${esc(report.firedRule)}</span>` : ""}</span>
      <p class="decision-box__authority">Decided by the deterministic QA gate from the submitted evidence. AI analysis explains the risk; it does not override this decision.</p>
    </div>
    ${rationalePanel(report, decision, summary)}
  </section>`;
}

/** What a GO does and does not establish. Display only: the decision and the
 * coverage verdict are read from the backend response, never computed here. */
function goEvidenceNote(decision, summary) {
  if (decision !== "GO") return null;
  return summary?.testCoverage === "insufficient"
    ? {
      warn: true,
      title: "Coverage is below the illustrative threshold.",
      text: "Some verification may remain incomplete. This GO means no gate blocked the release on the evidence supplied; it does not show that every acceptance criterion has been verified.",
    }
    : {
      warn: false,
      title: "",
      text: "GO means no gate blocked this release on the evidence supplied. It does not show that every acceptance criterion or business rule has been verified.",
    };
}

/** "Why release is blocked / conditional" and the neutral "Release decision rationale" for a GO —
 * grounded entirely in the gate's reasons, the rule identifiers embedded in them and the pipeline
 * trace. Nothing invented. */
function rationalePanel(report, decision, summary) {
  const reasons = Array.isArray(report.reasons) ? report.reasons : [];
  const heading = decision === "NO_GO" ? "Why this release is blocked"
    : decision === "CONDITIONAL" ? "Why this release is conditional"
    : decision === "GO" ? "Release decision rationale"
    : "Why no decision is available";

  const lead = reasons.length
    ? reasons[0]
    : (report.aiQaExplanation
      ? "The deterministic gate reported no blocking reasons. AI narrative context is shown below."
      : "The deterministic gate reported no blocking reasons for this release.");

  // Rule identifiers the gate itself cited (GATE-n / SEC-n / COV-n), de-duped.
  const ruleIds = [...new Set([
    ...(report.firedRule ? [report.firedRule] : []),
    ...reasons.flatMap((r) => String(r).match(/\b(?:GATE|SEC|COV|REG)-\d+\b/g) || []),
  ])];

  const trace = Array.isArray(report.pipelineTrace) ? report.pipelineTrace : [];
  const gateStep = [...trace].reverse().find((t) => /gate/.test(t.step || ""));

  return `<div class="rationale">
    <div class="rationale__head"><span class="ico">${ICONS.scale}</span><div><span class="eyebrow" style="margin:0">Executive Summary</span><h3>${esc(headingCase(heading))}</h3></div></div>
    <p class="rationale__lead">${esc(lead)}</p>
    ${(() => {
      const note = goEvidenceNote(decision, summary);
      if (!note) return "";
      return note.warn
        ? `<div class="banner banner--warn" role="note" style="margin:0"><span class="ico">${ICONS.alert}</span><div><b>${esc(note.title)}</b> ${esc(note.text)}</div></div>`
        : `<p class="rationale__note">${esc(note.text)}</p>`;
    })()}
    <div>
      <span class="eyebrow">${ruleIds.length > 1 ? "Applied Gate Rules" : "Applied Gate Rule"}</span>
      ${ruleIds.length
        ? `<div class="chips">${ruleIds.map((id) => `<span class="badge b-neutral mono">${esc(id)}</span>`).join("")}</div>`
        : `<p class="muted">None recorded.</p>`}
      ${gateStep?.detail ? `<p class="rationale__trace">Gate outcome: <span class="mono">${esc(formatTraceDetail(gateStep.detail))}</span></p>` : ""}
    </div>
  </div>`;
}

function kpiRow(report, summary, cov) {
  const cr = summary?.changeRisk;
  const crCls = cr === "high" ? "danger" : cr === "medium" ? "warn" : cr ? "ok" : "muted";
  const crArea = Array.isArray(report.identifiedRisks) && report.identifiedRisks[0]
    ? displayArea(report.identifiedRisks[0].area) : "";

  const tc = summary?.testCoverage;
  const tcCls = tc === "insufficient" ? "danger" : tc ? "ok" : "muted";
  const covSub = cov ? `${cov.coveragePercent}% of criteria with a passing test` : "No coverage data supplied";

  const sec = summary?.securityRisk;
  const secCls = sec === "failed" ? "danger" : sec === "passed" ? "ok" : "muted";
  const secReasonCount = Array.isArray(summary?.securityReasons) ? summary.securityReasons.length : 0;

  return `<div class="kpis">
    ${kpiCard("Change Risk", cr ? upper(cr) : kpiUnavailable("change"), crCls,
      cr ? (crArea ? `Highest-risk area: ${crArea}` : "Based on affected areas and inherent risk") : "Adapter produced no findings", ICONS.gauge)}
    ${kpiCard("Test Coverage", tc ? upper(tc) : kpiUnavailable("coverage"), tcCls, covSub, ICONS.shield)}
    ${kpiCard("Security Risk", sec === "failed" ? "FAIL" : sec === "passed" ? "PASS" : kpiUnavailable("security"), secCls,
      sec === "failed" ? `${secReasonCount} deterministic check${secReasonCount === 1 ? "" : "s"} failed`
        : sec === "passed" ? "Deterministic security checks passed" : "No security scan was supplied", ICONS.lock)}
  </div>`;
}

/** Test execution summary: the supplied test statuses, as returned by the
 * coverage statistics. "Other" is everything that is not passed / failed /
 * blocked (skipped, not run, in progress, quarantined). */
function executionCard(cov) {
  if (!cov) {
    return `<section class="card" aria-labelledby="x-h"><div class="card__head"><span class="ico">${ICONS.list}</span><h2 id="x-h">Test Execution Summary</h2></div>
      <div class="card__body"><p class="muted">No test execution data was returned for this assessment.</p></div></section>`;
  }
  const total = Math.max(cov.totalTests, 1);
  const seg = [
    ["Passed", cov.passed, "var(--ok)"],
    ["Failed", cov.failed, "var(--crit)"],
    ["Blocked", cov.blocked, "var(--warn)"],
    ["Other", cov.other ?? 0, "var(--neutral)"],
  ];
  const aria = seg.map(([l, n]) => `${n} ${l.toLowerCase()}`).join(", ");
  return `<section class="card" aria-labelledby="x-h">
    <div class="card__head"><span class="ico">${ICONS.list}</span><h2 id="x-h">Test Execution Summary</h2>${badge(`${cov.totalTests} total`, "b-out")}</div>
    <div class="card__body">
      <div class="dist" role="img" aria-label="Test status distribution: ${esc(aria)}">${seg.map(([, n, c]) => (n ? `<i style="flex:${n};background:${c}"></i>` : "")).join("")}</div>
      <div class="leg">${seg.map(([l, n, c]) => `<span class="sw" style="background:${c}"></span><span>${l}</span><b>${n}</b><span class="muted pct">${Math.round((n / total) * 100)}%</span>`).join("")}</div>
      <p class="hint mt-3">Other covers skipped, not-run, in-progress and quarantined tests. Source: the test statuses you supplied.</p>
    </div>
  </section>`;
}

/** Open-defect summary from the defects supplied with the assessment. */
function openDefectsCard(ctx) {
  const defects = Array.isArray(ctx.defects) ? ctx.defects : [];
  const open = defects.filter((d) => d.status === "open");
  const by = (s) => open.filter((d) => d.severity === s).length;
  const hp = open.filter((d) => d.severity === "critical" || d.severity === "high");
  return `<section class="card" aria-labelledby="d-h">
    <div class="card__head"><span class="ico">${ICONS.bug}</span><h2 id="d-h">Open Defects</h2>${badge(`${defects.length} total`, "b-out")}</div>
    <div class="card__body">
      <div class="bigrow">
        <div><div class="big" style="color:${open.length ? "var(--crit-ink)" : "var(--ok-ink)"}">${open.length}</div><span class="hint">open</span></div>
        <div><div class="big">${by("critical")}</div><span class="hint">critical</span></div>
        <div><div class="big">${by("high")}</div><span class="hint">high</span></div>
        <div><div class="big">${open.filter((d) => d.security).length}</div><span class="hint">security-flagged</span></div>
      </div>
      <span class="eyebrow" style="margin-top:16px">High-Priority Open Defects</span>
      ${hp.length
        ? `<ul class="list">${hp.map((d) => `<li><span style="margin-top:1px">${severityCell(d.severity, severityClass(d.severity))}</span>
            <span><b class="mono">${esc(d.label || d.id || "")}</b> · ${esc(displayArea(d.area))}${d.security ? ` ${badge("Security", "b-security")}` : ""}<br><span class="muted">${formatFreeText(d.description)}</span></span></li>`).join("")}</ul>`
        : `<p class="muted">No open critical or high severity defects were supplied.</p>`}
    </div>
  </section>`;
}

/* ---- risk register: identified risks + regression priorities + open defects,
   one scannable table on desktop, labelled cards on mobile. No invented scores;
   every field is a restatement of AI findings or deterministic QA data. ---- */

function severityCell(level, cls) {
  const l = String(level || "n/a").toLowerCase();
  const icon = l === "critical" || l === "high" ? ICONS.alert : l === "medium" ? ICONS.target : ICONS.dot;
  return `<span class="sev ${cls}">${icon}<span>${esc(upper(level || "n/a"))}</span></span>`;
}

function registerRows(report, ctx) {
  const risks = Array.isArray(report.identifiedRisks) ? report.identifiedRisks : [];
  const regress = Array.isArray(report.regressionPriorities) ? report.regressionPriorities : [];
  const defects = Array.isArray(ctx.defects) ? ctx.defects : [];
  const reasonText = (Array.isArray(report.reasons) ? report.reasons : []).join(" ");

  return [
    ...risks.map((r) => ({
      kind: "Risk", id: "", area: displayArea(r.area), level: r.severity, cls: severityClass(r.severity),
      desc: r.description, status: "Identified", flagged: false,
    })),
    ...regress.map((p) => ({
      kind: "Regression", id: "", area: displayArea(p.area), level: p.priority, cls: priorityClass(p.priority),
      desc: p.rationale, status: "Retest priority", flagged: p.priority === "high",
    })),
    ...defects.map((d) => {
      const id = d.label || d.id || "";
      return {
        kind: "Defect", id, area: displayArea(d.area), level: d.severity, cls: severityClass(d.severity),
        desc: d.description, status: `${upper(d.status || "")}${d.security ? " · SECURITY" : ""}`,
        flagged: id && reasonText.includes(id),
      };
    }),
  ];
}

function registerTable(rows) {
  const head = `<tr>
    <th>Type / ID</th><th>Category</th><th>Severity</th><th>Description</th><th>Status</th>
  </tr>`;
  const body = rows.length ? rows.map((r) => `<tr class="${r.flagged ? "flagged" : ""}">
    <td data-label="Type / ID"><span class="reg-kind">${esc(r.kind)}</span>${r.id ? `<span class="mono reg-id">${esc(r.id)}</span>` : ""}</td>
    <td data-label="Category">${esc(r.area)}</td>
    <td data-label="Severity">${severityCell(r.level, r.cls)}</td>
    <td data-label="Description">${r.desc ? formatFreeText(r.desc) : `<span class="muted">—</span>`}</td>
    <td data-label="Status">${badge(esc(r.status || "—"), r.flagged ? "b-high" : "b-neutral")}${r.flagged ? `<div class="reg-flag">Cited by the gate</div>` : ""}</td>
  </tr>`).join("") : `<tr><td colspan="5" class="muted">No specific risk signals were identified from the submitted evidence.</td></tr>`;
  return tableWrap(head, body);
}

function riskRegister(report, ctx) {
  const rows = registerRows(report, ctx);
  const blocking = rows.filter((r) => r.flagged).length;
  return `<section class="card card--risksig">
    <div class="card__head">
      <span class="ico">${ICONS.gauge}</span>
      <h2>Risk Signals &amp; Open Defects</h2>
      <span class="card__counts">
        <span>${rows.length} signal${rows.length === 1 ? "" : "s"}</span>
        <span class="card__counts-sep">·</span>
        <span class="${blocking ? "is-blocking" : ""}">${blocking} flagged by the gate</span>
      </span>
    </div>
    <div class="card__body card__body--flush">${registerTable(rows)}</div>
  </section>`;
}

/** The few findings that matter most on the decision screen: those the gate
 * cited (supplied defects first), otherwise the first three in register order.
 * The full register stays one click away in Review. */
function findingsCard(report, ctx) {
  const rows = registerRows(report, ctx);
  const cited = [...rows.filter((r) => r.flagged && r.kind === "Defect"), ...rows.filter((r) => r.flagged && r.kind !== "Defect")];
  const show = (cited.length ? cited : rows).slice(0, 3);
  return `<section class="card" aria-labelledby="f-h">
    <div class="card__head"><span class="ico">${ICONS.gauge}</span><h2 id="f-h">Important Findings</h2>
      <span class="card__counts"><button class="linkbtn" type="button" data-nav="review">All ${rows.length} in Review</button></span></div>
    <div class="card__body card__body--flush">${registerTable(show)}</div>
  </section>`;
}

/** Testing insights: coverage figures, the gate's coverage reasons and the
 * missing / incomplete evidence — all already calculated by the backend. */
function insightsCard(report, summary, cov) {
  const covReasons = summary?.testCoverage === "insufficient" && Array.isArray(summary.coverageReasons)
    ? summary.coverageReasons : [];
  const missing = [
    ...((cov?.uncoveredCritical || []).map((id) => `${id} — critical criterion, no active test`)),
    ...((report.missingScenarios || []).slice(0, 3)),
  ];
  const tiles = cov ? `<div class="mini-cards mb-4">
      <div class="mini-card${summary?.testCoverage === "insufficient" ? " mini-card--flag" : ""}"><div class="mini-card__n">${cov.coveragePercent}%</div><div class="mini-card__t">Active coverage</div></div>
      <div class="mini-card"><div class="mini-card__n">${cov.coveredCriteria} / ${cov.totalCriteria}</div><div class="mini-card__t">Criteria with a passing test</div></div>
      <div class="mini-card${cov.uncoveredCritical?.length ? " mini-card--flag" : ""}"><div class="mini-card__n">${cov.uncoveredCritical?.length ?? 0}</div><div class="mini-card__t">Uncovered critical criteria</div></div>
    </div>` : `<p class="muted mb-4">No coverage statistics were returned for this assessment.</p>`;
  return `<section class="card" aria-labelledby="i-h">
    <div class="card__head"><span class="ico">${ICONS.target}</span><h2 id="i-h">Testing Insights &amp; Coverage Gaps</h2></div>
    <div class="card__body">
      ${tiles}
      ${covReasons.length ? `<span class="eyebrow">Coverage Checks (Deterministic QA Rules)</span>
        <ul class="list list--gap mb-4">${covReasons.map((r) => `<li>${ICONS.shield}<span>${esc(r)}</span></li>`).join("")}</ul>` : ""}
      <span class="eyebrow">Missing / Incomplete Evidence</span>
      ${missing.length
        ? `<ul class="list list--gap">${missing.map((m) => `<li>${ICONS.alert}<span>${esc(m)}</span></li>`).join("")}</ul>`
        : `<p class="muted">No evidence gaps were recorded for this release.</p>`}
    </div>
  </section>`;
}

/* ---- history (this system has no cross-release historical store) ---- */

function historyEmptyState() {
  return `<div class="hist-empty">
    <span class="ico">${ICONS.book}</span>
    <span>No historical release data available. Each assessment reflects only the evidence submitted for this release.</span>
  </div>`;
}

/* ---- recommended next actions (grounded restatements only) ---- */

function recommendationsCard(report) {
  const actions = recommendedActions(report);
  const items = actions.length
    ? actions.map((a) => `<li>${ICONS.check}<span>${esc(a)}</span></li>`).join("")
    : `<li>${ICONS.check}<span>No follow-up actions were derived from the submitted evidence.</span></li>`;
  return `<section class="card card--actions" aria-labelledby="a-h">
    <div class="card__head"><span class="ico">${ICONS.target}</span><h2 id="a-h">Recommended Next Actions</h2></div>
    <div class="card__body">
      <ul class="list list--act">${items}</ul>
    </div>
  </section>`;
}

/* ---- release readiness: the gate's own findings + security checks + authority ---- */

function readinessCard(report, summary) {
  const reasons = Array.isArray(report.reasons) ? report.reasons : [];
  const gateBlock = reasons.length
    ? `<span class="eyebrow">Gate Findings (Deterministic)</span>
       <ul class="list">${reasons.map((r) => `<li>${ICONS.scale}<span>${esc(r)}</span></li>`).join("")}</ul>`
    : `<p class="muted">The deterministic gate reported no blocking findings.</p>`;

  const secReasons = summary?.securityRisk === "failed" && Array.isArray(summary.securityReasons)
    ? summary.securityReasons : [];
  const secBlock = secReasons.length
    ? `<span class="eyebrow" style="margin-top:16px">Security Checks (Deterministic QA Rules)</span>
       <ul class="list">${secReasons.map((r) => `<li>${ICONS.shield}<span>${esc(r)}</span></li>`).join("")}</ul>`
    : "";

  return `<section class="card card--gate" aria-labelledby="r-h">
    <div class="card__head"><span class="ico">${ICONS.scale}</span><h2 id="r-h">Release Readiness: Key Risks &amp; Blockers</h2><span class="lane lane--gate">Deterministic gate</span></div>
    <div class="card__body">
      ${gateBlock}
      ${secBlock}
      <div class="authority">
        <span class="ico">${ICONS.info}</span>
        <p><b>This release decision was produced by the deterministic QA gate.</b>
        AI analysis provides risk assessment and recommendations. The deterministic QA rules make the final release decision.</p>
      </div>
    </div>
  </section>`;
}

/** Grounded next-actions: only restatements of backend findings. */
function recommendedActions(report) {
  const out = [];
  const openDefects = (report.defectReview || []).filter((d) => d && d.stillRelevant).map((d) => d.defectId);
  if (openDefects.length) {
    const noun = openDefects.length === 1 ? "defect" : "defects";
    out.push(`Resolve or re-triage the still-open ${noun}: ${openDefects.join(", ")}.`);
  }
  for (const s of (report.missingScenarios || []).slice(0, 6)) out.push(String(s));
  const highReg = (report.regressionPriorities || []).filter((p) => p && p.priority === "high").map((p) => displayArea(p.area));
  if (highReg.length) out.push(`Run a focused regression pass on: ${highReg.join(", ")}.`);
  return out;
}

/* ---- review stage: tabs over the same sections the report always had ---- */

function reviewStrip(report, decision) {
  return `<div class="banner banner--info">
    <span class="ico">${ICONS.info}</span>
    <div><b>Decision so far:</b> ${esc(decisionLabel(decision))}${report.firedRule ? ` · <span class="mono">${esc(report.firedRule)}</span>` : ""}
      — set by the deterministic gate. <button class="linkbtn" type="button" data-nav="decision">Open the decision report</button></div>
  </div>`;
}

function reviewStage(report, summary, cov, ctx, meta, mode, decision, tab) {
  const all = tab === null;
  const counts = {
    risk: registerRows(report, ctx).length,
    coverage: cov ? `${cov.coveragePercent}%` : "",
    scenarios: (report.missingScenarios || []).length,
    defects: (ctx.defects || []).length,
    regression: (report.regressionPriorities || []).length,
    ai: "",
  };
  const panels = {
    risk: riskRegister(report, ctx),
    coverage: coveragePanel(report, summary, cov, ctx),
    scenarios: scenariosPanel(report),
    defects: defectsPanel(report, ctx),
    regression: regressionPanel(report),
    ai: aiPanel(report, meta, mode),
  };
  const tabs = all ? "" : `<div class="tabs" role="tablist" aria-label="Findings views">${REVIEW_TABS.map(([k, label]) => `
    <button class="tab" type="button" role="tab" id="tab-${k}" data-tab="${k}" aria-controls="panel-${k}"
      aria-selected="${tab === k}" tabindex="${tab === k ? 0 : -1}">${label}${counts[k] !== "" ? ` ${badge(String(counts[k]), "b-out")}` : ""}</button>`).join("")}</div>`;
  return `${tabs}${REVIEW_TABS.map(([k]) => `<div class="tabpanel" role="tabpanel" id="panel-${k}" ${all ? "" : `aria-labelledby="tab-${k}" tabindex="0"`} ${all || tab === k ? "" : "hidden"}>${panels[k]}</div>`).join("")}`;
}

/* ---- AI analysis (advisory) ---- */

function aiPanel(report, meta, mode) {
  const stageLabels = Array.isArray(meta.pipelineStages) ? meta.pipelineStages : [];
  const trace = Array.isArray(report.pipelineTrace) ? report.pipelineTrace : [];
  const riskCount = Array.isArray(report.identifiedRisks) ? report.identifiedRisks.length : 0;

  // The itemized risks (and regression priorities, and open defects) live
  // once, in the Risk signals tab — this section owns the narrative summary
  // only, plus a pointer, so the same finding is never listed twice.
  const summary = `<section class="card card--ai">
    <div class="card__head"><span class="ico">${ICONS.sparkle}</span><h2>AI Risk Intelligence</h2><span class="lane lane--ai">Advisory</span></div>
    <div class="card__body">
      <span class="eyebrow">Change Summary</span>
      <p class="lead mb-4">${report.changeSummary ? formatFreeText(report.changeSummary) : "Not provided."}</p>
      ${riskCount
        ? `<p class="hint mb-4">${riskCount} identified risk${riskCount === 1 ? "" : "s"}. See Risk signals for the itemized list.</p>`
        : `<p class="muted mb-4">No risks were identified from the submitted evidence.</p>`}
      <span class="eyebrow">Why Is This Release Risky?</span>
      ${report.aiQaExplanation ? `<p class="lead">${formatFreeText(report.aiQaExplanation)}</p>` : `<p class="muted">No explanation was produced.</p>`}
    </div>
  </section>`;

  if (!stageLabels.length && !trace.length) return summary;

  // Best-effort real status per labelled stage: match by position against the
  // trace this exact run produced. This renders only once the pipeline has
  // already finished, so there are no fabricated "in progress" states.
  const rows = stageLabels.length
    ? stageLabels.map((label, i) => {
        const t = trace[i];
        return { label, ok: t ? t.ok !== false : undefined, detail: t?.detail };
      })
    : trace.map((t) => ({ label: t.step, ok: t.ok !== false, detail: t.detail }));

  const items = rows.map((r) => `
    <div class="aistage-row">
      <span class="aistage-row__icon aistage-row__icon--${r.ok === false ? "fail" : "ok"}">${r.ok === false ? ICONS.x : ICONS.check}</span>
      <span class="aistage-row__label">${esc(r.label)}</span>
      ${r.detail ? `<span class="aistage-row__detail">${esc(formatTraceDetail(r.detail))}</span>` : ""}
    </div>`).join("");

  return `${summary}
  <section class="card card--ai">
    <div class="card__head"><span class="ico">${ICONS.cpu}</span><h2>AI Analysis Pipeline</h2>${badge(modeLabel(mode), "b-out")}</div>
    <div class="card__body">
      <div class="aistage-rows">${items}</div>
      <p class="mode-note mt-3">Reflects the real pipeline trace for this assessment. It is not a simulation.</p>
    </div>
  </section>`;
}

/* ---- test coverage ---- */

function coveragePanel(report, summary, cov, ctx) {
  if (!cov) {
    return `<div class="empty"><span class="ico">${ICONS.info}</span><div><b>No coverage statistics</b>None were returned for this assessment.</div></div>`;
  }
  const testById = new Map((ctx.testCases || []).map((t) => [t.id, t]));
  const aiNote = new Map((report.coverageAssessment || []).map((c) => [c.acceptanceCriterionId, c.notes]));
  const acText = new Map((ctx.acceptanceCriteria || []).map((a) => [a.id, a.text]));

  const rows = cov.byCriterion.map((c) => {
    const flagged = (cov.uncoveredCritical || []).includes(c.id);
    const risk = c.coverage === "covered" ? ["LOW", "b-low"]
      : c.coverage === "partial" ? ["MEDIUM", "b-medium"]
      : c.critical ? ["HIGH", "b-high"] : ["MEDIUM", "b-medium"];
    const chips = (c.allTests || []).length
      ? `<div class="chips">${c.allTests.map((id) => {
          const t = testById.get(id);
          const raw = t?.statusRaw || (c.activeTests.includes(id) ? "passed" : "other");
          return `<span class="badge ${testStatusClass(raw)}" title="${esc(t?.title || id)}">${esc(t?.label || id)} · ${esc(upper(raw))}</span>`;
        }).join("")}</div>`
      : `<span class="muted">none</span>`;
    const note = aiNote.get(c.id);
    return `<tr class="${flagged ? "flagged" : ""}">
      <td data-label="Criterion"><div class="criterion-id"><span class="mono">${esc(c.id)}</span>${c.critical ? badge("Critical", "b-high") : ""}</div><div class="muted ac-text subtext">${acText.get(c.id) ? formatFreeText(acText.get(c.id)) : ""}</div></td>
      <td data-label="Coverage">${badge(upper(c.coverage), coverageClass(c.coverage))}${note ? `<div class="muted subtext">${formatFreeText(note)}</div>` : ""}</td>
      <td data-label="Related tests">${chips}</td>
      <td data-label="Risk">${badge(risk[0], risk[1])}</td>
    </tr>`;
  }).join("");

  const totals = `<div class="mini-cards mb-4">
    <div class="mini-card"><div class="mini-card__n">${cov.totalCriteria}</div><div class="mini-card__t">Acceptance criteria</div></div>
    <div class="mini-card"><div class="mini-card__n">${cov.coveredCriteria}</div><div class="mini-card__t">With a passing test</div></div>
    <div class="mini-card"><div class="mini-card__n">${cov.coveragePercent}%</div><div class="mini-card__t">Active coverage</div></div>
    <div class="mini-card"><div class="mini-card__n">${cov.totalTests}</div><div class="mini-card__t">Test cases (${cov.passed}P / ${cov.failed}F / ${cov.blocked}B)</div></div>
  </div>`;

  const uncovered = (cov.uncoveredCritical || []).length
    ? `<div class="banner"><span class="ico">${ICONS.alert}</span>
       <div><b>Critical criteria without active coverage:</b> ${cov.uncoveredCritical.map(esc).join(", ")}</div></div>`
    : "";

  // When the deterministic QA rules rate coverage insufficient, always show why —
  // so this section can never silently contradict the "Test coverage: INSUFFICIENT"
  // card. The reasons come from the gate's insufficientCoverage() output.
  const ruleReasons = Array.isArray(summary?.coverageReasons) ? summary.coverageReasons : [];
  const insufficient = summary?.testCoverage === "insufficient"
    ? `<div class="banner"><span class="ico">${ICONS.alert}</span>
       <div><b>The deterministic QA rules rate test coverage as insufficient for this release.</b>
       ${ruleReasons.length
         ? `<ul>${ruleReasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
         : " See the gate reasons and the decision trace for the specific rule that applied."}</div></div>`
    : "";

  return `${totals}${insufficient}${uncovered}${tableWrap(
    `<tr><th>Criterion</th><th>Coverage</th><th>Related tests</th><th>Risk</th></tr>`, rows)}`;
}

/* ---- missing scenarios ---- */

function scenariosPanel(report) {
  const list = Array.isArray(report.missingScenarios) ? report.missingScenarios : [];
  if (!list.length) {
    return `<div class="empty"><span class="ico">${ICONS.check}</span><div><b>No missing scenarios</b>None were derived from the submitted evidence.</div></div>`;
  }
  const groups = groupScenarios(list);
  return `<section class="card"><div class="card__head"><span class="ico">${ICONS.target}</span><h2>Missing Test Scenarios</h2>${badge(String(list.length), "b-neutral")}</div>
    <div class="card__body">${groups.map((g) => `<div class="scn-group">
      <div class="scn-group__h">${ICONS.target} ${esc(g.name)} ${badge(String(g.items.length), "b-neutral")}</div>
      <ul>${g.items.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
    </div>`).join("")}</div></section>`;
}

/* ---- known defects ---- */

function defectsPanel(report, ctx) {
  const defects = ctx.defects || [];
  if (!defects.length) {
    return `<div class="empty"><span class="ico">${ICONS.info}</span><div><b>No known defects</b>None were supplied with this assessment.</div></div>`;
  }
  const reviewById = new Map((report.defectReview || []).map((d) => [d.defectId, d]));
  const reasonsText = (report.reasons || []).join(" ");

  const rows = defects.map((d) => {
    const rev = reviewById.get(d.id);
    const flagged = reasonsText.includes(d.id);
    return `<tr class="${flagged ? "flagged" : ""}">
      <td data-label="Defect"><span class="mono">${esc(d.label || d.id)}</span></td>
      <td data-label="Severity">${badge(upper(d.severity), severityClass(d.severity))}</td>
      <td data-label="Status">${badge(upper(d.status), d.status === "open" ? "b-medium" : "b-low")}</td>
      <td data-label="Security">${d.security ? badge("Security", "b-security") : `<span class="muted">No</span>`}</td>
      <td data-label="Related area">${esc(displayArea(d.area))}</td>
      <td data-label="Release impact">${rev ? `${rev.stillRelevant ? badge("Relevant", "b-high") : badge("Not relevant", "b-neutral")} <div class="muted subtext">${formatFreeText(rev.notes || "")}</div>` : `<span class="muted">${formatFreeText(d.description)}</span>`}</td>
    </tr>`;
  }).join("");

  const openCount = defects.filter((d) => d.status === "open").length;
  return `<section class="card"><div class="card__head"><span class="ico">${ICONS.bug}</span><h2>Known Defects</h2>${badge(`${defects.length} total, ${openCount} open`, "b-neutral")}</div>
    <div class="card__body card__body--flush">${tableWrap(`<tr><th>Defect</th><th>Severity</th><th>Status</th><th>Security</th><th>Related area</th><th>Release impact</th></tr>`, rows)}</div></section>`;
}

/* ---- regression priorities ---- */

function regressionPanel(report) {
  const list = Array.isArray(report.regressionPriorities) ? report.regressionPriorities : [];
  if (!list.length) {
    return `<div class="empty"><span class="ico">${ICONS.info}</span><div><b>No regression priorities</b>None were returned.</div></div>`;
  }
  const order = { high: 0, medium: 1, low: 2 };
  const rows = [...list].sort((a, b) => (order[a.priority] ?? 3) - (order[b.priority] ?? 3)).map((p) => `<tr>
    <td data-label="Priority">${badge(upper(p.priority), priorityClass(p.priority))}</td>
    <td data-label="Area">${esc(displayArea(p.area))}</td>
    <td data-label="Reason">${formatFreeText(p.rationale || "")}</td>
  </tr>`).join("");
  return `<section class="card"><div class="card__head"><span class="ico">${ICONS.route}</span><h2>Regression Priorities</h2>${badge(String(list.length), "b-neutral")}</div>
    <div class="card__body card__body--flush">${tableWrap(`<tr><th>Priority</th><th>Area</th><th>Reason</th></tr>`, rows)}</div></section>`;
}

/* ---- decision trace ---- */

function decisionTraceAccordion(report, ctx, cov) {
  const trace = Array.isArray(report.pipelineTrace) ? report.pipelineTrace : [];
  const look = (key) => [...trace].reverse().find((t) => t.step === key);
  const okOf = (key) => { const e = look(key); return e ? e.ok !== false : undefined; };

  // The trace only ever renders after the pipeline finished, so an "ai" or
  // "gate" node reaching this point already succeeded (ok !== false) unless
  // explicitly marked otherwise — it must show the same completed checkmark
  // every other finished step does, not its identity icon forever (that
  // reads as a stuck spinner/gear, not "done"). The distinguishing color
  // (indigo for AI, cobalt for gate) still marks which kind of step it was.
  const dot = (kind, ok) => {
    if (kind === "ai") return ok === false
      ? `<span class="tdot tdot--ai tdot--fail">${ICONS.x}</span>`
      : `<span class="tdot tdot--ai">${ICONS.check}</span>`;
    if (kind === "gate") return ok === false
      ? `<span class="tdot tdot--gate tdot--fail">${ICONS.x}</span>`
      : `<span class="tdot tdot--gate">${ICONS.check}</span>`;
    if (ok === true) return `<span class="tdot tdot--ok">${ICONS.check}</span>`;
    if (ok === false) return `<span class="tdot tdot--fail">${ICONS.x}</span>`;
    return `<span class="tdot">${ICONS.dot}</span>`;
  };
  const node = (title, sub, { kind = "", ok } = {}) => `<div class="tnode">
    <div class="trail">${dot(kind, ok)}<span class="tline"></span></div>
    <div class="tbody"><h4>${esc(headingCase(title))}</h4><div class="sub">${esc(sub)}</div></div>
  </div>`;

  const counts = cov
    ? `${cov.totalCriteria} criteria · ${cov.totalTests} tests · ${(ctx.defects || []).length} defects`
    : `${(ctx.acceptanceCriteria || []).length} criteria · ${(ctx.testCases || []).length} tests`;

  const body = `<div class="trace">
    ${node("Release context", `${esc(ctx.criticality ? upper(ctx.criticality) + " criticality" : "Release scope and user story")} · normalised to a server-generated requirement id`, { ok: true })}
    ${node("QA evidence", counts + " prepared as dataset facts", { ok: true })}
    ${node("AI QA analysis", "Restates and explains risk from the submitted evidence", { kind: "ai", ok: okOf("ai-reasoning") })}
  </div>
  <div class="handoff">AI analysis identifies and explains risks. It does not decide whether the release is approved.</div>
  <div class="trace">
    ${node("Findings validation", "Rejects malformed output or any AI-supplied decision", { ok: okOf("validate-structured-findings") ?? (report.agentOutputValid === true) })}
    ${node("Findings adaptation", "Builds the gate input from dataset facts (deterministic, grounded)", { ok: okOf("deterministic-adapter") ?? (report.adapterOk === true) })}
    ${node("Deterministic QA gate", "Applies the fixed QA rules. Sole owner of the decision.", { kind: "gate" })}
  </div>
  <div class="tfinal ${decisionClass(report.releaseDecision)}">
    Final release decision: ${esc(decisionLabel(report.releaseDecision))}${report.firedRule ? ` · ${esc(report.firedRule)}` : ""}
  </div>`;

  return accordion("trace", { icon: ICONS.route, title: "Decision trace", meta: `<span class="lane lane--ai">AI</span><span class="lane lane--gate">Gate</span>` }, body);
}

/* ---- technical details (collapsed by default) ---- */

function technicalAccordion(result, report, meta, mode) {
  const prov = report.dataProvenance || result?.provenance || {};
  const provRows = Object.keys(prov).length
    ? Object.entries(prov).map(([k, v]) => `<tr><td class="mono" data-label="Key">${esc(k)}</td><td data-label="Value">${esc(String(v))}</td></tr>`).join("")
    : `<tr><td colspan="2" class="muted">No provenance.</td></tr>`;

  const traceRows = (report.pipelineTrace || []).map((t) => `<tr>
    <td class="mono" data-label="Step">${esc(t.step)}</td>
    <td data-label="Result">${t.ok === false ? badge("FAIL", "b-high") : badge("OK", "b-low")}</td>
    <td class="muted" data-label="Detail">${esc(formatTraceDetail(t.detail || ""))}</td>
  </tr>`).join("") || `<tr><td colspan="3" class="muted">No trace.</td></tr>`;

  const chipRow = (list) => `<div class="chips">${(list || []).map((s) => badge(String(s), "b-neutral")).join("")}</div>`;

  const body = `<div class="tech-body">
    <dl class="kv">
      <dt>Execution mode</dt><dd>${esc(modeLabel(mode))}${mode === "rules-based" ? `<span class="muted">. Offline analysis of your submitted evidence; no live model call.</span>` : ""}</dd>
      <dt>Findings validation</dt><dd>${report.agentOutputValid === true ? badge("Passed", "b-low") : badge("Failed / n/a", "b-high")}</dd>
      <dt>Adapter status</dt><dd>${report.adapterOk === true ? badge("Passed", "b-low") : badge("Failed / n/a", "b-high")}</dd>
      <dt>Gate rule fired</dt><dd class="mono">${esc(report.firedRule || "N/A")}</dd>
      <dt>Decision authority</dt><dd>${esc(report.decisionAuthority || "evaluateReleaseGate() (deterministic).")}</dd>
    </dl>
    <div><span class="eyebrow">Pipeline Stages</span>${chipRow((meta.pipelineStages || []).map((s, i) => `${i + 1}. ${s}`))}</div>
    <div><span class="eyebrow">MCP Tools</span>${chipRow(meta.mcpTools)}</div>
    <div><span class="eyebrow">Gate Evaluation Order</span>${chipRow(meta.evaluationOrder)}</div>
    <div><span class="eyebrow">Data Provenance</span>${tableWrap(`<tr><th>Key</th><th>Value</th></tr>`, provRows)}</div>
    <div><span class="eyebrow">Pipeline Trace</span>${tableWrap(`<tr><th>Step</th><th>Result</th><th>Detail</th></tr>`, traceRows)}</div>
  </div>`;

  return accordion("technical", { icon: ICONS.flask, title: "Technical details", meta: `<span class="muted">Collapsed by default</span>` }, body);
}

/* ============================ dedicated PDF / print report ==================

   A separate, print-optimised light-theme management report — NOT the dashboard
   DOM restyled. It is hidden on screen (`.print-report{display:none}`) and is
   the ONLY thing shown when the media is `print` (see styles.css @media print).
   Every value is read from the same completed-assessment `result` the screen
   report uses, so the two can never disagree.
   ========================================================================== */

function prKpi(label, value, tone, sub) {
  const mark = tone === "danger" ? ICONS.x : tone === "warn" ? ICONS.alert : tone === "ok" ? ICONS.check : ICONS.help;
  return `<div class="pr-kpi pr-kpi--${tone}">
    <span class="pr-kpi__label">${esc(label)}</span>
    <span class="pr-kpi__value">${mark}<span>${esc(value)}</span></span>
    <span class="pr-kpi__sub">${esc(sub || "")}</span>
  </div>`;
}

function prSeverity(level) {
  const l = String(level || "n/a").toLowerCase();
  const tone = l === "critical" || l === "high" ? "danger" : l === "medium" ? "warn" : l === "low" ? "ok" : "muted";
  const mark = l === "critical" ? "▲▲" : l === "high" ? "▲" : l === "medium" ? "●" : l === "low" ? "▽" : "—";
  return `<span class="pr-sev pr-sev--${tone}">${mark} ${esc(upper(level || "n/a"))}</span>`;
}

function printReport(result, report, summary, cov, ctx, meta, decision) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const genStamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const fileStamp = `${now.getFullYear()} ${pad(now.getMonth() + 1)} ${pad(now.getDate())}`;

  const assessmentId = String(ctx.requirementId || report.dataProvenance?.requirementId || report.scenario || "—");
  const assessmentName = String(ctx.releaseName || ctx.userStory || report.scenario || "Release assessment");
  const shortName = assessmentName.length > 46 ? assessmentName.slice(0, 44) + "…" : assessmentName;
  const reasons = Array.isArray(report.reasons) ? report.reasons : [];
  const decClass = decisionClass(decision);
  const decLabel = decisionLabel(decision);
  const decIcon = decision === "GO" ? ICONS.check
    : decision === "NO_GO" ? ICONS.x
    : decision === "CONDITIONAL" ? ICONS.alert : ICONS.help;

  const cr = summary?.changeRisk;
  const tc = summary?.testCoverage;
  const sec = summary?.securityRisk;
  const crTone = cr === "high" ? "danger" : cr === "medium" ? "warn" : cr ? "ok" : "muted";
  const tcTone = tc === "insufficient" ? "danger" : tc ? "ok" : "muted";
  const secTone = sec === "failed" ? "danger" : sec === "passed" ? "ok" : "muted";

  const actions = recommendedActions(report);

  /* ---- page 1: executive release summary ---- */
  const page1 = `
    <div class="pr-hero pr-hero--${decClass}">
      <div class="pr-hero__main">
        <span class="pr-eyebrow">Deterministic Release Gate</span>
        <div class="pr-hero__row"><span class="pr-hero__ring">${decIcon}</span><span class="pr-hero__value">${esc(decLabel)}</span></div>
        <span class="pr-hero__rule">${report.firedRule ? "Rule " + esc(report.firedRule) : "No rule identifier"}</span>
      </div>
      <div class="pr-hero__reason">
        <span class="pr-eyebrow">Decision Reason</span>
        <p>${esc(reasons[0] || "The deterministic QA gate reported no blocking reasons for this release.")}</p>
        ${(() => {
          const note = goEvidenceNote(decision, summary);
          return note ? `<p class="pr-notice${note.warn ? " pr-notice--warn" : ""}">${note.warn ? `<b>${esc(note.title)}</b> ` : ""}${esc(note.text)}</p>` : "";
        })()}
      </div>
    </div>

    <div class="pr-kpis">
      ${prKpi("Change Risk", cr ? upper(cr) : "Not calculated", crTone, cr ? "Inherent risk across affected areas" : "No adapter findings")}
      ${prKpi("Test Coverage", tc ? upper(tc) : "Not calculated", tcTone, cov ? cov.coveragePercent + "% criteria with a passing test" : "No coverage data")}
      ${prKpi("Security Risk", sec === "failed" ? "FAIL" : sec === "passed" ? "PASS" : "Scan not provided", secTone,
        sec === "failed" ? (summary.securityReasons?.length || 0) + " deterministic check(s) failed" : sec === "passed" ? "Deterministic checks passed" : "No security scan supplied")}
    </div>

    <h2 class="pr-h2">Top Release Blockers</h2>
    ${reasons.length
      ? `<ol class="pr-list pr-list--crit">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ol>`
      : `<p class="pr-muted">The deterministic gate reported no blocking reasons.</p>`}

    <h2 class="pr-h2">Recommended Next Actions</h2>
    ${actions.length
      ? `<ol class="pr-list pr-list--act">${actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ol>`
      : `<p class="pr-muted">No follow-up actions were derived from the submitted evidence.</p>`}

    <h2 class="pr-h2">Change Under Assessment</h2>
    <p class="pr-para">${esc(report.changeSummary || ctx.releaseScope || "Not provided.")}</p>
  `;

  /* ---- page 2: risk & defect register ---- */
  const reasonText = reasons.join(" ");
  const regRows = [
    ...(report.identifiedRisks || []).map((r) => ({
      id: "RISK", cat: displayArea(r.area), sev: r.severity, desc: r.description, status: "Identified", gate: "—",
    })),
    ...(report.regressionPriorities || []).map((p) => ({
      id: "REGRESS", cat: displayArea(p.area), sev: p.priority, desc: p.rationale, status: "Retest priority",
      gate: p.priority === "high" ? "Elevated" : "—",
    })),
    ...(ctx.defects || []).map((d) => {
      const id = d.label || d.id || "DEF";
      return {
        id, cat: displayArea(d.area), sev: d.severity, desc: d.description,
        status: `${upper(d.status || "")}${d.security ? " / SECURITY" : ""}`,
        gate: id && reasonText.includes(id) ? "Cited by gate" : "—",
      };
    }),
  ];
  const page2 = `
    <p class="pr-para">${regRows.length} entr${regRows.length === 1 ? "y" : "ies"} — AI-identified risks, regression priorities and supplied defects.
      Rows marked <b>Cited by gate</b> contributed to the deterministic decision.</p>
    <table class="pr-table">
      <thead><tr><th>Type / ID</th><th>Category</th><th>Severity</th><th>Description</th><th>Status</th><th>Gate relevance</th></tr></thead>
      <tbody>
        ${regRows.length ? regRows.map((r) => `<tr${r.gate === "Cited by gate" ? ' class="pr-flag"' : ""}>
          <td class="pr-mono">${esc(r.id)}</td>
          <td>${esc(r.cat)}</td>
          <td>${prSeverity(r.sev)}</td>
          <td>${esc(r.desc || "—")}</td>
          <td><span class="pr-pill">${esc(r.status || "—")}</span></td>
          <td>${r.gate === "Cited by gate" ? `<span class="pr-pill pr-pill--crit">${esc(r.gate)}</span>`
            : r.gate === "Elevated" ? `<span class="pr-pill pr-pill--warn">${esc(r.gate)}</span>` : esc(r.gate)}</td>
        </tr>`).join("") : `<tr><td colspan="6" class="pr-muted">No risk signals were identified from the submitted evidence.</td></tr>`}
      </tbody>
    </table>
  `;

  /* ---- page 3: quality gate & test evidence ---- */
  const uncovered = cov?.uncoveredCritical || [];
  const failedRules = [...new Set([
    ...(report.firedRule ? [report.firedRule] : []),
    ...reasons.flatMap((r) => String(r).match(/\b(?:GATE|SEC|COV|REG)-\d+\b/g) || []),
  ])];
  const execOther = cov ? (cov.blocked || 0) + (cov.other || 0) : 0;
  const execSeg = cov ? [["Passing", cov.passed, "ok"], ["Failing", cov.failed, "crit"], ["Blocked / other", execOther, "neutral"]] : [];
  const execBar = cov ? `<div class="pr-dist" role="img" aria-label="${esc(execSeg.map(([l, c]) => `${c} ${l.toLowerCase()}`).join(", "))}">${execSeg.map(([, c, t]) => (c ? `<i class="pr-dist--${t}" style="flex:${c}"></i>` : "")).join("")}</div>
    <div class="pr-leg">${execSeg.map(([l, c, t]) => `<span><i class="pr-dist--${t}"></i>${esc(l)} <b>${c}</b></span>`).join("")}</div>` : "";
  const page3 = `
    <h3 class="pr-h3">Test Execution Summary</h3>
    ${execBar}
    <table class="pr-table pr-table--kv">
      <tbody>
        <tr><th>Test cases supplied</th><td>${cov ? cov.totalTests : "—"}</td>
            <th>Passing</th><td>${cov ? cov.passed : "—"}</td></tr>
        <tr><th>Failing</th><td>${cov ? cov.failed : "—"}</td>
            <th>Blocked / other</th><td>${cov ? (cov.blocked + (cov.other || 0)) : "—"}</td></tr>
        <tr><th>Acceptance criteria</th><td>${cov ? cov.totalCriteria : "—"}</td>
            <th>Criteria with a passing test</th><td>${cov ? cov.coveredCriteria : "—"}</td></tr>
        <tr><th>Active coverage</th><td>${cov ? cov.coveragePercent + "%" : "—"}</td>
            <th>Coverage verdict</th><td>${tc ? upper(tc) : "Not calculated"}</td></tr>
      </tbody>
    </table>

    <h3 class="pr-h3">Uncovered Critical Criteria</h3>
    ${uncovered.length
      ? `<p class="pr-para pr-mono">${uncovered.map(esc).join(", ")}</p>`
      : `<p class="pr-muted">None — every critical acceptance criterion has an active test.</p>`}

    <h3 class="pr-h3">Failed Deterministic Rules</h3>
    ${failedRules.length
      ? `<p class="pr-para pr-mono">${failedRules.map(esc).join(", ")}</p>`
      : `<p class="pr-muted">No deterministic rule was recorded as failed.</p>`}

    <h3 class="pr-h3">Security Checks</h3>
    ${(summary?.securityReasons || []).length
      ? `<ul class="pr-list">${summary.securityReasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
      : `<p class="pr-muted">${sec === "passed" ? "Deterministic security checks passed." : "No security scan was supplied."}</p>`}

    <h3 class="pr-h3">Coverage Checks</h3>
    ${(summary?.coverageReasons || []).length
      ? `<ul class="pr-list">${summary.coverageReasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
      : `<p class="pr-muted">No coverage rule was recorded as failed.</p>`}

    <h3 class="pr-h3">Missing Test Scenarios</h3>
    ${(report.missingScenarios || []).length
      ? `<ul class="pr-list">${report.missingScenarios.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`
      : `<p class="pr-muted">No missing scenarios were derived from the submitted evidence.</p>`}
  `;

  /* ---- page 4: technical trace (appendix) ---- */
  const prov = report.dataProvenance || result?.provenance || {};
  const trace = report.pipelineTrace || [];
  const page4 = `
    <h3 class="pr-h3">Pipeline Stages</h3>
    <ol class="pr-list">${(meta.pipelineStages || []).map((s) => `<li>${esc(s)}</li>`).join("") || `<li class="pr-muted">Not recorded.</li>`}</ol>

    <h3 class="pr-h3">Gate Evaluation Order</h3>
    <p class="pr-para pr-mono">${(meta.evaluationOrder || []).map(esc).join(" → ") || "Not recorded."}</p>

    <h3 class="pr-h3">MCP Data Tools</h3>
    <p class="pr-para pr-mono">${(meta.mcpTools || []).map(esc).join(", ") || "Not recorded."}</p>

    <h3 class="pr-h3">Pipeline Trace</h3>
    <table class="pr-table">
      <thead><tr><th>Step</th><th>Result</th><th>Detail</th></tr></thead>
      <tbody>${trace.length ? trace.map((t) => `<tr>
        <td class="pr-mono">${esc(t.step)}</td>
        <td>${t.ok === false ? "FAIL" : "OK"}</td>
        <td>${esc(formatTraceDetail(t.detail || "—"))}</td>
      </tr>`).join("") : `<tr><td colspan="3" class="pr-muted">No trace recorded.</td></tr>`}</tbody>
    </table>

    <h3 class="pr-h3">Data Provenance</h3>
    <table class="pr-table pr-table--kv"><tbody>
      ${Object.keys(prov).length ? Object.entries(prov).map(([k, v]) =>
        `<tr><th>${esc(humanizeKey(k))}</th><td colspan="3">${esc(String(v))}</td></tr>`).join("")
        : `<tr><td class="pr-muted">No provenance recorded.</td></tr>`}
    </tbody></table>

    <h3 class="pr-h3">Decision Authority</h3>
    <p class="pr-para">${esc(report.decisionAuthority || "evaluateReleaseGate() (deterministic). The AI agent explains the risk; it does not decide.")}</p>
  `;

  const pages = [
    { title: "Executive release summary", html: page1 },
    { title: "Risk & defect register", html: page2 },
    { title: "Quality gate & test evidence", html: page3 },
    { title: "Technical trace", html: page4 },
  ];
  const total = pages.length;

  const runHead = (title) => `<div class="pr-runhead">
    <span class="pr-runhead__brand"><span class="pr-mark"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg></span>AI QA Release Risk &amp; Test Strategy — Release Risk Report</span>
    <span class="pr-runhead__id pr-mono">${esc(assessmentId)}</span>
  </div>`;
  const runFoot = (i) => `<div class="pr-runfoot">
    <span>${esc(shortName)}</span>
    <span>Confidential · Generated ${esc(genStamp)}</span>
    <span>Section ${i} of ${total}</span>
  </div>`;

  return `<div class="print-report" role="document" aria-hidden="true" data-filename="Release Risk Report_${esc(assessmentId)}_${esc(fileStamp)}.pdf">
    ${pages.map((p, idx) => `<section class="pr-page">
      ${runHead(p.title)}
      <header class="pr-pagehead${idx === 0 ? " pr-pagehead--lead" : ""}">
        <div class="pr-pagehead__id">
          ${idx === 0
            ? `<span class="pr-eyebrow">Release Risk Report</span>
               <h1 class="pr-h1">${esc(assessmentName)}</h1>
               <p class="pr-sub pr-mono">${esc(assessmentId)}${ctx.criticality ? " · " + esc(upper(ctx.criticality)) + " criticality" : ""} · Generated ${esc(genStamp)}</p>`
            : `<span class="pr-eyebrow">Section ${idx + 1} of ${total}</span>
               <h1 class="pr-h1 pr-h1--sm">${esc(headingCase(p.title))}</h1>
               <p class="pr-sub pr-mono">${esc(assessmentName)} · ${esc(assessmentId)}</p>`}
        </div>
      </header>
      <div class="pr-body">${p.html}</div>
      ${runFoot(idx + 1)}
    </section>`).join("")}
  </div>`;
}

/* -------------------------------- errors ----------------------------- */

export function errorView(message) {
  return `${pageHead(3, "Analyze release risk")}
  <div class="proc"><div class="banner" role="alert">
    <span class="ico">${ICONS.alert}</span>
    <div><b>The assessment could not be completed.</b> ${esc(message || "No release decision is shown.")}</div>
  </div></div>${actionBar("<b>The assessment did not complete.</b> No release decision is shown.",
    `<button class="btn btn--ghost" type="button" data-act="new">New assessment</button>
     <button class="btn" type="button" data-act="retry">Retry</button>`)}`;
}
