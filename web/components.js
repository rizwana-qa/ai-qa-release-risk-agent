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

  // Priority 1-3: decision, why, blockers. Priority 4: KPIs. Priority 5:
  // recommendations + readiness. Priority 6: AI pipeline, narrative, evidence,
  // audit. This ordering is the on-screen reading order; the dedicated print
  // layer (printReport) re-expresses the same data for paper.
  parts.push(statusBanner(report, summary, decision));
  parts.push(execSection(report, summary, cov, decision));
  parts.push(riskRegister(report, ctx));
  parts.push(recommendationsCard(report));
  parts.push(readinessCard(report, summary, cov));
  parts.push(aiStagePanel(report, meta));
  parts.push(aiAnalysisAccordion(report));
  parts.push(coverageAccordion(report, summary, cov, ctx));
  parts.push(missingScenariosAccordion(report));
  parts.push(defectsAccordion(report, ctx));
  parts.push(regressionAccordion(report));
  parts.push(riskyAccordion(report));
  parts.push(decisionTraceAccordion(report, ctx, cov));
  parts.push(technicalAccordion(result, report, meta, mode));
  parts.push(historyEmptyState());

  const assessmentId = esc(ctx.requirementId || report.dataProvenance?.requirementId || report.scenario || "—");
  const assessmentName = esc(ctx.releaseName || ctx.userStory || report.scenario || "Release assessment");
  const description = ctx.releaseScope || ctx.userStory || "";

  return `<div class="report report--enter">
    <header class="report__head">
      <div class="report__ident">
        <span class="eyebrow">Release Risk Report</span>
        <div class="report__idline"><span class="report__idtag mono">${assessmentId}</span></div>
        <h1>${assessmentName}</h1>
        ${description ? `<p class="report__subtitle">${esc(clip(String(description), 200))}</p>` : ""}
      </div>
      <div class="report__actions">
        <button class="btn btn--ghost" type="button" data-act="print">${ICONS.file} Print / PDF</button>
        <button class="btn btn--primary" type="button" data-act="new">${ICONS.refresh} New Assessment</button>
      </div>
    </header>
    ${parts.join("\n")}
    ${printReport(result, report, summary, cov, ctx, meta, decision)}
  </div>`;
}

/* ---- executive decision grid: decision card + 3 KPIs + rationale panel ---- */

/** Wording for an unavailable metric — never a bare "N/A", never anything that
 * could read as success. */
function kpiUnavailable(kind) {
  return kind === "security" ? "Scan not provided" : "Not calculated";
}

function kpiCard(label, value, cls, supporting, icon) {
  return `<div class="kpi kpi--${cls}">
    <span class="kpi__label"><span class="kpi__icon">${icon}</span>${esc(label)}</span>
    <span class="kpi__value">${esc(value)}</span>
    <span class="kpi__sub">${esc(supporting || "")}</span>
  </div>`;
}

/** The single most prominent element on the page: the GO / NO GO / CONDITIONAL
 * value, its gate identifier, and up to three of the gate's own blocking
 * reasons. Every value is read verbatim from the deterministic gate. */
function decisionCard(report, decision) {
  const reasons = Array.isArray(report.reasons) ? report.reasons : [];
  const ringIcon = decision === "GO" ? ICONS.check
    : decision === "NO_GO" ? ICONS.x
    : decision === "CONDITIONAL" ? ICONS.alert : ICONS.dot;
  const blockers = reasons.slice(0, 3);
  const blockLabel = decision === "GO" ? "Gate checks" : decision === "CONDITIONAL" ? "Conditions" : "Top blockers";
  return `<div class="decision-box ${decisionClass(decision)}" role="group" aria-label="Release decision">
    <div class="decision-box__ring" aria-hidden="true">${ringIcon}</div>
    <span class="decision-box__label">Release decision</span>
    <span class="decision-box__value">${esc(decisionLabel(decision))}</span>
    <span class="decision-box__meta">Deterministic gate${report.firedRule ? ` · <span class="mono">${esc(report.firedRule)}</span>` : ""}</span>
    ${blockers.length ? `<div class="decision-box__blockers">
      <span class="eyebrow">${blockLabel}</span>
      <ul>${blockers.map((r) => `<li>${ICONS.dot}<span>${esc(r)}</span></li>`).join("")}</ul>
    </div>` : ""}
    <p class="decision-box__authority">Decided by the deterministic QA gate from the submitted evidence. AI analysis explains the risk; it does not override this decision.</p>
  </div>`;
}

/** "Why release is blocked / conditional / cleared" — grounded entirely in the
 * gate's reasons, the rule identifiers embedded in them, the uncovered-critical
 * list from coverage, and the pipeline trace. Nothing invented. */
function rationalePanel(report, summary, cov, decision) {
  const reasons = Array.isArray(report.reasons) ? report.reasons : [];
  const heading = decision === "NO_GO" ? "Why this release is blocked"
    : decision === "CONDITIONAL" ? "Why this release is conditional"
    : decision === "GO" ? "Why this release is cleared"
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

  const missing = [
    ...((cov?.uncoveredCritical || []).map((id) => `${id} — critical criterion, no active test`)),
    ...((report.missingScenarios || []).slice(0, 3)),
  ];

  const trace = Array.isArray(report.pipelineTrace) ? report.pipelineTrace : [];
  const gateStep = [...trace].reverse().find((t) => /gate/.test(t.step || ""));

  return `<div class="rationale">
    <div class="rationale__head"><span class="ico">${ICONS.scale}</span><h3>${esc(heading)}</h3></div>
    <p class="rationale__lead">${esc(lead)}</p>
    <div class="rationale__cols">
      <div>
        <span class="eyebrow">${ruleIds.length > 1 ? "Applied gate rules" : "Applied gate rule"}</span>
        ${ruleIds.length
          ? `<div class="chips">${ruleIds.map((id) => `<span class="badge b-neutral mono">${esc(id)}</span>`).join("")}</div>`
          : `<p class="muted">None recorded.</p>`}
        ${gateStep?.detail ? `<p class="rationale__trace">Gate outcome: <span class="mono">${esc(formatTraceDetail(gateStep.detail))}</span></p>` : ""}
      </div>
      <div>
        <span class="eyebrow">Missing / incomplete evidence</span>
        ${missing.length
          ? `<ul class="rationale__missing">${missing.map((m) => `<li>${ICONS.alert}<span>${esc(m)}</span></li>`).join("")}</ul>`
          : `<p class="muted">No evidence gaps were recorded for this release.</p>`}
      </div>
    </div>
  </div>`;
}

function execSection(report, summary, cov, decision) {
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

  return `<section class="exec-grid">
    ${decisionCard(report, decision)}
    <div class="exec-grid__kpis">
      ${kpiCard("Change risk", cr ? upper(cr) : kpiUnavailable("change"), crCls,
        cr ? (crArea ? `Highest-risk area: ${crArea}` : "Based on affected areas and inherent risk") : "Adapter produced no findings", ICONS.gauge)}
      ${kpiCard("Test coverage", tc ? upper(tc) : kpiUnavailable("coverage"), tcCls, covSub, ICONS.shield)}
      ${kpiCard("Security risk", sec === "failed" ? "FAIL" : sec === "passed" ? "PASS" : kpiUnavailable("security"), secCls,
        sec === "failed" ? `${secReasonCount} deterministic check${secReasonCount === 1 ? "" : "s"} failed`
          : sec === "passed" ? "Deterministic security checks passed" : "No security scan was supplied", ICONS.lock)}
    </div>
    ${rationalePanel(report, summary, cov, decision)}
  </section>`;
}

/* ---- risk register: identified risks + regression priorities + open defects,
   one scannable table on desktop, stacked cards on mobile. No invented scores;
   every field is a restatement of AI findings or deterministic QA data. ---- */

function severityCell(level, cls) {
  const l = String(level || "n/a").toLowerCase();
  const icon = l === "critical" || l === "high" ? ICONS.alert : l === "medium" ? ICONS.target : ICONS.dot;
  return `<span class="sev ${cls}">${icon}<span>${esc(upper(level || "n/a"))}</span></span>`;
}

function riskRegister(report, ctx) {
  const risks = Array.isArray(report.identifiedRisks) ? report.identifiedRisks : [];
  const regress = Array.isArray(report.regressionPriorities) ? report.regressionPriorities : [];
  const defects = Array.isArray(ctx.defects) ? ctx.defects : [];
  const reasons = Array.isArray(report.reasons) ? report.reasons : [];
  const reasonText = reasons.join(" ");

  const rows = [
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

  const blocking = rows.filter((r) => r.flagged).length;

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

  return `<section class="card card--risksig">
    <div class="card__head">
      <span class="ico">${ICONS.gauge}</span>
      <h2>Risk signals &amp; open defects</h2>
      <span class="card__counts">
        <span>${rows.length} signal${rows.length === 1 ? "" : "s"}</span>
        <span class="card__counts-sep">·</span>
        <span class="${blocking ? "is-blocking" : ""}">${blocking} flagged by the gate</span>
      </span>
    </div>
    <div class="card__body card__body--flush">
      ${tableWrap(head, body)}
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

/* ---- status banner (semantic, generated from real gate data) ---- */

function statusBanner(report, summary, decision) {
  const reasons = Array.isArray(report.reasons) ? report.reasons : [];
  if (decision === "GO") {
    return `<div class="statusbar statusbar--ok" role="status">
      <span class="statusbar__icon">${ICONS.check}</span>
      <div class="statusbar__text">
        <b>Release cleared by the deterministic gate</b>
        <span>No blocking conditions were found in the submitted QA evidence.</span>
      </div>
    </div>`;
  }
  const conditional = decision === "CONDITIONAL";
  const unavailable = !["GO", "NO_GO", "CONDITIONAL"].includes(decision);
  const head = conditional ? "Release allowed with conditions"
    : unavailable ? "No release decision could be produced"
    : "Release blocked by the deterministic gate";
  const sub = reasons.length
    ? reasons.slice(0, 2).join(" ")
    : "The deterministic QA gate did not return a clean decision, so it failed safe.";
  return `<div class="statusbar ${conditional ? "statusbar--warn" : "statusbar--danger"}" role="alert">
    <span class="statusbar__icon">${conditional ? ICONS.alert : ICONS.x}</span>
    <div class="statusbar__text">
      <b>${esc(head)}</b>
      <span>${esc(sub)}</span>
    </div>
    ${report.firedRule ? `<span class="statusbar__rule mono">${esc(report.firedRule)}</span>` : ""}
  </div>`;
}

/* ---- release history (this system has no cross-release historical store) ---- */

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
    ? actions.map((a) => `<li>${ICONS.target}<span>${esc(a)}</span></li>`).join("")
    : `<li>${ICONS.check}<span>No follow-up actions were derived from the submitted evidence.</span></li>`;
  return `<section class="card card--actions">
    <div class="card__head"><span class="ico">${ICONS.target}</span><h2>Recommended next actions</h2></div>
    <div class="card__body">
      <ul class="bullets bullets--action bullets--lg">${items}</ul>
    </div>
  </section>`;
}

/* ---- release readiness (evidence + security checks + decision authority) ---- */

function readinessCard(report, summary, cov) {
  const reasons = Array.isArray(report.reasons) ? report.reasons : [];
  const gateBlock = reasons.length
    ? `<div class="readiness__sec">
         <span class="eyebrow">Gate findings (deterministic)</span>
         <ul class="bullets bullets--reason">${reasons.map((r) => `<li>${ICONS.scale}<span>${esc(r)}</span></li>`).join("")}</ul>
       </div>`
    : `<div class="readiness__sec"><p class="muted">The deterministic gate reported no blocking findings.</p></div>`;

  const secReasons = summary?.securityRisk === "failed" && Array.isArray(summary.securityReasons)
    ? summary.securityReasons : [];
  const secBlock = secReasons.length
    ? `<div class="readiness__sec">
         <span class="eyebrow">Security checks (deterministic QA rules)</span>
         <ul class="bullets bullets--reason">${secReasons.map((r) => `<li>${ICONS.shield}<span>${esc(r)}</span></li>`).join("")}</ul>
       </div>`
    : "";

  const covReasons = summary?.testCoverage === "insufficient" && Array.isArray(summary.coverageReasons)
    ? summary.coverageReasons : [];
  const covBlock = covReasons.length
    ? `<div class="readiness__sec">
         <span class="eyebrow">Coverage checks (deterministic QA rules)</span>
         <ul class="bullets bullets--reason">${covReasons.map((r) => `<li>${ICONS.shield}<span>${esc(r)}</span></li>`).join("")}</ul>
       </div>`
    : "";

  const miniCards = cov ? `<div class="mini-cards">
    <div class="mini-card"><div class="mini-card__n">${cov.totalTests}</div><div class="mini-card__t">Test cases supplied</div></div>
    <div class="mini-card"><div class="mini-card__n">${cov.passed}</div><div class="mini-card__t">Passing</div></div>
    <div class="mini-card${cov.failed ? " mini-card--flag" : ""}"><div class="mini-card__n">${cov.failed}</div><div class="mini-card__t">Failing</div></div>
    <div class="mini-card${cov.uncoveredCritical?.length ? " mini-card--flag" : ""}"><div class="mini-card__n">${cov.uncoveredCritical?.length ?? 0}</div><div class="mini-card__t">Uncovered critical criteria</div></div>
  </div>` : `<p class="muted">No coverage statistics were returned for this assessment.</p>`;

  return `<section class="card card--gate">
    <div class="card__head"><span class="ico">${ICONS.scale}</span><h2>Release readiness</h2><span class="lane lane--gate">Deterministic gate</span></div>
    <div class="card__body">
      <span class="eyebrow">Evidence summary</span>
      ${miniCards}
      ${gateBlock}
      ${covBlock}
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

/* ============================ dedicated PDF / print report ==================

   A separate, print-optimised light-theme management report — NOT the dashboard
   DOM restyled. It is hidden on screen (`.print-report{display:none}`) and is
   the ONLY thing shown when the media is `print` (see styles.css @media print).
   Every value is read from the same completed-assessment `result` the screen
   report uses, so the two can never disagree.
   ========================================================================== */

function prKpi(label, value, tone, sub) {
  return `<div class="pr-kpi pr-kpi--${tone}">
    <span class="pr-kpi__label">${esc(label)}</span>
    <span class="pr-kpi__value">${esc(value)}</span>
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
        <span class="pr-eyebrow">Deterministic release gate</span>
        <span class="pr-hero__value">${esc(decLabel)}</span>
        <span class="pr-hero__rule">${report.firedRule ? "Rule " + esc(report.firedRule) : "No rule identifier"}</span>
      </div>
      <div class="pr-hero__reason">
        <span class="pr-eyebrow">Decision reason</span>
        <p>${esc(reasons[0] || "The deterministic QA gate reported no blocking reasons for this release.")}</p>
      </div>
    </div>

    <div class="pr-kpis">
      ${prKpi("Change risk", cr ? upper(cr) : "Not calculated", crTone, cr ? "Inherent risk across affected areas" : "No adapter findings")}
      ${prKpi("Test coverage", tc ? upper(tc) : "Not calculated", tcTone, cov ? cov.coveragePercent + "% criteria with a passing test" : "No coverage data")}
      ${prKpi("Security risk", sec === "failed" ? "FAIL" : sec === "passed" ? "PASS" : "Scan not provided", secTone,
        sec === "failed" ? (summary.securityReasons?.length || 0) + " deterministic check(s) failed" : sec === "passed" ? "Deterministic checks passed" : "No security scan supplied")}
    </div>

    <h2 class="pr-h2">Top release blockers</h2>
    ${reasons.length
      ? `<ol class="pr-list">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ol>`
      : `<p class="pr-muted">The deterministic gate reported no blocking reasons.</p>`}

    <h2 class="pr-h2">Recommended next actions</h2>
    ${actions.length
      ? `<ol class="pr-list">${actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ol>`
      : `<p class="pr-muted">No follow-up actions were derived from the submitted evidence.</p>`}

    <h2 class="pr-h2">Change under assessment</h2>
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
        ${regRows.length ? regRows.map((r) => `<tr>
          <td class="pr-mono">${esc(r.id)}</td>
          <td>${esc(r.cat)}</td>
          <td>${prSeverity(r.sev)}</td>
          <td>${esc(r.desc || "—")}</td>
          <td>${esc(r.status || "—")}</td>
          <td>${esc(r.gate)}</td>
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
  const page3 = `
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

    <h3 class="pr-h3">Uncovered critical criteria</h3>
    ${uncovered.length
      ? `<p class="pr-para pr-mono">${uncovered.map(esc).join(", ")}</p>`
      : `<p class="pr-muted">None — every critical acceptance criterion has an active test.</p>`}

    <h3 class="pr-h3">Failed deterministic rules</h3>
    ${failedRules.length
      ? `<p class="pr-para pr-mono">${failedRules.map(esc).join(", ")}</p>`
      : `<p class="pr-muted">No deterministic rule was recorded as failed.</p>`}

    <h3 class="pr-h3">Security checks</h3>
    ${(summary?.securityReasons || []).length
      ? `<ul class="pr-list">${summary.securityReasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
      : `<p class="pr-muted">${sec === "passed" ? "Deterministic security checks passed." : "No security scan was supplied."}</p>`}

    <h3 class="pr-h3">Coverage checks</h3>
    ${(summary?.coverageReasons || []).length
      ? `<ul class="pr-list">${summary.coverageReasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
      : `<p class="pr-muted">No coverage rule was recorded as failed.</p>`}

    <h3 class="pr-h3">Missing test scenarios</h3>
    ${(report.missingScenarios || []).length
      ? `<ul class="pr-list">${report.missingScenarios.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`
      : `<p class="pr-muted">No missing scenarios were derived from the submitted evidence.</p>`}
  `;

  /* ---- page 4: technical trace (appendix) ---- */
  const prov = report.dataProvenance || result?.provenance || {};
  const trace = report.pipelineTrace || [];
  const page4 = `
    <h3 class="pr-h3">Pipeline stages</h3>
    <ol class="pr-list">${(meta.pipelineStages || []).map((s) => `<li>${esc(s)}</li>`).join("") || `<li class="pr-muted">Not recorded.</li>`}</ol>

    <h3 class="pr-h3">Gate evaluation order</h3>
    <p class="pr-para pr-mono">${(meta.evaluationOrder || []).map(esc).join(" → ") || "Not recorded."}</p>

    <h3 class="pr-h3">MCP data tools</h3>
    <p class="pr-para pr-mono">${(meta.mcpTools || []).map(esc).join(", ") || "Not recorded."}</p>

    <h3 class="pr-h3">Pipeline trace</h3>
    <table class="pr-table">
      <thead><tr><th>Step</th><th>Result</th><th>Detail</th></tr></thead>
      <tbody>${trace.length ? trace.map((t) => `<tr>
        <td class="pr-mono">${esc(t.step)}</td>
        <td>${t.ok === false ? "FAIL" : "OK"}</td>
        <td>${esc(formatTraceDetail(t.detail || "—"))}</td>
      </tr>`).join("") : `<tr><td colspan="3" class="pr-muted">No trace recorded.</td></tr>`}</tbody>
    </table>

    <h3 class="pr-h3">Data provenance</h3>
    <table class="pr-table pr-table--kv"><tbody>
      ${Object.keys(prov).length ? Object.entries(prov).map(([k, v]) =>
        `<tr><th>${esc(humanizeKey(k))}</th><td colspan="3">${esc(String(v))}</td></tr>`).join("")
        : `<tr><td class="pr-muted">No provenance recorded.</td></tr>`}
    </tbody></table>

    <h3 class="pr-h3">Decision authority</h3>
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
    <span class="pr-runhead__brand">AI QA Release Risk &amp; Test Strategy — Release Risk Report</span>
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
               <h1 class="pr-h1 pr-h1--sm">${esc(p.title)}</h1>
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
  return `<div class="proc"><div class="banner">
    <span class="ico">${ICONS.alert}</span>
    <div><b>The assessment could not be completed.</b> ${esc(message || "No release decision is shown.")}</div>
    <div class="actions">
      <button class="btn btn--ghost btn--sm" type="button" data-act="retry">Retry</button>
      <button class="btn btn--ghost btn--sm" type="button" data-act="new">New assessment</button>
    </div>
  </div></div>`;
}
