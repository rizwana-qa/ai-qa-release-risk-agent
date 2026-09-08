// View state machine: workspace -> processing -> report.
//
// No risk / coverage / security / decision logic lives here. The release
// decision is whatever `report.releaseDecision` the backend returns (produced by
// the deterministic QA gate); this file never computes or substitutes one, and
// never shows GO from a client-side fallback.

import * as C from "./components.js";
import { mountWorkspace, getPayload, setValidation, setBusy, getWorkflowState, loadScenario } from "./workspace.js";

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
const menuBtn = document.getElementById("menu-btn");
const menuList = document.getElementById("menu-list");
const relaunchBtn = document.getElementById("relaunch-btn");

/* ---------------------------- workflow drawer ---------------------------- */
//
// Below 1024px the sidebar is an off-canvas drawer: a hamburger opens it, the
// overlay or Escape closes it, focus is trapped while open and returned to the
// hamburger on close. Above 1024px the sidebar is permanent and this is inert.

const appEl = document.getElementById("app");
const sidebarEl = document.getElementById("sidebar");
const drawerBtn = document.getElementById("drawer-btn");
const drawerOverlay = document.getElementById("drawer-overlay");
const DRAWER_MQ = window.matchMedia("(max-width: 1024px)");

function drawerFocusables() {
  return [...sidebarEl.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.offsetParent !== null);
}

function openDrawer() {
  if (!DRAWER_MQ.matches) return;
  appEl.dataset.drawer = "open";
  drawerOverlay.hidden = false;
  drawerBtn.setAttribute("aria-expanded", "true");
  document.body.style.overflow = "hidden";
  (drawerFocusables()[0] || sidebarEl).focus();
  document.addEventListener("keydown", onDrawerKeydown, true);
}

function closeDrawer({ restoreFocus = true } = {}) {
  if (appEl.dataset.drawer !== "open") return;
  delete appEl.dataset.drawer;
  drawerOverlay.hidden = true;
  drawerBtn.setAttribute("aria-expanded", "false");
  document.body.style.overflow = "";
  document.removeEventListener("keydown", onDrawerKeydown, true);
  if (restoreFocus) drawerBtn.focus();
}

function onDrawerKeydown(e) {
  if (e.key === "Escape") { e.preventDefault(); closeDrawer(); return; }
  if (e.key !== "Tab") return;
  const items = drawerFocusables();
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

drawerBtn.addEventListener("click", () =>
  (appEl.dataset.drawer === "open" ? closeDrawer() : openDrawer()));
drawerOverlay.addEventListener("click", () => closeDrawer());
DRAWER_MQ.addEventListener("change", (e) => { if (!e.matches) closeDrawer({ restoreFocus: false }); });

const app = {
  phase: "workspace", // workspace | processing | report
  stages: [],
  result: null,
  failed: false,
  lastRun: null, // { kind:"custom", payload } | { kind:"demo" }
  ws: { contextComplete: false, canAnalyze: false, demoLoaded: false },
};

/* ------------------------------- step state -------------------------------- */
//
// Real, derived state — never decorative. Each of the five steps is exactly
// one of: locked | available | current | complete, computed from the actual
// application phase plus (while on the workspace) the live form validity
// workspace.js already enforces (canAnalyze(), section completion). Nothing
// here invents a new validation rule; it only reflects the existing ones.

const STEP_ORDER = ["context", "evidence", "analyze", "review", "decision"];
const STEP_LABEL = { context: "Context", evidence: "Evidence", analyze: "Analyze", review: "Review", decision: "Decision" };

function computeStepStates() {
  if (app.phase === "processing") {
    return { context: "complete", evidence: "complete", analyze: "current", review: "locked", decision: "locked" };
  }
  if (app.phase === "report") {
    // The assessment has finished and a decision exists — every step is done,
    // not "in progress". A stale "current" here was the exact bug: nothing is
    // still running once the report is on screen.
    return { context: "complete", evidence: "complete", analyze: "complete", review: "complete", decision: "complete" };
  }
  // workspace
  const ctxOk = app.ws.contextComplete;
  return {
    context: ctxOk ? "complete" : "current",
    evidence: ctxOk ? "available" : "locked",
    analyze: app.ws.canAnalyze ? "available" : "locked",
    review: "locked",
    decision: "locked",
  };
}

function paintSteps() {
  const map = computeStepStates();
  // The one stage that currently has focus. On the report every stage is
  // "complete", but "Decision" is still where the user is — it gets a distinct
  // active treatment on top of its completion check.
  const activeKey = app.phase === "report" ? "decision"
    : app.phase === "processing" ? "analyze"
    : (STEP_ORDER.find((k) => map[k] === "current") || "context");
  steps.querySelectorAll("[data-step]").forEach((el) => {
    const s = map[el.dataset.step] || "locked";
    el.dataset.state = s;
    el.dataset.active = String(el.dataset.step === activeKey);
    el.setAttribute("aria-current", el.dataset.step === activeKey ? "step" : "false");
    el.disabled = s === "locked";
    el.setAttribute("aria-disabled", s === "locked" ? "true" : "false");
    const stateEl = el.querySelector(".flow__state");
    if (stateEl) stateEl.textContent = s === "complete" ? "Complete" : s === "current" ? "In progress" : s === "available" ? "Available" : "Locked";
  });

  // mobile compact indicator: "STEP N OF 5: LABEL" + progress bar
  const curKey = STEP_ORDER.find((k) => map[k] === "current")
    || (app.phase === "report" ? "decision" : "context");
  const curIdx = STEP_ORDER.indexOf(curKey) + 1;
  const label = steps.querySelector(".flow__compact-label");
  const fill = steps.querySelector(".flow__compact-fill");
  if (label) label.textContent = `Step ${curIdx} of ${STEP_ORDER.length}: ${STEP_LABEL[curKey]}`;
  if (fill) fill.style.width = `${(curIdx / STEP_ORDER.length) * 100}%`;

  // "Relaunch to update" only makes sense once a report is showing, and only
  // for a run this session can actually re-submit.
  if (relaunchBtn) relaunchBtn.hidden = !(app.phase === "report" && app.lastRun);
}

/** Sidebar nav is real navigation, not decoration: unlocked steps scroll to
 * (or, from the report, go back to) their section; locked steps do nothing. */
steps.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-step]");
  if (!btn || btn.disabled) return;
  const step = btn.dataset.step;
  // A navigation choice dismisses the mobile drawer (no-op on desktop).
  closeDrawer({ restoreFocus: false });

  if (app.phase === "report") {
    if (step === "context" || step === "evidence") { toWorkspace({ reset: false }); return; }
    if (step === "decision") { view.querySelector(".exec-grid")?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    if (step === "review") { view.querySelector(".card--risksig, .exec-grid")?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    return;
  }
  if (app.phase === "workspace") {
    if (step === "context") document.getElementById("ws-context-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" });
    else if (step === "evidence") document.getElementById("ws-evidence-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" });
    else if (step === "analyze") view.querySelector('[data-act="analyze"]')?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
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

function toProcessing(stageDefs) {
  app.phase = "processing";
  app.failed = false;
  app.stages = stageDefs.map(([key, label], i) => ({ index: i, key, label, status: "pending" }));
  renderProcessing();
  paintSteps();
}

function renderProcessing() {
  view.innerHTML = C.processingView(app.stages, { failed: app.failed });
}

function toReport(result) {
  app.phase = "report";
  app.result = result;
  view.innerHTML = C.reportView(result);
  paintSteps();
  view.scrollIntoView({ behavior: "smooth", block: "start" });
}

function toError(message) {
  app.phase = "processing";
  app.failed = true;
  view.innerHTML = C.errorView(message);
  paintSteps();
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
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  if (act === "print") { window.print(); return; }
  if (act === "new") toWorkspace({ reset: false });
  else if (act === "edit") toWorkspace({ reset: false });
  else if (act === "retry") retry();
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
