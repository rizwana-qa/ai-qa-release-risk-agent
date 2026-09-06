// View state machine: workspace -> processing -> report.
//
// No risk / coverage / security / decision logic lives here. The release
// decision is whatever `report.releaseDecision` the backend returns (produced by
// the deterministic QA gate); this file never computes or substitutes one, and
// never shows GO from a client-side fallback.

import * as C from "./components.js";
import { mountWorkspace, getPayload, setValidation, setBusy } from "./workspace.js";

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

const app = {
  phase: "workspace", // workspace | processing | report
  stages: [],
  result: null,
  failed: false,
  lastRun: null, // { kind:"custom", payload } | { kind:"demo" }
};

/* ------------------------------- phase paint ------------------------------ */

// Presentation only: mark each header workflow step as done / current / upcoming
// for the current phase, and drive the mobile compact "Step N of 4" indicator.
// Same phase -> step mapping as before. No navigation, no click behaviour.
const STEP_STATE = {
  workspace: { context: "current", evidence: "current", analyze: "upcoming", review: "upcoming" },
  processing: { context: "done", evidence: "done", analyze: "current", review: "upcoming" },
  report: { context: "done", evidence: "done", analyze: "done", review: "current" },
};
const STEP_ORDER = ["context", "evidence", "analyze", "review"];
const STEP_LABEL = { context: "Context", evidence: "Evidence", analyze: "Analyze", review: "Review" };

function paintSteps() {
  const map = STEP_STATE[app.phase] || STEP_STATE.workspace;
  steps.querySelectorAll("[data-step]").forEach((el) => {
    el.dataset.state = map[el.dataset.step] || "upcoming";
  });

  // mobile compact indicator: "STEP N OF 4: LABEL" + progress bar
  const curKey = STEP_ORDER.find((k) => map[k] === "current")
    || (app.phase === "report" ? "review" : "context");
  const curIdx = STEP_ORDER.indexOf(curKey) + 1;
  const label = steps.querySelector(".flow__compact-label");
  const fill = steps.querySelector(".flow__compact-fill");
  if (label) label.textContent = `Step ${curIdx} of 4: ${STEP_LABEL[curKey]}`;
  if (fill) fill.style.width = `${(curIdx / STEP_ORDER.length) * 100}%`;

  // "Relaunch to update" only makes sense once a report is showing, and only
  // for a run this session can actually re-submit.
  if (relaunchBtn) relaunchBtn.hidden = !(app.phase === "report" && app.lastRun);
}

function toWorkspace({ reset = false } = {}) {
  app.phase = "workspace";
  app.result = null;
  app.failed = false;
  view.innerHTML = '<div id="ws-root"></div>';
  mountWorkspace(document.getElementById("ws-root"), { onAnalyze: submitCustom, reset });
  paintSteps();
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

  app.lastRun = { kind: "demo" };
  const stageDefs = (meta.stages || []).map((s) => [s.key, s.label]);
  toProcessing(stageDefs.length ? stageDefs : CUSTOM_STAGES);

  const url = "/api/assess/stream?id=REQ-BEN-001";
  // A deployment with no SSE route (e.g. Vercel) signals this via
  // meta.streaming === false; fall back to the existing blocking call
  // instead of opening an EventSource that has nothing to connect to.
  if (typeof EventSource !== "function" || meta.streaming === false) {
    try {
      const assess = await fetchJson("/api/assess?id=REQ-BEN-001", { method: "POST" });
      for (const s of app.stages) s.status = "done";
      toReport(demoResult(assess, scenario));
    } catch (err) { toError(errText(err)); }
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
  if (act === "toggle-raw") {
    const pre = view.querySelector("[data-raw]");
    const btn = e.target.closest("[data-act]");
    if (pre) {
      const show = pre.hasAttribute("hidden");
      pre.toggleAttribute("hidden", !show);
      btn.textContent = show ? "Hide raw assessment JSON" : "Show raw assessment JSON";
    }
    return;
  }
  if (act === "print") { window.print(); return; }
  if (act === "new") toWorkspace({ reset: false });
  else if (act === "edit") toWorkspace({ reset: false });
  else if (act === "retry") retry();
});

function retry() {
  if (app.lastRun?.kind === "demo") { runDemo(); return; }
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
