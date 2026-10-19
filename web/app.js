// View state machine: workspace -> processing -> report.
//
// No risk / coverage / security / decision logic lives here. The release
// decision is whatever `report.releaseDecision` the backend returns (produced by
// the deterministic QA gate); this file never computes or substitutes one, and
// never shows GO from a client-side fallback.

import * as C from "./components.js";
import { qualityGatesView, qualityGatesError } from "./gates.js";
import { ICONS } from "./icons.js";
import { decisionLabel, decisionClass, esc } from "./format.js";
import { mountWorkspace, getPayload, setValidation, setBusy, getWorkflowState, loadScenario, showStage } from "./workspace.js";

const CUSTOM_STAGES = [
  ["prepare-context", "Preparing release context"],
  ["prepare-evidence", "Preparing QA evidence"],
  ["ai-analysis", "AI QA analysis"],
  ["validate", "Validating findings"],
  ["gate", "Evaluating deterministic release gate"],
  ["assemble", "Assembling release report"],
];

const view = document.getElementById("view");
const steps = document.getElementById("topbar-steps");
const compact = document.getElementById("wf-compact");
const headDecision = document.getElementById("hdr-decision");
const crumb = document.getElementById("hdr-crumb");
const menuBtn = document.getElementById("menu-btn");
const menuList = document.getElementById("menu-list");
const relaunchBtn = document.getElementById("relaunch-btn");
const gatesView = document.getElementById("gates-view");
const GATES_HASH = "#/quality-gates";

const app = {
  phase: "workspace", // workspace | processing | report
  stages: [],
  result: null,
  failed: false,
  lastRun: null, // { kind:"custom", payload } | { kind:"demo" }
  ws: { contextComplete: false, canAnalyze: false, demoLoaded: false, stage: "context" },
  rstage: "review", // which report screen is showing: review | decision
  tab: "risk", // visible Review tab
  stepsOpen: false, // mobile stage list
};

/* ------------------------------- step state -------------------------------- */
//
// Real, derived state — never decorative. Each of the five steps is exactly
// one of: locked | available | current | complete | failed, computed from the
// actual application phase plus (while on the workspace) the live form validity
// workspace.js already enforces (canAnalyze(), section completion). Nothing
// here invents a new validation rule; it only reflects the existing ones.

const STEP_ORDER = ["context", "evidence", "analyze", "review", "decision"];
const STEP_LABEL = { context: "Context", evidence: "Evidence", analyze: "Analyze", review: "Review", decision: "Decision" };
const STEP_DESC = {
  context: "Scope & metadata", evidence: "Tests & known defects", analyze: "AI risk analysis",
  review: "Findings & risk signals", decision: "Release decision",
};
const STATE_WORD = { complete: "Complete", current: "In progress", available: "Available", locked: "Locked", failed: "Needs attention" };

function computeStepStates() {
  if (app.phase === "processing") {
    return { context: "complete", evidence: "complete", analyze: app.failed ? "failed" : "current", review: "locked", decision: "locked" };
  }
  if (app.phase === "report") {
    // The assessment has finished and a decision exists — every step is done,
    // not "in progress". Nothing is still running once the report is on screen.
    return { context: "complete", evidence: "complete", analyze: "complete", review: "complete", decision: "complete" };
  }
  // workspace
  const ctxOk = app.ws.contextComplete;
  const onEvidence = app.ws.stage === "evidence";
  return {
    context: !onEvidence ? "current" : ctxOk ? "complete" : "available",
    evidence: onEvidence ? "current" : ctxOk ? "available" : "locked",
    analyze: app.ws.canAnalyze ? "available" : "locked",
    review: "locked",
    decision: "locked",
  };
}

/** The one stage that currently has focus. On the report every stage is
 * "complete", but the visible screen (Review or Decision) is still where the
 * user is — it gets the distinct active treatment on top of its completion. */
function activeStepKey(map) {
  if (app.phase === "report") return app.rstage;
  if (app.phase === "processing") return "analyze";
  return app.ws.stage === "evidence" ? "evidence" : STEP_ORDER.find((k) => map[k] === "current") || "context";
}

/** Navigation is inert while a run is in flight, for locked steps, and for
 * Analyze once a report exists — exactly the clicks the old sidebar ignored. */
function stepDisabled(key, state) {
  return state === "locked" || app.phase === "processing" || (app.phase === "report" && key === "analyze");
}

function paintSteps() {
  const map = computeStepStates();
  const activeKey = activeStepKey(map);

  steps.querySelectorAll("[data-step]").forEach((el) => {
    const key = el.dataset.step;
    const s = map[key] || "locked";
    el.dataset.state = s;
    el.dataset.active = String(key === activeKey);
    el.setAttribute("aria-current", key === activeKey ? "step" : "false");
    el.setAttribute("aria-disabled", stepDisabled(key, s) ? "true" : "false");
    const digits = el.querySelector(".wf-step__digits");
    if (digits) digits.innerHTML = s === "complete" ? ICONS.check : s === "failed" ? ICONS.alert : s === "locked" ? ICONS.lock : String(STEP_ORDER.indexOf(key) + 1).padStart(2, "0");
    const stateEl = el.querySelector(".wf-step__state");
    if (stateEl) stateEl.textContent = STATE_WORD[s];
  });

  // Mobile: "Step N of 5: Label" + segmented progress + an inline stage list.
  const curIdx = STEP_ORDER.indexOf(activeKey) + 1;
  if (crumb) crumb.textContent = `Stage ${curIdx} of ${STEP_ORDER.length} · ${STEP_LABEL[activeKey]}`;
  compact.innerHTML = `
    <div class="wfc__row">
      <div class="wfc__label">Step ${curIdx} of ${STEP_ORDER.length} <span>· ${STEP_LABEL[activeKey]}</span></div>
      <button class="wfc__btn" type="button" id="wfc-toggle" aria-expanded="${app.stepsOpen}" aria-controls="wfc-list">Stages ${ICONS.chevron}</button>
    </div>
    <div class="wfc__bar" aria-hidden="true">${STEP_ORDER.map((k, i) => `<i data-on="${map[k] === "complete" && k !== activeKey ? 1 : 0}" data-cur="${i + 1 === curIdx ? 1 : 0}"></i>`).join("")}</div>
    <div class="wfc__list" id="wfc-list" ${app.stepsOpen ? "" : "hidden"}>${STEP_ORDER.map((k, i) => {
      const s = map[k];
      return `<button type="button" data-step="${k}" data-state="${s}" data-active="${k === activeKey}" ${k === activeKey ? 'aria-current="step"' : ""} aria-disabled="${stepDisabled(k, s)}">
        <span class="wf-step__n">${s === "complete" ? ICONS.check : i + 1}</span>
        <span><b>${STEP_LABEL[k]}</b> <span class="muted">· ${STEP_DESC[k]}</span></span><em>${STATE_WORD[s]}</em></button>`;
    }).join("")}</div>`;

  // The decision, once one exists, stays visible in the header on every screen.
  const dec = app.phase === "report" ? app.result?.report : null;
  headDecision.innerHTML = dec
    ? `<span class="topbar__chip ${decisionClass(dec.releaseDecision)}" role="status">${esc(decisionLabel(dec.releaseDecision))}${dec.firedRule ? ` <small>${esc(dec.firedRule)}</small>` : ""}</span>`
    : "";

  // "Relaunch to update" only makes sense once a report is showing, and only
  // for a run this session can actually re-submit.
  if (relaunchBtn) relaunchBtn.hidden = !(app.phase === "report" && app.lastRun);
}

/** Stage navigation is real navigation, not decoration: unlocked steps go to
 * their screen; locked steps do nothing. Returning to Context/Evidence from a
 * report discards the on-screen report (inputs are kept), as it always has. */
function onStepClick(e) {
  const btn = e.target.closest("[data-step]");
  if (!btn || btn.getAttribute("aria-disabled") === "true") return;
  const step = btn.dataset.step;
  app.stepsOpen = false;

  if (app.phase === "report") {
    if (step === "context" || step === "evidence") { toWorkspace({ reset: false }); showStage(step); return; }
    if (step === "review" || step === "decision") showReportStage(step);
    return;
  }
  if (app.phase === "workspace") {
    if (step === "context" || step === "evidence") { showStage(step); return; }
    if (step === "analyze") {
      showStage("evidence");
      view.querySelector('[data-act="analyze"]')?.focus();
    }
  }
}
steps.addEventListener("click", onStepClick);
compact.addEventListener("click", (e) => {
  if (e.target.closest("#wfc-toggle")) { app.stepsOpen = !app.stepsOpen; paintSteps(); compact.querySelector("#wfc-toggle")?.focus(); return; }
  onStepClick(e);
});

function toWorkspace({ reset = false } = {}) {
  app.phase = "workspace";
  app.result = null;
  app.failed = false;
  view.innerHTML = '<div id="ws-root"></div>';
  mountWorkspace(document.getElementById("ws-root"), {
    onAnalyze: onWorkspaceAnalyze,
    onStateChange: (ws) => { app.ws = ws; paintSteps(); },
    reset,
  });
}

/** A demo/regression scenario loaded verbatim (never edited) analyzes through
 * the fixed-fixture path so its result matches the fixture's own dataset
 * exactly; anything else — including a demo scenario the user has since
 * edited — is a real, user-authored submission. */
function onWorkspaceAnalyze() {
  if (getWorkflowState().demoLoaded && app.lastRun?.kind === "demo") {
    runDemoAnalyze();
    return;
  }
  submitCustom();
}

function focusHeading() {
  window.scrollTo({ top: 0 });
  view.querySelector("#page-h")?.focus({ preventScroll: true });
}

function toProcessing(stageDefs) {
  app.phase = "processing";
  app.failed = false;
  app.stages = stageDefs.map(([key, label], i) => ({ index: i, key, label, status: "pending" }));
  renderProcessing();
  paintSteps();
  focusHeading();
}

function renderProcessing() {
  view.innerHTML = C.processingView(app.stages, { failed: app.failed });
}

function toReport(result) {
  app.phase = "report";
  app.result = result;
  app.rstage = "review";
  app.tab = "risk";
  renderReport();
  focusHeading();
}

function renderReport() {
  view.innerHTML = C.reportView(app.result, { stage: app.rstage, tab: app.tab });
  paintSteps();
}

function showReportStage(stage) {
  if (app.phase !== "report" || !app.result) return;
  app.rstage = stage;
  renderReport();
  focusHeading();
}

function toError(message) {
  app.phase = "processing";
  app.failed = true;
  view.innerHTML = C.errorView(message);
  paintSteps();
  focusHeading();
}

/* ------------------------------ custom run ------------------------------ */

function applyStage(ev) {
  const s = app.stages.find((x) => x.key === ev.key) || app.stages[ev.index];
  if (!s) return;
  s.status = ev.status;
  if (ev.detail) s.detail = ev.detail;
  renderProcessing();
}

async function submitCustom() {
  const payload = getPayload();
  setBusy(true);

  let prep;
  try {
    prep = await postJson("/api/assess/custom", payload);
  } catch (err) {
    setBusy(false);
    toError(`Could not reach the assessment API (${errText(err)}). Make sure the server is running: npm run demo`);
    return;
  }
  setBusy(false);

  if (prep.status === 422 || (prep.body && prep.body.ok === false && Array.isArray(prep.body.missing))) {
    setValidation({ missing: prep.body.missing || [], problems: prep.body.problems || [] });
    return;
  }
  if (prep.status === 400 || prep.status === 413) {
    setValidation({
      missing: [],
      problems: [prep.status === 413
        ? "The assessment is too large to submit. Reduce the amount of pasted text or the number of rows and try again."
        : (prep.body?.error || "The request body was rejected.")],
    });
    return;
  }
  if (prep.status !== 200 || !(prep.body?.runId || prep.body?.report)) {
    toError(prep.body?.error || `Unexpected response (${prep.status}).`);
    return;
  }

  app.lastRun = { kind: "custom", payload };
  toProcessing(CUSTOM_STAGES);

  // A deployment with no SSE route (e.g. Vercel) returns the full result
  // directly from this same request instead of a runId to stream — same
  // backend logic, just no separate stream round trip. Local/Render are
  // unaffected: their prepare response never carries `report`.
  if (prep.body.report) {
    for (const s of app.stages) s.status = "done";
    finishCustom(prep.body);
    return;
  }

  streamCustom(prep.body.runId);
}

function streamCustom(runId) {
  const url = `/api/assess/custom/stream?runId=${encodeURIComponent(runId)}`;

  if (typeof EventSource !== "function") {
    blockingCustom(app.lastRun.payload);
    return;
  }

  const es = new EventSource(url);
  let done = false;

  es.onmessage = (msg) => {
    let ev;
    try { ev = JSON.parse(msg.data); } catch { return; }

    if (ev.type === "stage") {
      applyStage(ev);
    } else if (ev.type === "result") {
      done = true;
      es.close();
      finishCustom(ev);
    } else if (ev.type === "needs-input") {
      done = true;
      es.close();
      view.innerHTML = C.needsInputView({ missing: ev.missing || [], problems: ev.problems || [] });
    } else if (ev.type === "error") {
      done = true;
      es.close();
      markRunningFailed();
      toError(ev.message || "The pipeline reported an error.");
    } else if (ev.type === "end") {
      es.close();
      if (!done && app.phase === "processing") {
        markRunningFailed();
        toError("The stream ended without a result.");
      }
    }
  };

  es.onerror = () => {
    es.close();
    if (!done) {
      markRunningFailed();
      toError("The connection to the assessment stream was lost. Retry to run it again.");
    }
  };
}

async function blockingCustom(payload) {
  try {
    const r = await postJson("/api/assess/custom?blocking=1", payload);
    if (r.status === 422) {
      setValidation({ missing: r.body.missing || [], problems: r.body.problems || [] });
      toWorkspace();
      return;
    }
    if (r.status !== 200 || !r.body?.ok) {
      toError(r.body?.error || `Unexpected response (${r.status}).`);
      return;
    }
    for (const s of app.stages) s.status = "done";
    finishCustom(r.body);
  } catch (err) {
    toError(errText(err));
  }
}

function markRunningFailed() {
  for (const s of app.stages) if (s.status === "running" || s.status === "pending") s.status = "failed";
}

function finishCustom(result) {
  // result === { ok?, report, summary, coverageStats, context, provenance, supportingDocuments, mode, meta }
  toReport(result);
}

/* ------------------------------- demo run ------------------------------ */

/**
 * Loads the real REQ-BEN-001 regression fixture into the SAME workspace form
 * manual entry uses, and stops there — same workflow as manual entry, per
 * Context -> Evidence -> (user clicks) Analyze. Nothing is auto-analyzed.
 */
async function runDemo() {
  closeMenu();
  let meta, scenario;
  try {
    [meta, scenario] = await Promise.all([
      fetchJson("/api/meta"),
      fetchJson("/api/scenario?id=REQ-BEN-001"),
    ]);
  } catch (err) {
    toError(`Could not load the regression fixture (${errText(err)}).`);
    return;
  }

  app.lastRun = { kind: "demo", meta, scenario };
  toWorkspace({ reset: false });
  loadScenario(buildContextFromScenario(scenario));
}

/** The real analyze step for a not-yet-edited demo/regression run, invoked
 * only from the user's own Analyze click (see onWorkspaceAnalyze). Uses the
 * meta/scenario already fetched by runDemo() — no re-fetch, same backend
 * calls (/api/assess or /api/assess/stream) as before this workflow fix. */
function runDemoAnalyze() {
  const { meta, scenario } = app.lastRun;
  const stageDefs = (meta.stages || []).map((s) => [s.key, s.label]);
  toProcessing(stageDefs.length ? stageDefs : CUSTOM_STAGES);

  const url = "/api/assess/stream?id=REQ-BEN-001";
  // A deployment with no SSE route (e.g. Vercel) signals this via
  // meta.streaming === false; fall back to the existing blocking call
  // instead of opening an EventSource that has nothing to connect to.
  if (typeof EventSource !== "function" || meta.streaming === false) {
    fetchJson("/api/assess?id=REQ-BEN-001", { method: "POST" })
      .then((assess) => {
        for (const s of app.stages) s.status = "done";
        toReport(demoResult(assess, scenario));
      })
      .catch((err) => toError(errText(err)));
    return;
  }

  const es = new EventSource(url);
  let done = false;
  es.onmessage = (msg) => {
    let ev;
    try { ev = JSON.parse(msg.data); } catch { return; }
    if (ev.type === "stage") applyStage(ev);
    else if (ev.type === "result") { done = true; es.close(); toReport(demoResult(ev, scenario)); }
    else if (ev.type === "error") { done = true; es.close(); markRunningFailed(); toError(ev.message || "The pipeline reported an error."); }
    else if (ev.type === "end") { es.close(); if (!done && app.phase === "processing") { markRunningFailed(); toError("The stream ended without a result."); } }
  };
  es.onerror = () => { es.close(); if (!done) { markRunningFailed(); toError("The connection to the assessment stream was lost."); } };
}

/** The scenario's own real data, shaped for the workspace form (same shape
 * manual entry produces) — used to populate Context/Evidence, not to compute
 * anything. */
function buildContextFromScenario(s) {
  const testCases = s.tests.map((t) => ({
    label: t.testId, title: t.title, area: t.area, testType: t.testType,
    status: t.status === "active" ? "passed" : "not-run",
    covers: t.covers || [],
  }));
  return {
    releaseName: "REQ-BEN-001 · regression fixture",
    releaseScope: s.requirement.description,
    userStory: s.requirement.title,
    criticality: s.requirement.criticality,
    acceptanceCriteria: s.acceptanceCriteria.map((a) => ({ area: a.area, critical: a.critical, text: a.text })),
    businessRules: [],
    testCases,
    defects: s.defects.map((d) => ({
      label: d.defectId, severity: d.severity, status: d.status,
      area: d.area, security: d.security, description: d.description,
      relatedAcs: d.relatedAcceptanceCriteria || [],
    })),
  };
}

/** Reshape the fixed-scenario response into the shape reportView() expects. */
function demoResult(assess, s) {
  const acById = new Map(s.acceptanceCriteria.map((a) => [a.id, a]));
  const testCases = s.tests.map((t) => ({
    id: t.testId, label: t.testId, title: t.title, area: t.area, testType: t.testType,
    status: t.status, statusRaw: t.status === "active" ? "passed" : "quarantined",
    covers: t.covers || [],
  }));
  const critAreas = new Set(s.riskRules?.criticalAreas || []);
  const byCriterion = s.coverageMap.map((c) => {
    const ac = acById.get(c.acceptanceCriterionId) || {};
    const coverage = c.covered ? "covered" : (c.mappedTests || []).length ? "partial" : "uncovered";
    return {
      id: c.acceptanceCriterionId, label: c.acceptanceCriterionId, area: c.area,
      critical: !!ac.critical, coverage,
      activeTests: c.activeTests || [], allTests: c.mappedTests || [],
    };
  });
  const covered = byCriterion.filter((c) => c.coverage === "covered").length;
  const active = testCases.filter((t) => t.statusRaw === "passed").length;
  const coverageStats = {
    totalTests: testCases.length, passed: active, failed: 0, blocked: 0,
    other: testCases.length - active,
    totalCriteria: s.acceptanceCriteria.length,
    coveredCriteria: covered,
    coveragePercent: s.acceptanceCriteria.length ? Math.round((covered / s.acceptanceCriteria.length) * 100) : 0,
    byCriterion,
    uncoveredCritical: byCriterion
      .filter((c) => (c.critical || critAreas.has(c.area)) && c.coverage !== "covered")
      .map((c) => c.id),
  };
  const context = {
    requirementId: s.requirement.requirementId,
    releaseName: "REQ-BEN-001 · regression fixture",
    releaseScope: s.requirement.description,
    userStory: s.requirement.title,
    criticality: s.requirement.criticality,
    affectedAreas: s.requirement.affectedAreas,
    acceptanceCriteria: s.acceptanceCriteria.map((a) => ({ id: a.id, area: a.area, critical: a.critical, text: a.text })),
    businessRules: [],
    testCases,
    defects: s.defects.map((d) => ({
      id: d.defectId, label: d.defectId, severity: d.severity, status: d.status,
      area: d.area, security: d.security, description: d.description,
      relatedAcs: d.relatedAcceptanceCriteria || [],
    })),
    supportingDocuments: [],
  };
  return {
    report: assess.report,
    summary: assess.summary,
    coverageStats,
    context,
    provenance: assess.report?.dataProvenance || {},
    supportingDocuments: [],
    mode: assess.mode === "live" ? "live" : "recorded",
    meta: {
      pipelineStages: (assess.meta?.stages || []).map((x) => x.label),
      evaluationOrder: assess.meta?.evaluationOrder || [],
      mcpTools: assess.meta?.mcpTools || [],
    },
  };
}

/* --------------------------- delegated actions ------------------------- */

view.addEventListener("click", (e) => {
  const head = e.target.closest(".acc__head");
  if (head) {
    const acc = head.closest(".acc");
    const open = acc.classList.toggle("open");
    head.setAttribute("aria-expanded", open ? "true" : "false");
    return;
  }
  const tab = e.target.closest("[data-tab]");
  if (tab) { selectTab(tab.dataset.tab, { focus: true }); return; }
  const nav = e.target.closest("[data-nav]")?.dataset.nav;
  if (nav) { showReportStage(nav); return; }
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  if (act === "print") { window.print(); return; }
  // "New assessment" keeps the entered data (as it always has) and opens on Context.
  if (act === "new") { toWorkspace({ reset: false }); showStage("context"); }
  else if (act === "edit") { toWorkspace({ reset: false }); showStage("evidence"); }
  else if (act === "retry") retry();
});

/** Switch the visible Review tab without re-rendering the report: every panel is
 * already in the DOM, so no request is made and nothing is recomputed. */
function selectTab(key, { focus = false } = {}) {
  app.tab = key;
  view.querySelectorAll("[data-tab]").forEach((t) => {
    const on = t.dataset.tab === key;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  });
  view.querySelectorAll(".tabpanel").forEach((p) => { p.hidden = p.id !== `panel-${key}`; });
}

view.addEventListener("keydown", (e) => {
  const tab = e.target.closest("[data-tab]");
  if (!tab || !["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const keys = [...view.querySelectorAll("[data-tab]")].map((t) => t.dataset.tab);
  const i = keys.indexOf(tab.dataset.tab);
  const next = e.key === "Home" ? 0 : e.key === "End" ? keys.length - 1
    : (i + (e.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length;
  selectTab(keys[next], { focus: true });
});

function retry() {
  if (app.lastRun?.kind === "demo") { toProcessing(CUSTOM_STAGES); runDemoAnalyze(); return; }
  if (app.lastRun?.kind === "custom") {
    toProcessing(CUSTOM_STAGES);
    blockingCustom(app.lastRun.payload);
    return;
  }
  toWorkspace();
}

/* ------------------------------- header menu -------------------------- */

function openMenu() { menuList.hidden = false; menuBtn.setAttribute("aria-expanded", "true"); }
function closeMenu() { menuList.hidden = true; menuBtn.setAttribute("aria-expanded", "false"); }

// Re-runs the same submission that produced the report on screen, via the
// existing retry() path used by the processing-failure banner. No new
// assessment logic: same payload, same pipeline, same deterministic gate.
relaunchBtn?.addEventListener("click", () => { closeMenu(); retry(); });

menuBtn.addEventListener("click", () => (menuList.hidden ? openMenu() : closeMenu()));
document.addEventListener("click", (e) => {
  if (!e.target.closest(".topbar__menu")) closeMenu();
});
menuList.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  closeMenu();
  if (act === "run-demo") runDemo();
  else if (act === "new") toWorkspace({ reset: true });
  else if (act === "load-example") {
    toWorkspace({ reset: false });
    // workspace exposes the example via its own "Load example" control; trigger it.
    document.querySelector('#ws-root [data-act="load-example"]')?.click();
  }
});

/* ----------------------- quality gates (read-only page) ------------------- */
//
// A reference page, not a workflow stage. It lives in its own container so the
// assessment underneath (form inputs, report) is left exactly as it was.

let gatesDoc = null;

async function showGates() {
  closeMenu();
  view.hidden = true;
  gatesView.hidden = false;
  document.body.dataset.page = "gates";
  document.getElementById("nav-gates")?.setAttribute("aria-current", "page");
  crumb.textContent = "Reference · Quality Gates";
  if (!gatesDoc) {
    gatesView.innerHTML = '<p class="muted" role="status">Loading quality gates…</p>';
    try { gatesDoc = await fetchJson("/api/quality-gates"); }
    catch (err) { gatesView.innerHTML = qualityGatesError(errText(err)); return; }
  }
  gatesView.innerHTML = qualityGatesView(gatesDoc);
  window.scrollTo({ top: 0 });
  gatesView.querySelector("#qg-h")?.focus({ preventScroll: true });
}

function hideGates() {
  if (gatesView.hidden) return;
  gatesView.hidden = true;
  view.hidden = false;
  delete document.body.dataset.page;
  document.getElementById("nav-gates")?.removeAttribute("aria-current");
  paintSteps();
}

function syncRoute() { if (location.hash === GATES_HASH) showGates(); else hideGates(); }
window.addEventListener("hashchange", syncRoute);

// Choosing anything in the workflow leaves the reference page first.
document.getElementById("app").addEventListener("click", (e) => {
  if (!gatesView.hidden && e.target.closest("[data-step], #menu-list [data-act]")) {
    history.replaceState(null, "", location.pathname + location.search);
    hideGates();
  }
}, true);

/* --------------------------------- fetch ----------------------------- */

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}
async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => null);
  return { status: res.status, body: parsed };
}
function errText(err) {
  return err && err.message ? err.message : String(err);
}

/* --------------------------------- boot ------------------------------ */

toWorkspace();
syncRoute();
