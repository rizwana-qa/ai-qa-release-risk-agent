// Report + processing renderers. Every value shown here comes from the backend
// response. This file contains NO risk / coverage / security / decision logic —
// the release decision is read verbatim from `report.releaseDecision`, which is
// produced only by the deterministic QA gate. All interpolated values pass
// through the escaping helpers in format.js.

import { ICONS } from "./icons.js";
import {
  esc, humanizeArea, displayArea, formatFreeText, upper, decisionLabel, decisionClass,
  severityClass, priorityClass, coverageClass, testStatusClass, groupScenarios, formatTraceDetail,
} from "./format.js";

/* -------------------------------- primitives ---------------------------- */

const badge = (text, cls) => `<span class="badge ${cls}">${esc(text)}</span>`;

function accordion(id, { icon, title, meta = "", open = false, ai = false }, bodyHtml) {
  return `<section class="acc${open ? " open" : ""}${ai ? " card--ai" : ""}" data-acc="${esc(id)}">
    <button class="acc__head" type="button" aria-expanded="${open ? "true" : "false"}" aria-controls="acc-body-${esc(id)}">
      <span class="ico">${icon}</span>
      <h3>${esc(title)}</h3>
      <span class="acc__meta">${meta}<span class="chev">${ICONS.chevron}</span></span>
    </button>
    <div class="acc__body" id="acc-body-${esc(id)}">${bodyHtml}</div>
  </section>`;
}

const tableWrap = (head, rows) =>
  `<div class="tablewrap"><table class="data"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;

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
      ${s.detail ? `<div class="pstep__state" style="text-transform:none;letter-spacing:0;color:var(--ink-3)">${esc(s.detail)}</div>` : ""}
    </div>`).join("");

  const foot = failed
    ? `<div class="banner mt-3">
        <span class="ico">${ICONS.alert}</span>
        <div><b>The assessment did not complete.</b> No release decision is shown. You can retry or start a new assessment.</div>
        <div class="actions">
          <button class="btn btn--ghost btn--sm" type="button" data-act="retry">Retry</button>
          <button class="btn btn--ghost btn--sm" type="button" data-act="new">New assessment</button>
        </div>
      </div>`
    : `<p class="mode-note mt-3">This runs the real pipeline. Each stage is a genuine step, not a simulation, and usually takes a few seconds.</p>`;

  return `<div class="proc">
    <div class="card">
      <div class="card__head"><span class="ico">${ICONS.cpu}</span><h2>Analyzing release risk</h2></div>
      <div class="card__body">
        <div class="stepper">${steps}</div>
        ${foot}
      </div>
    </div>
  </div>`;
}

export function needsInputView({ missing = [], problems = [] }) {
  const items = [...missing.map((m) => `Required: ${m}`), ...problems];
  return `<div class="proc"><div class="banner banner--warn">
    <span class="ico">${ICONS.alert}</span>
    <div>
      <b>More information is needed before this release can be assessed.</b>
      <ul style="margin:6px 0 0;padding-left:18px">${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
    </div>
    <div class="actions"><button class="btn btn--ghost btn--sm" type="button" data-act="edit">Back to workspace</button></div>
  </div></div>`;
}

/* ------------------------------- report view -------------------------- */

export function reportView(result) {
  const report = result?.report || null;
  const summary = result?.summary || null;
  const cov = result?.coverageStats || null;
  const ctx = result?.context || {};
  const meta = result?.meta || {};
  const mode = result?.mode || "rules-based";

  const decision = report?.releaseDecision ?? null;
  const decisionClean = ["GO", "NO_GO", "CONDITIONAL"].includes(decision);
  const pipelineBroke = report && (report.agentOutputValid !== true || report.adapterOk !== true);

  const parts = [];

  if (!report) {
    return `<div class="report">${errorView("The pipeline did not return a report. No release decision can be shown.")}</div>`;
  }

  if (pipelineBroke || !decisionClean) {
    parts.push(`<div class="banner">
      <span class="ico">${ICONS.alert}</span>
      <div><b>The assessment completed with problems.</b>
      ${!decisionClean
        ? "The pipeline did not produce a valid decision; the deterministic gate failed safe. "
        : "The AI analysis or its adaptation did not validate cleanly; the deterministic gate failed safe. "}
      See the reasons and the decision trace below.</div>
    </div>`);
  }

  parts.push(execGrid(report, summary, cov, decision));
  parts.push(riskSignalsPanel(report, ctx));
  parts.push(aiStagePanel(report, meta));
  parts.push(historyEmptyState());
  parts.push(readinessCard(report, summary, cov));
  parts.push(aiAnalysisAccordion(report));
  parts.push(coverageAccordion(report, summary, cov, ctx));
  parts.push(missingScenariosAccordion(report));
  parts.push(defectsAccordion(report, ctx));
  parts.push(regressionAccordion(report));
  parts.push(riskyAccordion(report));
  parts.push(decisionTraceAccordion(report, ctx, cov));
  parts.push(technicalAccordion(result, report, meta, mode));

  return `<div class="report report--enter">
    <div class="report__head">
      <div>
        <span class="eyebrow">Release risk report</span>
        <h1>${esc(ctx.releaseName || ctx.userStory || report.scenario || "Release assessment")}</h1>
        <p class="report__subtitle">AI-assisted risk analysis with a deterministic release-gate decision.</p>
      </div>
      <div class="report__actions">
        <button class="btn btn--ghost btn--sm" type="button" data-act="print">${ICONS.file} Print / PDF</button>
        <button class="btn btn--ghost btn--sm" type="button" data-act="new">${ICONS.refresh} New assessment</button>
      </div>
    </div>
    ${parts.join("\n")}
  </div>`;
}

/* ---- executive grid ---- */

function metric(label, value, cls, hint, icon) {
  return `<div class="metric metric--${cls}">
    <span class="metric__label">${icon ? `<span class="metric__icon">${icon}</span>` : ""}${esc(label)}</span>
    <span class="metric__value">${esc(value)}</span>
    ${hint ? `<span class="metric__hint">${esc(hint)}</span>` : ""}
  </div>`;
}

function execGrid(report, summary, cov, decision) {
  const cr = summary?.changeRisk;
  const crCls = cr === "high" ? "danger" : cr === "medium" ? "warn" : cr ? "ok" : "muted";

  const tc = summary?.testCoverage;
  const tcCls = tc === "insufficient" ? "danger" : tc ? "ok" : "muted";
  const covHint = cov ? `${cov.coveragePercent}% of criteria with a passing test` : "";

  const sec = summary?.securityRisk;
  const secCls = sec === "failed" ? "danger" : sec ? "ok" : "muted";

  // A one-line, plain-language summary — taken verbatim from the deterministic
  // gate's first reason (or a neutral statement when it reported none).
  const firstReason = Array.isArray(report.reasons) && report.reasons.length
    ? report.reasons[0]
    : "The deterministic QA gate reported no blocking reasons for this release.";

  const ringIcon = decision === "GO" ? ICONS.check : decision === "NO_GO" ? ICONS.x : decision === "CONDITIONAL" ? ICONS.alert : ICONS.dot;

  return `<div class="exec-grid">
    <div class="decision-box ${decisionClass(decision)}">
      <div class="decision-ring" aria-hidden="true"><span class="decision-ring__icon">${ringIcon}</span></div>
      <div class="decision-box__text">
        <span class="decision-box__label">Release decision</span>
        <span class="decision-box__value">${esc(decisionLabel(decision))}</span>
        <span class="decision-box__meta">${report.firedRule ? `Deterministic gate · ${esc(report.firedRule)}` : "Deterministic QA gate"}</span>
        <p class="decision-box__note">${esc(firstReason)}</p>
      </div>
    </div>
    ${metric("Change risk", cr ? upper(cr) : "N/A", crCls, "Highest-risk area affected", ICONS.gauge)}
    ${metric("Test coverage", tc ? upper(tc) : "N/A", tcCls, covHint, ICONS.shield)}
    ${metric("Security risk", sec === "failed" ? "FAIL" : sec === "passed" ? "PASS" : "N/A", secCls, "Security failure check", ICONS.lock)}
  </div>`;
}

/* ---- risk signals (real identifiedRisks + regressionPriorities + defects + gate reasons; no invented scores) ---- */

/** One labelled, counted section per kind of signal — never a single flat
 * list. Identified risks, regression priorities and open defects are three
 * different questions ("what's risky", "what to retest", "what's already
 * broken"); folding them into one undifferentiated row list was the actual
 * source of the report reading as a dense, monotonous wall of near-identical
 * rows. */
function riskGroup(icon, title, rows) {
  if (!rows.length) return "";
  return `<div class="risksig-group">
    <div class="risksig-group__head">${icon}<span>${esc(title)}</span><span class="risksig-group__count">${rows.length}</span></div>
    <div class="risksig-rows">${rows.map((r) => `
      <div class="risksig-row">
        <span class="risksig-row__area">${r.id ? `<span class="mono risksig-row__idtag">${esc(r.id)}</span> ` : ""}${esc(r.area)}</span>
        ${badge(upper(r.level || "n/a"), r.cls)}
        <span class="risksig-row__note">${r.note ? formatFreeText(r.note) : ""}</span>
      </div>`).join("")}</div>
  </div>`;
}

function riskSignalsPanel(report, ctx) {
  const risks = Array.isArray(report.identifiedRisks) ? report.identifiedRisks : [];
  const regress = Array.isArray(report.regressionPriorities) ? report.regressionPriorities : [];
  const defects = Array.isArray(ctx.defects) ? ctx.defects : [];
  const openDefects = defects.filter((d) => d && d.status === "open");
  const reasons = Array.isArray(report.reasons) ? report.reasons : [];

  const riskRows = risks.map((r) => ({ area: displayArea(r.area), level: r.severity, cls: severityClass(r.severity), note: r.description }));
  const regressRows = regress.map((p) => ({ area: displayArea(p.area), level: p.priority, cls: priorityClass(p.priority), note: p.rationale }));
  const defectRows = openDefects.map((d) => ({ id: d.label || d.id, area: displayArea(d.area), level: d.severity, cls: severityClass(d.severity), note: d.description }));

  const hasAny = riskRows.length || regressRows.length || defectRows.length;
  const body = hasAny
    ? riskGroup(ICONS.alert, "Identified risks", riskRows)
      + riskGroup(ICONS.target, "Regression priorities", regressRows)
      + riskGroup(ICONS.bug, "Open defects", defectRows)
    : `<p class="muted">No specific risk signals were identified from the submitted evidence.</p>`;

  const gateNote = reasons.length
    ? `<div class="risksig-gate"><span class="eyebrow">Quality gate</span><ul class="bullets bullets--reason">${reasons.map((r) => `<li>${ICONS.scale}<span>${esc(r)}</span></li>`).join("")}</ul></div>`
    : "";

  return `<section class="card card--risksig">
    <div class="card__head"><span class="ico">${ICONS.gauge}</span><h2>Risk signals</h2><span class="hint">From AI analysis + deterministic QA data</span></div>
    <div class="card__body">
      ${body}
      ${gateNote}
    </div>
  </section>`;
}

/* ---- AI pipeline stage status (real pipelineTrace + meta.pipelineStages; post-completion, not animated) ---- */

function aiStagePanel(report, meta) {
  const stageLabels = Array.isArray(meta.pipelineStages) ? meta.pipelineStages : [];
  const trace = Array.isArray(report.pipelineTrace) ? report.pipelineTrace : [];
  if (!stageLabels.length && !trace.length) return "";

  // Best-effort real status per labelled stage: match by position against the
  // trace this exact run produced. No fabricated "in progress" states here —
  // this renders only once the pipeline has already finished.
  const rows = stageLabels.length
    ? stageLabels.map((label, i) => {
        const t = trace[i];
        const ok = t ? t.ok !== false : undefined;
        return { label, ok, detail: t?.detail };
      })
    : trace.map((t) => ({ label: t.step, ok: t.ok !== false, detail: t.detail }));

  const items = rows.map((r) => `
    <div class="aistage-row">
      <span class="aistage-row__icon aistage-row__icon--${r.ok === false ? "fail" : "ok"}">${r.ok === false ? ICONS.x : ICONS.check}</span>
      <span class="aistage-row__label">${esc(r.label)}</span>
      ${r.detail ? `<span class="aistage-row__detail">${esc(formatTraceDetail(r.detail))}</span>` : ""}
    </div>`).join("");

  return `<section class="card card--ai">
    <div class="card__head"><span class="ico">${ICONS.sparkle}</span><h2>AI analysis pipeline</h2><span class="lane lane--ai">Complete</span></div>
    <div class="card__body">
      <div class="aistage-rows">${items}</div>
      <p class="mode-note mt-3">Reflects the real pipeline trace for this assessment. It is not a simulation.</p>
    </div>
  </section>`;
}

/* ---- release history (this system has no cross-release historical store) ---- */

function historyEmptyState() {
  return `<div class="hist-empty">
    <span class="ico">${ICONS.book}</span>
    <span>No historical release data available. Each assessment reflects only the evidence submitted for this release.</span>
  </div>`;
}

/* ---- release readiness (non-technical) ---- */

function readinessCard(report, summary, cov) {
  const reasons = Array.isArray(report.reasons) ? report.reasons : [];
  const whyItems = reasons.length
    ? reasons.map((r) => `<li>${ICONS.alert}<span>${esc(r)}</span></li>`).join("")
    : `<li>${ICONS.check}<span>The deterministic gate reported no blocking reasons.</span></li>`;

  // Surface the security-failure evidence from the QA rules even when a
  // higher-precedence rule fired (so the "Security risk: FAIL" card is never
  // shown without its supporting reasons).
  const secReasons = summary?.securityRisk === "failed" && Array.isArray(summary.securityReasons)
    ? summary.securityReasons : [];
  const secBlock = secReasons.length
    ? `<div>
         <span class="eyebrow">Security checks (deterministic QA rules)</span>
         <ul class="bullets bullets--reason">${secReasons.map((r) => `<li>${ICONS.shield}<span>${esc(r)}</span></li>`).join("")}</ul>
       </div>`
    : "";

  const actions = recommendedActions(report);
  const actionItems = actions.length
    ? actions.map((a) => `<li>${ICONS.target}<span>${esc(a)}</span></li>`).join("")
    : `<li>${ICONS.check}<span>No follow-up actions were derived from the submitted evidence.</span></li>`;

  const miniCards = cov ? `<div class="mini-cards">
    <div class="mini-card"><div class="mini-card__n">${cov.totalTests}</div><div class="mini-card__t">Test cases supplied</div></div>
    <div class="mini-card"><div class="mini-card__n">${cov.passed}</div><div class="mini-card__t">Passing</div></div>
    <div class="mini-card${cov.failed ? " mini-card--flag" : ""}"><div class="mini-card__n">${cov.failed}</div><div class="mini-card__t">Failing</div></div>
    <div class="mini-card${cov.uncoveredCritical?.length ? " mini-card--flag" : ""}"><div class="mini-card__n">${cov.uncoveredCritical?.length ?? 0}</div><div class="mini-card__t">Uncovered critical criteria</div></div>
  </div>` : "";

  return `<section class="card card--gate">
    <div class="card__head"><span class="ico">${ICONS.scale}</span><h2>Release readiness</h2><span class="lane lane--gate">Deterministic gate</span></div>
    <div class="card__body">
      <div class="readiness">
        <div class="decision-box ${decisionClass(report.releaseDecision)}">
          <span class="decision-box__label">Decision</span>
          <span class="decision-box__value">${esc(decisionLabel(report.releaseDecision))}</span>
          <span class="decision-box__meta">${report.firedRule ? esc(report.firedRule) : ""}</span>
        </div>
        <div class="readiness__body">
          ${miniCards}
          <div class="readiness__explanation">
            <div>
              <span class="eyebrow">Why?</span>
              <ul class="bullets bullets--reason">${whyItems}</ul>
            </div>
            ${secBlock}
          </div>
          <div class="readiness__actions">
            <span class="eyebrow">Recommended next actions</span>
            <ul class="bullets bullets--action">${actionItems}</ul>
          </div>
        </div>
      </div>
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

/* ---- AI analysis (advisory) ---- */

function aiAnalysisAccordion(report) {
  const riskCount = Array.isArray(report.identifiedRisks) ? report.identifiedRisks.length : 0;

  // The itemized risks (and regression priorities, and open defects) live
  // once, in the Risk Signals panel above — this section owns the narrative
  // summary only, plus a pointer, so the same finding is never listed twice.
  const body = `
    <span class="eyebrow">Change summary</span>
    <p class="lead mb-4">${report.changeSummary ? formatFreeText(report.changeSummary) : "Not provided."}</p>
    ${riskCount
      ? `<p class="hint">${riskCount} identified risk${riskCount === 1 ? "" : "s"}. See Risk Signals above for the itemized list.</p>`
      : `<p class="muted">No risks were identified from the submitted evidence.</p>`}`;

  return accordion("ai", { icon: ICONS.sparkle, title: "AI Risk Intelligence", meta: `<span class="lane lane--ai">Advisory</span>`, open: true, ai: true }, body);
}

/* ---- test coverage ---- */

function coverageAccordion(report, summary, cov, ctx) {
  if (!cov) {
    return accordion("coverage", { icon: ICONS.shield, title: "Test coverage" },
      `<p class="muted">No coverage statistics were returned.</p>`);
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
    ? `<div class="banner mb-3"><span class="ico">${ICONS.alert}</span>
       <div><b>Critical criteria without active coverage:</b> ${cov.uncoveredCritical.map(esc).join(", ")}</div></div>`
    : "";

  // When the deterministic QA rules rate coverage insufficient, always show why —
  // so this section can never silently contradict the "Test coverage: INSUFFICIENT"
  // executive card. The reasons come from the gate's insufficientCoverage() output.
  const ruleReasons = Array.isArray(summary?.coverageReasons) ? summary.coverageReasons : [];
  const insufficient = summary?.testCoverage === "insufficient"
    ? `<div class="banner mb-3"><span class="ico">${ICONS.alert}</span>
       <div><b>The deterministic QA rules rate test coverage as insufficient for this release.</b>
       ${ruleReasons.length
         ? `<ul class="bullets mt-2">${ruleReasons.map((r) => `<li><span>${esc(r)}</span></li>`).join("")}</ul>`
         : " See the gate reasons and the decision trace for the specific rule that applied."}</div></div>`
    : "";

  return accordion("coverage", { icon: ICONS.shield, title: "Test coverage", meta: badge(`${cov.coveragePercent}%`, summary?.testCoverage === "insufficient" || cov.coveragePercent < 80 ? "b-medium" : "b-low") },
    totals + insufficient + uncovered + tableWrap(
      `<tr><th>Criterion</th><th>Coverage</th><th>Related tests</th><th>Risk</th></tr>`, rows));
}

/* ---- missing scenarios ---- */

function missingScenariosAccordion(report) {
  const list = Array.isArray(report.missingScenarios) ? report.missingScenarios : [];
  if (!list.length) {
    return accordion("missing", { icon: ICONS.target, title: "Missing test scenarios" },
      `<p class="muted">No missing scenarios were derived from the submitted evidence.</p>`);
  }
  const groups = groupScenarios(list);
  const body = groups.map((g) => `<div class="scn-group">
    <div class="scn-group__h">${ICONS.target} ${esc(g.name)} ${badge(String(g.items.length), "b-neutral")}</div>
    <ul style="margin:0;padding-left:18px">${g.items.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
  </div>`).join("");
  return accordion("missing", { icon: ICONS.target, title: "Missing test scenarios", meta: badge(String(list.length), "b-neutral") }, body);
}

/* ---- known defects ---- */

function defectsAccordion(report, ctx) {
  const defects = ctx.defects || [];
  if (!defects.length) {
    return accordion("defects", { icon: ICONS.bug, title: "Known defects" },
      `<p class="muted">No known defects were supplied with this assessment.</p>`);
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
  return accordion("defects", { icon: ICONS.bug, title: "Known defects", meta: badge(`${defects.length} total, ${openCount} open`, "b-neutral") },
    tableWrap(`<tr><th>Defect</th><th>Severity</th><th>Status</th><th>Security</th><th>Related area</th><th>Release impact</th></tr>`, rows));
}

/* ---- regression priorities ---- */

function regressionAccordion(report) {
  const list = Array.isArray(report.regressionPriorities) ? report.regressionPriorities : [];
  if (!list.length) {
    return accordion("regression", { icon: ICONS.route, title: "Regression priorities" },
      `<p class="muted">No regression priorities were returned.</p>`);
  }
  const order = { high: 0, medium: 1, low: 2 };
  const rows = [...list].sort((a, b) => (order[a.priority] ?? 3) - (order[b.priority] ?? 3)).map((p) => `<tr>
    <td data-label="Priority">${badge(upper(p.priority), priorityClass(p.priority))}</td>
    <td data-label="Area">${esc(displayArea(p.area))}</td>
    <td data-label="Reason">${formatFreeText(p.rationale || "")}</td>
  </tr>`).join("");
  return accordion("regression", { icon: ICONS.route, title: "Regression priorities", meta: badge(String(list.length), "b-neutral") },
    tableWrap(`<tr><th>Priority</th><th>Area</th><th>Reason</th></tr>`, rows));
}

/* ---- why is this release risky ---- */

function riskyAccordion(report) {
  const text = report.aiQaExplanation;
  return accordion("risky", { icon: ICONS.info, title: "Why is this release risky?", meta: `<span class="lane lane--ai">AI narrative</span>`, ai: true },
    text ? `<p class="lead">${formatFreeText(text)}</p>` : `<p class="muted">No explanation was produced.</p>`);
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
    <div class="tbody"><h4>${esc(title)}</h4><div class="sub">${esc(sub)}</div></div>
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
  const modeLabel = mode === "gemini" ? "AI analysis: Gemini 3.6 Flash"
    : mode === "recorded" ? "Recorded"
    : "QA analysis mode: Rules based";
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
      <dt>Execution mode</dt><dd>${esc(modeLabel)}${mode === "rules-based" ? `<span class="muted">. Offline analysis of your submitted evidence; no live model call.</span>` : ""}</dd>
      <dt>Findings validation</dt><dd>${report.agentOutputValid === true ? badge("Passed", "b-low") : badge("Failed / n/a", "b-high")}</dd>
      <dt>Adapter status</dt><dd>${report.adapterOk === true ? badge("Passed", "b-low") : badge("Failed / n/a", "b-high")}</dd>
      <dt>Gate rule fired</dt><dd class="mono">${esc(report.firedRule || "N/A")}</dd>
      <dt>Decision authority</dt><dd>${esc(report.decisionAuthority || "evaluateReleaseGate() (deterministic).")}</dd>
    </dl>
    <div><span class="eyebrow">Pipeline stages</span>${chipRow((meta.pipelineStages || []).map((s, i) => `${i + 1}. ${s}`))}</div>
    <div><span class="eyebrow">MCP tools</span>${chipRow(meta.mcpTools)}</div>
    <div><span class="eyebrow">Gate evaluation order</span>${chipRow(meta.evaluationOrder)}</div>
    <div><span class="eyebrow">Data provenance</span>${tableWrap(`<tr><th>Key</th><th>Value</th></tr>`, provRows)}</div>
    <div><span class="eyebrow">Pipeline trace</span>${tableWrap(`<tr><th>Step</th><th>Result</th><th>Detail</th></tr>`, traceRows)}</div>
  </div>`;

  return accordion("technical", { icon: ICONS.flask, title: "Technical details", meta: `<span class="muted">Collapsed by default</span>` }, body);
}

/* -------------------------------- errors ----------------------------- */

export function errorView(message) {
  return `<div class="proc"><div class="banner">
    <span class="ico">${ICONS.alert}</span>
    <div><b>The assessment could not be completed.</b> ${esc(message || "No release decision is shown.")}</div>
    <div class="actions">
      <button class="btn btn--ghost btn--sm" type="button" data-act="retry">Retry</button>
      <button class="btn btn--ghost btn--sm" type="button" data-act="new">New assessment</button>
    </div>
  </div></div>`;
}
