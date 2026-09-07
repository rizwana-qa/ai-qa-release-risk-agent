// The QA Release Risk Assessment workspace form.
//
// Owns only the *input model*. It performs no risk / coverage / security /
// decision logic — the small "live evidence summary" it shows is a plain count of
// what the user has typed, clearly labelled as a preview; the authoritative
// coverage figures come back from the backend. All rendered values pass through
// the escaping helpers in format.js.

import { ICONS } from "./icons.js";
import { esc, attr, upper } from "./format.js";
import {
  readEvidenceFile, rowsToTestCases, rowsToDefects, TEMPLATES, downloadText,
  TEXT_EXT, REFERENCE_EXT,
} from "./upload.js";

const CRITICALITY = ["low", "medium", "high", "critical"];
// "regression" and "functional" are additional labels for the existing
// "integration" classification the deterministic gate already understands
// (api/inputNormalizer.ts toGateTestType() falls back to "integration" for
// any value that isn't unit- or e2e-like) — no engine change required.
const TEST_TYPES = ["unit", "integration", "e2e", "regression", "functional"];
const TEST_STATUS = ["passed", "failed", "blocked", "skipped", "not-run", "in-progress"];
const SEVERITIES = ["critical", "high", "medium", "low"];
const DEFECT_STATUS = ["open", "closed"];

const blankAc = () => ({ area: "", critical: false, text: "" });
const blankBr = () => ({ text: "" });
const blankTc = () => ({ label: "", title: "", area: "", testType: "integration", status: "not-run", covers: [] });
const blankDf = () => ({ label: "", severity: "medium", status: "open", area: "", security: false, description: "", relatedAcs: [] });

function freshState() {
  return {
    releaseName: "",
    releaseScope: "",
    userStory: "",
    criticality: "high",
    acceptanceCriteria: [blankAc()],
    businessRules: [],
    testCases: [],
    knownDefects: [],
    supportingDocuments: [],
    validation: null, // { missing:[], problems:[] }
    uploadError: "",
    busy: false,
    // True only for data loaded verbatim from a demo/regression scenario, not
    // yet touched by the user. The first edit clears it (see bind()), so an
    // edited demo submission is always treated as the user's own evidence,
    // never silently re-run against the fixture's canonical dataset.
    demoLoaded: false,
  };
}

let state = freshState();
let root = null;
let onAnalyze = () => {};
let onStateChange = () => {};

/* --------------------------------- example -------------------------------- */

function exampleState() {
  const s = freshState();
  s.releaseName = "Checkout 3.4: saved payment methods";
  s.releaseScope =
    "Allow a signed-in customer to save a card during checkout and reuse it on later orders. " +
    "Adds a new 'saved cards' area to the account page and a token-vault call at payment time.";
  s.userStory =
    "As a returning customer, I want to securely save and reuse a payment card so that I can check out faster on future orders.";
  s.criticality = "high";
  s.acceptanceCriteria = [
    { area: "payments", critical: true, text: "A saved card can be used to complete a new order without re-entering the full card number." },
    { area: "security", critical: true, text: "Full PAN is never stored; only a vault token and last four digits are persisted." },
    { area: "account", critical: false, text: "A customer can view and delete their saved cards from the account page." },
    { area: "checkout", critical: false, text: "If the vault call fails, checkout falls back to manual card entry with a clear message." },
  ];
  s.businessRules = [
    { text: "A customer may store at most five payment cards." },
    { text: "Saved cards expire from the wallet 30 days after the card's own expiry date." },
  ];
  s.testCases = [
    { label: "TC-101", title: "Reuse saved card completes order", area: "payments", testType: "e2e", status: "passed", covers: ["AC1"] },
    { label: "TC-102", title: "Vault stores token not PAN", area: "security", testType: "integration", status: "passed", covers: ["AC2"] },
    { label: "TC-103", title: "Delete saved card from account", area: "account", testType: "e2e", status: "passed", covers: ["AC3"] },
    { label: "TC-104", title: "Vault outage falls back to manual entry", area: "checkout", testType: "integration", status: "failed", covers: ["AC4"] },
    { label: "TC-105", title: "Sixth card is rejected", area: "payments", testType: "integration", status: "not-run", covers: [] },
  ];
  s.knownDefects = [
    { label: "DEF-77", severity: "high", status: "open", area: "checkout", security: false, description: "Fallback message not shown when the vault call times out (only on slow connections).", relatedAcs: ["AC4"] },
  ];
  return s;
}

/**
 * Populate the workspace from a real, already-fetched scenario's context
 * (same shape produced by app.js from /api/scenario) — the demo/regression
 * fixture path renders through this exact form, same as manual entry, rather
 * than bypassing it. Marked demoLoaded until the user edits anything.
 */
export function loadScenario(ctx) {
  const s = freshState();
  s.releaseName = ctx.releaseName || "";
  s.releaseScope = ctx.releaseScope || "";
  s.userStory = ctx.userStory || "";
  s.criticality = CRITICALITY.includes(ctx.criticality) ? ctx.criticality : "high";
  s.acceptanceCriteria = (ctx.acceptanceCriteria || []).map((a) => ({
    area: a.area || "", critical: !!a.critical, text: a.text || "",
  }));
  if (!s.acceptanceCriteria.length) s.acceptanceCriteria = [blankAc()];
  s.businessRules = (ctx.businessRules || []).map((b) => ({ text: b.text || "" }));
  s.testCases = (ctx.testCases || []).map((t) => ({
    label: t.label || "", title: t.title || "", area: t.area || "",
    testType: TEST_TYPES.includes(t.testType) ? t.testType : "integration",
    status: TEST_STATUS.includes(t.status) ? t.status : (t.statusRaw || "not-run"),
    covers: t.covers || [],
  }));
  s.knownDefects = (ctx.defects || []).map((d) => ({
    label: d.label || d.id || "", severity: SEVERITIES.includes(d.severity) ? d.severity : "medium",
    status: DEFECT_STATUS.includes(d.status) ? d.status : "open", area: d.area || "",
    security: !!d.security, description: d.description || "", relatedAcs: d.relatedAcs || [],
  }));
  s.demoLoaded = true;
  state = s;
  renderForm();
}

/** Real per-step workflow state for the sidebar (app.js), not decorative:
 *  derived from the SAME rules canAnalyze()/sectionState() already use. */
export function getWorkflowState() {
  return {
    contextComplete: sectionState("context").complete === true && sectionState("ac").complete === true,
    canAnalyze: canAnalyze(),
    demoLoaded: state.demoLoaded,
  };
}

/* ------------------------------- DOM syncing ------------------------------ */

const val = (el) => (el ? el.value : "");
const chk = (el) => (el ? el.checked : false);

function syncFromDom() {
  if (!root) return;
  const q = (sel, ctx = root) => ctx.querySelector(sel);
  const qa = (sel, ctx = root) => [...ctx.querySelectorAll(sel)];

  state.releaseName = val(q('[data-field="releaseName"]'));
  state.releaseScope = val(q('[data-field="releaseScope"]'));
  state.userStory = val(q('[data-field="userStory"]'));
  // criticality is a custom listbox (see criticalityControl()), not a native
  // input — its value lives directly in state.criticality, set by the
  // crit-pick click/keyboard handlers, so there is nothing to read from the DOM.

  state.acceptanceCriteria = qa('[data-group="ac"]').map((row) => ({
    area: val(q('[data-field="area"]', row)),
    critical: chk(q('[data-field="critical"]', row)),
    text: val(q('[data-field="text"]', row)),
  }));
  if (state.acceptanceCriteria.length === 0) state.acceptanceCriteria = [blankAc()];

  state.businessRules = qa('[data-group="br"]').map((row) => ({
    text: val(q('[data-field="text"]', row)),
  }));

  state.testCases = qa('[data-group="tc"]').map((row) => ({
    label: val(q('[data-field="label"]', row)),
    title: val(q('[data-field="title"]', row)),
    area: val(q('[data-field="area"]', row)),
    testType: val(q('[data-field="testType"]', row)) || "integration",
    status: val(q('[data-field="status"]', row)) || "not-run",
    covers: qa('[data-field="covers"]:checked', row).map((c) => c.value),
  }));

  state.knownDefects = qa('[data-group="df"]').map((row) => ({
    label: val(q('[data-field="label"]', row)),
    severity: val(q('[data-field="severity"]', row)) || "medium",
    status: val(q('[data-field="status"]', row)) || "open",
    area: val(q('[data-field="area"]', row)),
    security: chk(q('[data-field="security"]', row)),
    description: val(q('[data-field="description"]', row)),
    relatedAcs: qa('[data-field="relatedAcs"]:checked', row).map((c) => c.value),
  }));
}

/* ---------------------------- derived (preview) ------------------------- */

function acLabels() {
  return state.acceptanceCriteria
    .map((ac, i) => ({ id: `AC${i + 1}`, ac }))
    .filter((x) => x.ac.text.trim());
}

function livePreview() {
  const acs = acLabels();
  const tests = state.testCases.filter((t) => t.title.trim() || t.label.trim());
  const count = (st) => tests.filter((t) => t.status === st).length;
  const passingCovers = new Set();
  for (const t of tests) if (t.status === "passed") for (const c of t.covers) passingCovers.add(c);
  const covered = acs.filter((x) => passingCovers.has(x.id)).length;
  return {
    totalTests: tests.length,
    passed: count("passed"),
    failed: count("failed"),
    blocked: count("blocked"),
    criteria: acs.length,
    covered,
    uncovered: Math.max(0, acs.length - covered),
  };
}

function canAnalyze() {
  return Boolean(state.releaseScope.trim() && state.userStory.trim() && acLabels().length >= 1);
}

/* Per-section completion cue. Derived only from the SAME state canAnalyze() uses;
   no new validation rules. `complete` is a tri-state: true / false / null(optional). */
function sectionState(kind) {
  const acN = acLabels().length;
  const count = (arr, pred) => arr.filter(pred).length;
  switch (kind) {
    case "context": {
      const n = (state.releaseScope.trim() ? 1 : 0) + (state.userStory.trim() ? 1 : 0);
      return { complete: n === 2, text: n === 2 ? "Complete" : `${n} of 2 required` };
    }
    case "ac":
      return { complete: acN >= 1, text: acN >= 1 ? `${acN} added` : "1 required" };
    case "br": {
      const n = count(state.businessRules, (b) => b.text.trim());
      return { complete: null, text: n ? `${n} added` : "Optional" };
    }
    case "tests": {
      const n = count(state.testCases, (t) => t.title.trim() || t.label.trim());
      return { complete: null, text: n ? `${n} added` : "Optional" };
    }
    case "defects": {
      const n = count(state.knownDefects, (d) => d.description.trim() || d.label.trim());
      return { complete: null, text: n ? `${n} added` : "Optional" };
    }
    case "docs": {
      const n = state.supportingDocuments.length;
      return { complete: null, text: n ? `${n} attached` : "Optional" };
    }
    default:
      return { complete: null, text: "" };
  }
}

function sectionBadge(kind) {
  const s = sectionState(kind);
  const dc = s.complete === true ? ' data-complete="true"' : s.complete === false ? ' data-complete="false"' : "";
  return `<span class="card-status" data-status-for="${kind}"${dc}>${s.complete === true ? ICONS.check : ""}<span>${esc(s.text)}</span></span>`;
}

function refreshSectionBadges() {
  if (!root) return;
  root.querySelectorAll("[data-status-for]").forEach((el) => {
    const s = sectionState(el.dataset.statusFor);
    el.innerHTML = (s.complete === true ? ICONS.check : "") + `<span>${esc(s.text)}</span>`;
    if (s.complete === true) el.dataset.complete = "true";
    else if (s.complete === false) el.dataset.complete = "false";
    else el.removeAttribute("data-complete");
  });
}


/* -------------------------------- payload ------------------------------- */

export function getPayload() {
  syncFromDom();
  const remap = new Map();
  let n = 0;
  state.acceptanceCriteria.forEach((ac, i) => {
    if (ac.text.trim()) { n += 1; remap.set(`AC${i + 1}`, `AC${n}`); }
  });
  const remapCovers = (list) => [...new Set((list || []).map((id) => remap.get(id)).filter(Boolean))];

  return {
    releaseName: state.releaseName.trim(),
    releaseScope: state.releaseScope.trim(),
    userStory: state.userStory.trim(),
    criticality: state.criticality,
    acceptanceCriteria: state.acceptanceCriteria
      .filter((ac) => ac.text.trim())
      .map((ac) => ({ area: ac.area.trim(), critical: !!ac.critical, text: ac.text.trim() })),
    businessRules: state.businessRules
      .filter((b) => b.text.trim())
      .map((b) => ({ text: b.text.trim() })),
    testCases: state.testCases
      .filter((t) => t.title.trim() || t.label.trim())
      .map((t) => ({
        label: t.label.trim(),
        title: t.title.trim(),
        area: t.area.trim(),
        testType: t.testType,
        status: t.status,
        covers: remapCovers(t.covers),
      })),
    knownDefects: state.knownDefects
      .filter((d) => d.description.trim() || d.label.trim())
      .map((d) => ({
        label: d.label.trim(),
        severity: d.severity,
        status: d.status,
        area: d.area.trim(),
        security: !!d.security,
        description: d.description.trim(),
        relatedAcs: remapCovers(d.relatedAcs),
      })),
    supportingDocuments: state.supportingDocuments.map((d) => ({
      name: d.name, size: d.size, type: d.type,
    })),
  };
}

export function setValidation(v) {
  state.validation = v || null;
  renderForm();
  root?.querySelector(".validation")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function setBusy(b) {
  state.busy = !!b;
  const btn = root?.querySelector('[data-act="analyze"]');
  if (btn) btn.disabled = b || !canAnalyze();
}

/* -------------------------------- markup -------------------------------- */

const opt = (list, cur, labelFn = upper) =>
  list.map((v) => `<option value="${attr(v)}"${v === cur ? " selected" : ""}>${esc(labelFn(v))}</option>`).join("");

const humanStatus = (s) => ({ "not-run": "Not run", "in-progress": "In progress" }[s] || upper(s));

/* Custom-rendered listbox for Criticality, replacing a native <select>. A
   native select's solid-fill options can't be styled once the browser's own
   open-list hover/selection highlight takes over (a platform limitation, not
   a CSS bug) — this gives every option a fixed, always-correct solid color. */
function criticalityControl(rawCur) {
  const cur = CRITICALITY.includes(rawCur) ? rawCur : "high";
  // The current value is already shown on the trigger itself, so the open
  // list only offers the other three — no repeated/duplicate entry.
  const options = CRITICALITY.filter((v) => v !== cur).map((v) => `<li
      role="option" class="crit-opt crit-opt--${v}"
      data-act="crit-pick" data-value="${attr(v)}" tabindex="-1"
    ><span>${esc(upper(v))}</span></li>`).join("");
  return `<div class="crit-select" data-crit-select>
    <button type="button" id="f-crit" class="crit-select__trigger select--criticality"
      data-act="crit-toggle" aria-haspopup="listbox" aria-expanded="false">
      <span>${esc(upper(cur))}</span>${ICONS.chevron}
    </button>
    <ul class="crit-select__list" role="listbox" aria-label="Criticality" hidden>${options}</ul>
  </div>`;
}

function coversPicker(field, selected) {
  const acs = acLabels();
  if (!acs.length) return `<span class="field__hint">Add acceptance criteria to link coverage.</span>`;
  const set = new Set(selected || []);
  return `<div class="covers">${acs.map((x) =>
    `<label class="${set.has(x.id) ? "on" : ""}">
      <input type="checkbox" data-field="${field}" value="${attr(x.id)}"${set.has(x.id) ? " checked" : ""} />
      ${esc(x.id)}
    </label>`).join("")}</div>`;
}

function acRow(ac, i, total) {
  return `<div class="row row--ac" data-group="ac" data-index="${i}">
    <div class="row__id">AC${i + 1}</div>
    <div class="row__main">
      <textarea class="textarea" data-field="text" rows="2"
        placeholder="Describe the acceptance criterion…">${esc(ac.text)}</textarea>
      <div class="row__meta">
        <input class="input input--sm" data-field="area" value="${attr(ac.area)}" placeholder="Area (e.g. payments)" />
        <label class="checkbox"><input type="checkbox" data-field="critical"${ac.critical ? " checked" : ""} /> Critical</label>
      </div>
    </div>
    <div class="row__tools">
      <button class="iconbtn" type="button" data-act="ac-up" data-index="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move up">${ICONS.up}</button>
      <button class="iconbtn" type="button" data-act="ac-down" data-index="${i}" ${i === total - 1 ? "disabled" : ""} aria-label="Move down">${ICONS.down}</button>
      <button class="iconbtn iconbtn--danger" type="button" data-act="ac-del" data-index="${i}" aria-label="Delete">${ICONS.trash}</button>
    </div>
  </div>`;
}

function brRow(br, i) {
  return `<div class="row row--pair" data-group="br" data-index="${i}">
    <input class="input" data-field="text" value="${attr(br.text)}" placeholder="Business rule (context only, does not change the release gate)" />
    <button class="iconbtn iconbtn--danger" type="button" data-act="br-del" data-index="${i}" aria-label="Delete">${ICONS.trash}</button>
  </div>`;
}

function tcRow(t, i) {
  return `<div class="row row--pair" data-group="tc" data-index="${i}">
    <div class="row__main">
      <div class="row__meta">
        <input class="input input--sm" data-field="label" value="${attr(t.label)}" placeholder="Test ID" />
        <input class="input input--grow" data-field="title" value="${attr(t.title)}" placeholder="Test title" />
      </div>
      <div class="row__meta">
        <input class="input input--sm" data-field="area" value="${attr(t.area)}" placeholder="Area" />
        <select class="select" data-field="testType">${opt(TEST_TYPES, t.testType)}</select>
        <select class="select" data-field="status">${opt(TEST_STATUS, t.status, humanStatus)}</select>
      </div>
      <div class="row__meta"><span class="field__hint">Covers:</span>${coversPicker("covers", t.covers)}</div>
    </div>
    <div class="row__tools">
      <button class="iconbtn iconbtn--danger" type="button" data-act="tc-del" data-index="${i}" aria-label="Delete test">${ICONS.trash}</button>
    </div>
  </div>`;
}

function dfRow(d, i) {
  const sev = SEVERITIES.includes(d.severity) ? d.severity : "medium";
  const st = DEFECT_STATUS.includes(d.status) ? d.status : "open";
  return `<div class="row row--pair row--defect" data-group="df" data-index="${i}" data-severity="${attr(sev)}" data-status="${attr(st)}">
    <div class="row__main">
      <div class="row__meta">
        <input class="input input--sm" data-field="label" value="${attr(d.label)}" placeholder="Defect ID" />
        <span class="sev-dot" data-sev="${attr(sev)}" aria-hidden="true"></span>
        <select class="select select--severity" data-field="severity" aria-label="Severity">${opt(SEVERITIES, d.severity)}</select>
        <select class="select select--status" data-field="status" aria-label="Status">${opt(DEFECT_STATUS, d.status)}</select>
        <input class="input input--sm" data-field="area" value="${attr(d.area)}" placeholder="Area" />
        <label class="checkbox"><input type="checkbox" data-field="security"${d.security ? " checked" : ""} /> Security issue</label>
      </div>
      <textarea class="textarea" data-field="description" rows="2" placeholder="Defect description">${esc(d.description)}</textarea>
      <div class="row__meta"><span class="field__hint">Related AC:</span>${coversPicker("relatedAcs", d.relatedAcs)}</div>
    </div>
    <div class="row__tools">
      <button class="iconbtn iconbtn--danger" type="button" data-act="df-del" data-index="${i}" aria-label="Delete defect">${ICONS.trash}</button>
    </div>
  </div>`;
}

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
  return (b / 1024 / 1024).toFixed(1) + " MB";
}

function docChips() {
  if (!state.supportingDocuments.length) return "";
  return `<div class="doc-chips">${state.supportingDocuments.map((d, i) => `
    <span class="doc-chip">
      <span class="doc-chip__ico">${ICONS.file}</span>
      <span class="doc-chip__name">${esc(d.name)}</span>
      <span class="doc-chip__size">${esc(fmtBytes(d.size))}</span>
      <span class="ref">${esc(d.note ? "note" : REFERENCE_EXT.includes(d.type) ? "reference only" : d.type)}</span>
      <button class="iconbtn" type="button" data-act="doc-del" data-index="${i}" aria-label="Remove ${attr(d.name)}">${ICONS.x}</button>
    </span>`).join("")}</div>`;
}

function validationBlock() {
  const v = state.validation;
  if (!v || (!(v.missing || []).length && !(v.problems || []).length)) return "";
  const items = [...(v.missing || []).map((m) => `Required: ${m}`), ...(v.problems || [])];
  return `<div class="validation" role="alert">
    <strong>${ICONS.alert} This assessment can't run yet</strong>
    <ul>${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
  </div>`;
}

function previewBlock() {
  const p = livePreview();
  const tile = (n, t, flag = false) =>
    `<div class="stat${flag ? " stat--flag" : ""}"><div class="stat__n">${n}</div><div class="stat__t">${t}</div></div>`;
  return `<div class="divider"></div>
  <span class="eyebrow">Live evidence summary: preview of what you've entered</span>
  <div class="stats">
    ${tile(p.totalTests, "Test cases")}
    ${tile(p.passed, "Passing")}
    ${tile(p.failed, "Failing", p.failed > 0)}
    ${tile(p.blocked, "Blocked", p.blocked > 0)}
    ${tile(p.covered + " / " + p.criteria, "Criteria with a passing test")}
    ${tile(p.uncovered, "Uncovered criteria", p.uncovered > 0)}
  </div>
  <p class="field__hint" style="margin-top:10px">Coverage percentages, risk levels and the release decision are computed by the backend QA rules, not here.</p>`;
}

/** Real, explicit "what's here / what's missing" for the Evidence step — never
 * hides an absence, never invents a count. Shown once Context is valid. */
function evidenceSummaryBlock() {
  if (!sectionState("context").complete) return "";
  const p = livePreview();
  const docsN = state.supportingDocuments.length;
  const executed = state.testCases.filter((t) => t.status !== "not-run" && (t.title.trim() || t.label.trim())).length;
  const tile = (n, label, warn) => `<div class="stat${warn ? " stat--flag" : ""}"><div class="stat__n">${n}</div><div class="stat__t">${esc(label)}</div></div>`;
  const noEvidence = p.totalTests === 0;
  return `<div class="card card--evidence-status">
    <div class="card__head"><span class="ico">${ICONS.clipboard}</span><h2>Evidence provided so far</h2></div>
    <div class="card__body">
      <div class="evstats">
        ${tile(p.totalTests, "Test cases provided", p.totalTests === 0)}
        ${tile(executed, "Execution results provided", executed === 0)}
        ${tile(state.knownDefects.filter((d) => d.description.trim() || d.label.trim()).length, "Defects provided")}
        ${tile(docsN, "Supporting documents provided")}
      </div>
      ${noEvidence
        ? `<div class="banner banner--warn mt-3"><span class="ico">${ICONS.alert}</span>
           <div><b>No test execution evidence has been provided.</b> This is not evidence of low risk. The assessment
           will state that verification evidence is missing rather than assume the release is safe.</div></div>`
        : `<p class="field__hint mt-3">Coverage percentages and the release decision are computed by the backend QA rules from exactly what's listed above.</p>`}
    </div>
  </div>`;
}

function continueToEvidenceBlock() {
  const ready = sectionState("context").complete;
  return `<div class="ws__continue" data-continue-block>
    <button class="btn btn--ghost" type="button" data-act="continue-evidence" ${ready ? "" : "disabled"}>Continue to Evidence ${ICONS.chevron}</button>
    <p class="field__hint" data-continue-hint ${ready ? "hidden" : ""}>${ICONS.info} Complete release scope, user story, and at least one acceptance criterion to continue to Evidence.</p>
  </div>`;
}

function refreshContinueBlock() {
  const wrap = root?.querySelector("[data-continue-block]");
  if (!wrap) return;
  const ready = sectionState("context").complete;
  const btn = wrap.querySelector('[data-act="continue-evidence"]');
  const hint = wrap.querySelector("[data-continue-hint]");
  if (btn) btn.disabled = !ready;
  if (hint) hint.hidden = ready;
  wrap.classList.toggle("ws__continue--locked", !ready);
}

function formHtml() {
  const acs = state.acceptanceCriteria;
  return `
  <div class="ws">
    <div class="ws__intro">
      <span class="eyebrow">Release Risk Assessment Workspace</span>
      <h1>QA Release Risk Assessment</h1>
      <p>Provide the release context and your QA evidence. The agent analyses what you supply and a deterministic QA gate produces the release decision. It does not run your application, browse URLs, or execute tests.</p>
      <div class="ws__flow"><span>Provide context</span><span>Add QA evidence</span><span>Analyze</span><span>Review release risk</span></div>
    </div>

    ${validationBlock()}

    <div id="ws-context-anchor"></div>
    <section class="card">
      <div class="card__head"><span class="step-badge">01</span><h2>Release context</h2>${sectionBadge("context")}</div>
      <div class="card__body">
        <div class="grid-2">
          <div class="field">
            <label class="field__label" for="f-name">Release / sprint name <span class="opt">optional</span></label>
            <input class="input" id="f-name" data-field="releaseName" value="${attr(state.releaseName)}" placeholder="e.g. Checkout 3.4" />
          </div>
          <div class="field" data-criticality="${attr(CRITICALITY.includes(state.criticality) ? state.criticality : "high")}">
            <label class="field__label" for="f-crit">Criticality</label>
            ${criticalityControl(state.criticality)}
          </div>
        </div>
        <div class="field">
          <label class="field__label" for="f-scope">Release scope / change purpose <span class="req">*</span></label>
          <textarea class="textarea" id="f-scope" data-field="releaseScope" rows="3" placeholder="What is changing in this release and why?">${esc(state.releaseScope)}</textarea>
        </div>
        <div class="field">
          <label class="field__label" for="f-story">User story / requirement <span class="req">*</span></label>
          <textarea class="textarea" id="f-story" data-field="userStory" rows="3" placeholder="As a … I want … so that …">${esc(state.userStory)}</textarea>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card__head"><span class="ico">${ICONS.list}</span><h2>Acceptance criteria</h2>${sectionBadge("ac")}</div>
      <div class="card__body">
        <div class="rows">${acs.map((ac, i) => acRow(ac, i, acs.length)).join("")}</div>
        <button class="addrow" type="button" data-act="ac-add">${ICONS.plus} Add acceptance criteria</button>
      </div>
    </section>

    <section class="card">
      <div class="card__head"><span class="ico">${ICONS.book}</span><h2>Business rules</h2>${sectionBadge("br")}</div>
      <div class="card__body">
        ${state.businessRules.length ? `<div class="rows">${state.businessRules.map(brRow).join("")}</div>` : `<p class="field__hint">No business rules added. These are recorded as context and never modify the release gate.</p>`}
        <button class="addrow" type="button" data-act="br-add">${ICONS.plus} Add business rule</button>
      </div>
    </section>

    ${continueToEvidenceBlock()}

    <div id="ws-evidence-anchor"></div>
    <p class="ws__stepback"><button class="linkbtn" type="button" data-act="back-to-context">← Back to Context</button></p>
    ${evidenceSummaryBlock()}

    <section class="card">
      <div class="card__head"><span class="step-badge">02</span><h2>QA evidence · existing test cases</h2>${sectionBadge("tests")}</div>
      <div class="card__body">
        ${state.testCases.length ? `<div class="rows">${state.testCases.map(tcRow).join("")}</div>` : `<p class="field__hint">No test cases added. If you leave this empty the report will state that evidence is insufficient. It will not invent any tests.</p>`}
        <button class="addrow" type="button" data-act="tc-add">${ICONS.plus} Add test case</button>
        ${previewBlock()}
      </div>
    </section>

    <section class="card">
      <div class="card__head"><span class="ico">${ICONS.bug}</span><h2>Known defects</h2>${sectionBadge("defects")}</div>
      <div class="card__body">
        ${state.knownDefects.length ? `<div class="rows">${state.knownDefects.map(dfRow).join("")}</div>` : `<p class="field__hint">No known defects added.</p>`}
        <button class="addrow" type="button" data-act="df-add">${ICONS.plus} Add defect</button>
      </div>
    </section>

    <section class="card">
      <div class="card__head"><span class="ico">${ICONS.upload}</span><h2>Supporting documents</h2>${sectionBadge("docs")}</div>
      <div class="card__body">
        <div class="dropzone" data-drop>
          <span class="dropzone__icon">${ICONS.upload}</span>
          <p class="dropzone__title"><strong>Drop files here</strong> or <button class="linkbtn" type="button" data-act="pick-file">choose files</button></p>
          <p class="field__hint">${TEXT_EXT.join(", ")} are parsed into rows or notes. ${REFERENCE_EXT.join(", ")} are attached as references only (no document parsing). Executable and script files are rejected.</p>
          <input type="file" data-file-input multiple accept=".json,.csv,.txt,.pdf,.docx,.xlsx" hidden />
        </div>
        ${state.uploadError ? `<p class="validation" style="margin-top:12px">${esc(state.uploadError)}</p>` : ""}
        ${docChips()}
        <p class="field__hint" style="margin-top:12px">Templates:
          <button class="linkbtn" type="button" data-act="tpl-tc">test cases CSV</button> ·
          <button class="linkbtn" type="button" data-act="tpl-df">defects CSV</button>
        </p>
      </div>
    </section>

    <div class="ws__cta">
      <p class="ws__stepback"><button class="linkbtn" type="button" data-act="back-to-evidence">← Back to Evidence</button></p>
      <button class="btn btn--primary btn--lg" type="button" data-act="analyze" ${canAnalyze() && !state.busy ? "" : "disabled"}>
        ${state.busy ? ICONS.spinner : ICONS.play} Analyze Release Risk
      </button>
      <p>${canAnalyze()
        ? "Ready. The pipeline will normalise your input, run the QA analysis, and evaluate the deterministic release gate."
        : "Add a release scope, a user story, and at least one acceptance criterion to enable analysis."}</p>
      <p class="ws__cta-trust">${ICONS.shield} Runs locally against your submitted evidence only. No application is executed and no external service is called.</p>
      <p class="ws__cta-links"><button class="linkbtn" type="button" data-act="load-example">Load example</button> · <button class="linkbtn" type="button" data-act="clear">Clear all</button></p>
    </div>
  </div>`;
}

/* ------------------------------- rendering ------------------------------ */

function renderForm() {
  if (!root) return;
  const active = document.activeElement;
  const key = active && root.contains(active)
    ? { group: active.closest("[data-group]")?.dataset.index, field: active.dataset.field, top: active.dataset.field && !active.closest("[data-group]") }
    : null;
  const caret = active && "selectionStart" in active ? active.selectionStart : null;

  root.innerHTML = formHtml();
  updateDerived();

  if (key && key.field) {
    let sel = null;
    if (key.top) sel = root.querySelector(`[data-field="${key.field}"]`);
    else if (key.group != null) sel = root.querySelector(`[data-group][data-index="${key.group}"] [data-field="${key.field}"]`);
    if (sel) {
      sel.focus();
      if (caret != null && "setSelectionRange" in sel) { try { sel.setSelectionRange(caret, caret); } catch { /* noop */ } }
    }
  }
}

let lastContextComplete = null;

function updateDerived() {
  const contextComplete = sectionState("context").complete;
  // The "Continue to Evidence" button and the Evidence-provided-so-far panel
  // only exist in the DOM once Context becomes valid — a full re-render is
  // needed exactly when that boolean flips (not on every keystroke).
  if (lastContextComplete !== null && contextComplete !== lastContextComplete) {
    lastContextComplete = contextComplete;
    renderForm();
    return;
  }
  lastContextComplete = contextComplete;

  const btn = root?.querySelector('[data-act="analyze"]');
  if (btn) btn.disabled = state.busy || !canAnalyze();
  refreshSectionBadges();
  refreshContinueBlock();
  onStateChange(getWorkflowState());
}

/* ----------------------------- event wiring --------------------------- */

function move(list, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

async function handleFiles(fileList) {
  state.uploadError = "";
  const files = [...fileList].slice(0, 20);
  for (const file of files) {
    const r = await readEvidenceFile(file);
    if (!r.ok) { state.uploadError = r.error; continue; }
    if (r.kind === "rows") {
      const looksDefects = /defect|bug/i.test(r.name) || r.rows.some((row) => Object.keys(row).some((k) => /severity/i.test(k)));
      if (looksDefects) state.knownDefects.push(...rowsToDefects(r.rows));
      else state.testCases.push(...rowsToTestCases(r.rows));
      state.supportingDocuments.push({ name: r.name, size: r.size, type: r.type });
    } else if (r.kind === "note") {
      state.supportingDocuments.push({ name: r.name, size: r.size, type: r.type, note: r.text.slice(0, 400) });
    } else {
      state.supportingDocuments.push({ name: r.name, size: r.size, type: r.type });
    }
  }
  renderForm();
}

function closeCritDropdown() {
  const list = root?.querySelector(".crit-select__list");
  if (!list || list.hidden) return;
  list.hidden = true;
  root.querySelector(".crit-select__trigger")?.setAttribute("aria-expanded", "false");
}

function onClick(e) {
  if (!e.target.closest(".crit-select")) closeCritDropdown();

  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  const idx = Number(t.dataset.index);
  syncFromDom();

  switch (act) {
    case "crit-toggle": {
      const list = t.closest(".crit-select").querySelector(".crit-select__list");
      const willOpen = list.hidden;
      list.hidden = !willOpen;
      t.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) list.querySelector(".crit-opt")?.focus();
      return;
    }
    case "crit-pick":
      state.criticality = t.dataset.value;
      break;
    case "ac-add": state.acceptanceCriteria.push(blankAc()); break;
    case "ac-del": state.acceptanceCriteria.splice(idx, 1); if (!state.acceptanceCriteria.length) state.acceptanceCriteria.push(blankAc()); break;
    case "ac-up": move(state.acceptanceCriteria, idx, -1); break;
    case "ac-down": move(state.acceptanceCriteria, idx, 1); break;
    case "br-add": state.businessRules.push(blankBr()); break;
    case "br-del": state.businessRules.splice(idx, 1); break;
    case "tc-add": state.testCases.push(blankTc()); break;
    case "tc-del": state.testCases.splice(idx, 1); break;
    case "df-add": state.knownDefects.push(blankDf()); break;
    case "df-del": state.knownDefects.splice(idx, 1); break;
    case "doc-del": state.supportingDocuments.splice(idx, 1); break;
    case "load-example": state = exampleState(); break;
    case "clear": state = freshState(); break;
    case "continue-evidence":
    case "back-to-evidence":
      root.querySelector("#ws-evidence-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    case "back-to-context":
      root.querySelector("#ws-context-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    case "pick-file": root.querySelector("[data-file-input]")?.click(); return;
    case "tpl-tc": downloadText("qa-test-cases-template.csv", TEMPLATES["qa-test-cases-template.csv"]); return;
    case "tpl-df": downloadText("qa-defects-template.csv", TEMPLATES["qa-defects-template.csv"]); return;
    case "analyze":
      state.validation = null;
      onAnalyze();
      return;
    default: return;
  }
  renderForm();
}

function bind() {
  // The first real edit after a demo/regression fixture load "graduates" the
  // form to a normal user-authored submission — it must never be silently
  // re-run against the fixture's own canonical dataset once the user has
  // changed something the backend would otherwise ignore.
  const clearDemoFlag = () => { if (state.demoLoaded) state.demoLoaded = false; };

  root.addEventListener("input", () => { clearDemoFlag(); syncFromDom(); updateDerived(); });
  root.addEventListener("change", (e) => {
    clearDemoFlag();
    // Some controls change how the form should *look* (covers chips, the defect
    // severity/status accents, the live evidence counts).
    // A full re-render is simplest and preserves focus + caret via renderForm().
    if (e.target.matches('[data-field="covers"], [data-field="relatedAcs"], [data-field="critical"], [data-field="severity"], [data-field="status"]')) {
      syncFromDom(); renderForm();
    } else {
      syncFromDom(); updateDerived();
    }
  });
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", (e) => {
    const trigger = e.target.closest(".crit-select__trigger");
    if (trigger) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const list = trigger.closest(".crit-select").querySelector(".crit-select__list");
        list.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        list.querySelector(".crit-opt")?.focus();
      } else if (e.key === "Escape") {
        closeCritDropdown();
      }
      return;
    }
    const optEl = e.target.closest(".crit-opt");
    if (!optEl) return;
    const list = optEl.closest(".crit-select__list");
    const opts = [...list.querySelectorAll(".crit-opt")];
    const i = opts.indexOf(optEl);
    if (e.key === "ArrowDown") { e.preventDefault(); opts[Math.min(i + 1, opts.length - 1)].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); opts[Math.max(i - 1, 0)].focus(); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); state.criticality = optEl.dataset.value; renderForm(); }
    else if (e.key === "Escape") {
      e.preventDefault();
      closeCritDropdown();
      list.closest(".crit-select").querySelector(".crit-select__trigger")?.focus();
    }
  });

  root.addEventListener("change", (e) => {
    if (e.target.matches("[data-file-input]") && e.target.files?.length) {
      handleFiles(e.target.files);
      e.target.value = "";
    }
  });
  root.addEventListener("dragover", (e) => {
    if (e.target.closest("[data-drop]")) { e.preventDefault(); e.target.closest("[data-drop]").classList.add("drag"); }
  });
  root.addEventListener("dragleave", (e) => {
    const dz = e.target.closest("[data-drop]");
    if (dz) dz.classList.remove("drag");
  });
  root.addEventListener("drop", (e) => {
    const dz = e.target.closest("[data-drop]");
    if (!dz) return;
    e.preventDefault();
    dz.classList.remove("drag");
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });
}

// Registered once at module load (not inside bind(), which reruns on every
// mountWorkspace() call) so it never accumulates duplicate listeners across
// repeated "new assessment" cycles. Closes the criticality listbox on a click
// anywhere outside it, including outside the workspace root entirely.
document.addEventListener("click", (e) => {
  if (!root || e.target.closest(".crit-select")) return;
  closeCritDropdown();
});

export function mountWorkspace(container, opts = {}) {
  root = container;
  onAnalyze = opts.onAnalyze || (() => {});
  onStateChange = opts.onStateChange || (() => {});
  if (opts.reset) state = freshState();
  root.innerHTML = "";
  bind();
  renderForm();
}
