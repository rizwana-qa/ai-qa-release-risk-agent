// The QA Release Risk Assessment workspace form.
//
// Owns only the *input model*. It performs no risk / coverage / security /
// decision logic — the small "live evidence summary" it shows is a plain count of
// what the user has typed, clearly labelled as a preview; the authoritative
// coverage figures come back from the backend. All rendered values pass through
// the escaping helpers in format.js.

import { ICONS } from "./icons.js";
import { esc, attr, upper, headingCase } from "./format.js";
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
    // Which of the two input screens is showing: "context" | "evidence". Pure
    // presentation state; it never affects the payload or any validation rule.
    stage: "context",
    touched: { releaseScope: false, userStory: false, ac: false },
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
  s.stage = state.stage;
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
  // The fixture's context is complete, so the user lands on Evidence, one click
  // from the same Analyze button manual entry uses. Nothing is auto-analyzed.
  s.stage = "evidence";
  state = s;
  renderForm();
  onStateChange(getWorkflowState());
}

/** Real per-step workflow state for the sidebar (app.js), not decorative:
 *  derived from the SAME rules canAnalyze()/sectionState() already use. */
export function getWorkflowState() {
  return {
    contextComplete: sectionState("context").complete === true && sectionState("ac").complete === true,
    canAnalyze: canAnalyze(),
    demoLoaded: state.demoLoaded,
    stage: state.stage,
  };
}

/** Switch between the two input screens. Evidence is only reachable once the
 * Context section is complete — the same rule the old "Continue to Evidence"
 * button enforced. Returns whether the switch happened. */
export function showStage(name) {
  if (name !== "context" && name !== "evidence") return false;
  syncFromDom();
  if (name === "evidence" && !contextReady()) return false;
  state.stage = name;
  renderForm();
  window.scrollTo({ top: 0 });
  root?.querySelector("#page-h")?.focus({ preventScroll: true });
  return true;
}


/* ------------------------------- DOM syncing ------------------------------ */

const val = (el) => (el ? el.value : "");
const chk = (el) => (el ? el.checked : false);

function syncFromDom() {
  if (!root) return;
  const q = (sel, ctx = root) => ctx.querySelector(sel);
  const qa = (sel, ctx = root) => [...ctx.querySelectorAll(sel)];

  // Only the screen that is showing has inputs in the DOM. Syncing the other
  // screen's fields from an absent DOM would blank state the user already
  // entered, so each stage reads back only its own sections.
  if (state.stage === "context") {
    state.releaseName = val(q('[data-field="releaseName"]'));
    state.releaseScope = val(q('[data-field="releaseScope"]'));
    state.userStory = val(q('[data-field="userStory"]'));
    const crit = q('[data-field="criticality"]:checked');
    if (crit && CRITICALITY.includes(crit.value)) state.criticality = crit.value;

    state.acceptanceCriteria = qa('[data-group="ac"]').map((row) => ({
      area: val(q('[data-field="area"]', row)),
      critical: chk(q('[data-field="critical"]', row)),
      text: val(q('[data-field="text"]', row)),
    }));
    if (state.acceptanceCriteria.length === 0) state.acceptanceCriteria = [blankAc()];

    state.businessRules = qa('[data-group="br"]').map((row) => ({
      text: val(q('[data-field="text"]', row)),
    }));
    return;
  }

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

/** The Context screen is complete under exactly the rule canAnalyze() uses. */
function contextReady() {
  return canAnalyze();
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
  return `<span class="card-status${statusMod(s)}" data-status-for="${kind}"${dc}>${s.complete === true ? ICONS.check : ""}<span>${esc(s.text)}</span></span>`;
}

/** Optional sections read quietly until something has been added. */
function statusMod(s) {
  if (s.complete !== null) return "";
  return s.text === "Optional" ? " card-status--opt" : " card-status--has";
}

function refreshSectionBadges() {
  if (!root) return;
  root.querySelectorAll("[data-status-for]").forEach((el) => {
    const s = sectionState(el.dataset.statusFor);
    el.innerHTML = (s.complete === true ? ICONS.check : "") + `<span>${esc(s.text)}</span>`;
    el.className = `card-status${statusMod(s)}`;
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
  state.stage = "evidence"; // the Analyze button — and so the server's verdict — lives here
  renderForm();
  root?.querySelector(".validation")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function setBusy(b) {
  state.busy = !!b;
  patchActionBar();
}

/* -------------------------------- markup -------------------------------- */

const opt = (list, cur, labelFn = upper) =>
  list.map((v) => `<option value="${attr(v)}"${v === cur ? " selected" : ""}>${esc(labelFn(v))}</option>`).join("");

const humanStatus = (s) => ({ "not-run": "Not run", "in-progress": "In progress" }[s] || upper(s));

const STAGE_COPY = {
  context: {
    title: "Context, scope & metadata",
    sub: "Describe the release you want assessed. The agent analyses only what you supply; it does not run your application, browse URLs or execute tests.",
  },
  evidence: {
    title: "Evidence, tests & known defects",
    sub: "Add the QA evidence you already have. Missing evidence is reported as a finding, never invented.",
  },
};

/** Criticality is a segmented radio group: all four options stay visible and
 * keyboard-operable (arrow keys), same values and the same HIGH default. */
function criticalityControl(rawCur) {
  const cur = CRITICALITY.includes(rawCur) ? rawCur : "high";
  return `<div class="seg" role="radiogroup" aria-labelledby="f-crit-label">${CRITICALITY.map((v) =>
    `<label>${esc(upper(v))}<input type="radio" name="criticality" value="${attr(v)}" data-field="criticality"${v === cur ? " checked" : ""} /></label>`).join("")}</div>`;
}

function coversPicker(field, selected) {
  const acs = acLabels();
  const title = field === "covers" ? "Covers:" : "Related AC:";
  if (!acs.length) return `<div class="covers"><span class="covers__t">${title}</span><span class="field__hint">Add acceptance criteria to link coverage.</span></div>`;
  const set = new Set(selected || []);
  return `<div class="covers" role="group" aria-label="${field === "covers" ? "Covers" : "Related acceptance criteria"}"><span class="covers__t">${title}</span>${acs.map((x) =>
    `<label class="${set.has(x.id) ? "on" : ""}">${esc(x.id)}
      <input type="checkbox" data-field="${field}" value="${attr(x.id)}"${set.has(x.id) ? " checked" : ""} />
    </label>`).join("")}</div>`;
}

function acRow(ac, i, total) {
  return `<div class="row row--ac" data-group="ac" data-index="${i}">
    <div class="row__id" aria-hidden="true">AC${i + 1}</div>
    <div class="row__main">
      <textarea class="textarea" data-field="text" rows="2" aria-label="Acceptance criterion ${i + 1}"
        placeholder="Describe the acceptance criterion…">${esc(ac.text)}</textarea>
      <div class="row__meta">
        <input class="input" data-field="area" value="${attr(ac.area)}" aria-label="Area for AC${i + 1}" placeholder="Area (e.g. payments)" />
        <label class="checkbox"><input type="checkbox" data-field="critical"${ac.critical ? " checked" : ""} /> Critical</label>
      </div>
    </div>
    <div class="row__tools">
      <button class="iconbtn" type="button" data-act="ac-up" data-index="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move AC${i + 1} up">${ICONS.up}</button>
      <button class="iconbtn" type="button" data-act="ac-down" data-index="${i}" ${i === total - 1 ? "disabled" : ""} aria-label="Move AC${i + 1} down">${ICONS.down}</button>
      <button class="iconbtn iconbtn--danger" type="button" data-act="ac-del" data-index="${i}" aria-label="Delete AC${i + 1}">${ICONS.trash}</button>
    </div>
  </div>`;
}

function brRow(br, i) {
  return `<div class="row row--br" data-group="br" data-index="${i}">
    <input class="input" data-field="text" value="${attr(br.text)}" aria-label="Business rule ${i + 1}" placeholder="Business rule (context only, does not change the release gate)" />
    <button class="iconbtn iconbtn--danger" type="button" data-act="br-del" data-index="${i}" aria-label="Delete business rule ${i + 1}">${ICONS.trash}</button>
  </div>`;
}

function tcRow(t, i) {
  return `<div class="row row--item" data-group="tc" data-index="${i}">
    <div class="row__main">
      <div class="rgrid">
        <input class="input" data-field="label" value="${attr(t.label)}" aria-label="Test ID ${i + 1}" placeholder="Test ID" />
        <input class="input col-title" data-field="title" value="${attr(t.title)}" aria-label="Test title ${i + 1}" placeholder="Test title" />
        <input class="input" data-field="area" value="${attr(t.area)}" aria-label="Test area ${i + 1}" placeholder="Area" />
        <select class="select" data-field="testType" aria-label="Test type ${i + 1}">${opt(TEST_TYPES, t.testType)}</select>
        <select class="select" data-field="status" aria-label="Test status ${i + 1}">${opt(TEST_STATUS, t.status, humanStatus)}</select>
      </div>
      ${coversPicker("covers", t.covers)}
    </div>
    <button class="iconbtn iconbtn--danger" type="button" data-act="tc-del" data-index="${i}" aria-label="Delete test ${i + 1}">${ICONS.trash}</button>
  </div>`;
}

function dfRow(d, i) {
  const sev = SEVERITIES.includes(d.severity) ? d.severity : "medium";
  const st = DEFECT_STATUS.includes(d.status) ? d.status : "open";
  return `<div class="row row--item row--defect" data-group="df" data-index="${i}" data-severity="${attr(sev)}" data-status="${attr(st)}">
    <div class="row__main">
      <div class="rgrid rgrid--d">
        <input class="input" data-field="label" value="${attr(d.label)}" aria-label="Defect ID ${i + 1}" placeholder="Defect ID" />
        <select class="select" data-field="severity" aria-label="Defect severity ${i + 1}">${opt(SEVERITIES, d.severity)}</select>
        <select class="select" data-field="status" aria-label="Defect status ${i + 1}">${opt(DEFECT_STATUS, d.status)}</select>
        <input class="input" data-field="area" value="${attr(d.area)}" aria-label="Defect area ${i + 1}" placeholder="Area" />
        <label class="checkbox"><input type="checkbox" data-field="security"${d.security ? " checked" : ""} /> Security issue</label>
      </div>
      <div class="field" style="margin:10px 0 0"><textarea class="textarea" data-field="description" rows="2" aria-label="Defect description ${i + 1}" placeholder="Defect description">${esc(d.description)}</textarea></div>
      ${coversPicker("relatedAcs", d.relatedAcs)}
    </div>
    <button class="iconbtn iconbtn--danger" type="button" data-act="df-del" data-index="${i}" aria-label="Delete defect ${i + 1}">${ICONS.trash}</button>
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
      <button class="iconbtn" type="button" data-act="doc-del" data-index="${i}" aria-label="Remove ${attr(d.name)}" style="width:30px;height:30px">${ICONS.x}</button>
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

/** Real, explicit "what's here / what's missing" for the Evidence stage — never
 * hides an absence, never invents a count. Plain counts of what was entered;
 * the authoritative numbers come back from the backend. */
function evidenceSummaryBlock() {
  const p = livePreview();
  const docsN = state.supportingDocuments.length;
  const executed = state.testCases.filter((t) => t.status !== "not-run" && (t.title.trim() || t.label.trim())).length;
  const defectsN = state.knownDefects.filter((d) => d.description.trim() || d.label.trim()).length;
  const tile = (n, label, flag = false) =>
    `<div class="stat${flag ? " stat--flag" : ""}"><div class="stat__n">${n}</div><div class="stat__t">${esc(label)}</div></div>`;
  const noEvidence = p.totalTests === 0;
  const noPassingMapped = p.covered === 0; // display of the count above; the gate decides
  return `<div class="evstats">
      ${tile(p.totalTests, "Test cases provided", p.totalTests === 0)}
      ${tile(executed, "Execution results provided", executed === 0)}
      ${tile(defectsN, "Defects provided")}
      ${tile(docsN, "Supporting documents provided")}
    </div>
    ${noPassingMapped
      ? `<div class="banner banner--warn mt-3" style="margin-bottom:0"><span class="ico">${ICONS.alert}</span>
         <div><b>${noEvidence ? "No test cases have been added." : "No passing test is mapped to an acceptance criterion."}</b>
         The release gates decide from the evidence you submit. A release cannot be GO unless at least one acceptance criterion
         has a passing test mapped to it. Without one the result is CONDITIONAL (additional verification and review needed),
         or NO GO if a blocking rule applies. One passing test would not show that every criterion is verified.</div></div>`
      : ""}
    ${noEvidence
      ? ""
      : `<div class="stats mt-3">
          ${tile(p.passed, "Passing")}
          ${tile(p.failed, "Failing", p.failed > 0)}
          ${tile(p.blocked, "Blocked", p.blocked > 0)}
          ${tile(p.covered + " / " + p.criteria, "Criteria with a passing test")}
          ${tile(p.uncovered, "Uncovered criteria", p.uncovered > 0)}
        </div>
        <p class="field__hint mt-3">A count of what you've entered. Coverage percentages, risk levels and the release decision are computed by the backend QA rules, not here.</p>`}`;
}

const errLine = (id, text) => `<span class="field__err" id="${id}" data-err="${id}">${ICONS.alert} ${esc(text)}</span>`;

function toolsBlock() {
  return `<div class="tools">
    <button class="btn btn--ghost btn--sm" type="button" data-act="load-example">Load example</button>
    <button class="btn btn--ghost btn--sm" type="button" data-act="clear">Clear all</button>
  </div>`;
}

function pageHead() {
  const c = STAGE_COPY[state.stage];
  const n = state.stage === "context" ? 1 : 2;
  return `<div class="pagehead">
    <div><span class="eyebrow">Stage ${n} of 5</span><h1 id="page-h" tabindex="-1">${esc(headingCase(c.title))}</h1><p>${c.sub}</p></div>
    ${toolsBlock()}
  </div>`;
}

function actionBarInner() {
  if (state.stage === "context") {
    const ready = contextReady();
    return `<div class="actbar__hint">${ready
      ? "<b>Context complete.</b> Continue to add QA evidence."
      : `${ICONS.info} Complete release scope, user story, and at least one acceptance criterion to continue to Evidence.`}</div>
    <div class="actbar__btns">
      <button class="btn" type="button" data-act="continue-evidence" ${ready ? "" : 'aria-disabled="true"'}>Continue to Evidence →</button>
    </div>`;
  }
  const can = canAnalyze() && !state.busy;
  return `<div class="actbar__hint">${canAnalyze()
    ? "<b>Ready.</b> The pipeline will normalise your input, run the QA analysis, and evaluate the deterministic release gate."
    : "Add a release scope, a user story, and at least one acceptance criterion to enable analysis."}</div>
  <div class="actbar__btns">
    <button class="btn btn--ghost" type="button" data-act="back-to-context">← Context</button>
    <button class="btn btn--lg" type="button" data-act="analyze" ${can ? "" : "disabled"} ${state.busy ? 'aria-busy="true"' : ""}>
      ${state.busy ? ICONS.spinner : ICONS.play} Analyze Release Risk
    </button>
  </div>`;
}

// What the action bar and evidence summary last rendered. They are patched in
// place on every input, but only when their content actually changed: replacing
// a button between mouse-down and mouse-up (blur fires `change`, which lands
// here) would swallow the click.
let lastBarHtml = "";
let lastPreviewHtml = "";

function actionBar() {
  lastBarHtml = actionBarInner();
  return `<div class="actbar"><div class="container actbar__in" data-actbar>${lastBarHtml}</div></div>`;
}

function patchActionBar() {
  const bar = root?.querySelector("[data-actbar]");
  if (!bar) return;
  const html = actionBarInner();
  if (html === lastBarHtml) return;
  lastBarHtml = html;
  bar.innerHTML = html;
}

function contextStageHtml() {
  const acs = state.acceptanceCriteria;
  const t = state.touched;
  const scopeBad = t.releaseScope && !state.releaseScope.trim();
  const storyBad = t.userStory && !state.userStory.trim();
  const acBad = t.ac && acLabels().length === 0;
  return `
    <section class="card" aria-labelledby="h-ctx">
      <div class="card__head"><span class="ico">${ICONS.book}</span><h2 id="h-ctx">Release Context</h2>${sectionBadge("context")}</div>
      <div class="card__body">
        <div class="grid-2">
          <div class="field">
            <label class="field__label" for="f-name">Release / sprint name <span class="opt">optional</span></label>
            <input class="input" id="f-name" data-field="releaseName" value="${attr(state.releaseName)}" placeholder="e.g. Checkout 3.4" />
          </div>
          <div class="field" data-criticality="${attr(CRITICALITY.includes(state.criticality) ? state.criticality : "high")}">
            <span class="field__label" id="f-crit-label">Criticality</span>
            ${criticalityControl(state.criticality)}
            <span class="field__hint">Default is HIGH.</span>
          </div>
        </div>
        <div class="field">
          <label class="field__label" for="f-scope">Release scope / change purpose <span class="req" aria-hidden="true">*</span><span class="sr-only">required</span></label>
          <textarea class="textarea" id="f-scope" data-field="releaseScope" rows="3" aria-describedby="err-scope" ${scopeBad ? 'aria-invalid="true"' : ""} placeholder="What is changing in this release and why?">${esc(state.releaseScope)}</textarea>
          <span ${scopeBad ? "" : "hidden"}>${errLine("err-scope", "Release scope is required.")}</span>
        </div>
        <div class="field">
          <label class="field__label" for="f-story">User story / requirement <span class="req" aria-hidden="true">*</span><span class="sr-only">required</span></label>
          <textarea class="textarea" id="f-story" data-field="userStory" rows="3" aria-describedby="err-story" ${storyBad ? 'aria-invalid="true"' : ""} placeholder="As a … I want … so that …">${esc(state.userStory)}</textarea>
          <span ${storyBad ? "" : "hidden"}>${errLine("err-story", "User story is required.")}</span>
        </div>
      </div>
    </section>

    <section class="card" aria-labelledby="h-ac">
      <div class="card__head"><span class="ico">${ICONS.list}</span><h2 id="h-ac">Acceptance Criteria</h2>${sectionBadge("ac")}</div>
      <div class="card__body">
        <div class="rows">${acs.map((ac, i) => acRow(ac, i, acs.length)).join("")}</div>
        <span ${acBad ? "" : "hidden"}>${errLine("err-ac", "Add at least one acceptance criterion.")}</span>
        <button class="addrow" type="button" data-act="ac-add">${ICONS.plus} Add acceptance criteria</button>
      </div>
    </section>

    <section class="card" aria-labelledby="h-br">
      <div class="card__head"><span class="ico">${ICONS.book}</span><h2 id="h-br">Business Rules</h2>${sectionBadge("br")}</div>
      <div class="card__body">
        ${state.businessRules.length
          ? `<div class="rows">${state.businessRules.map(brRow).join("")}</div>`
          : `<div class="empty"><span class="ico">${ICONS.info}</span><div><b>No business rules added</b>These are recorded as context and never modify the release gate.</div></div>`}
        <button class="addrow" type="button" data-act="br-add">${ICONS.plus} Add business rule</button>
      </div>
    </section>`;
}

/** Shown on the Evidence screen, before Analyze. The browser cannot tell whether this deployment has Gemini
 * enabled, so it states both cases; the report says which mode ran. The claims about what is and is not sent were
 * checked against api/inputNormalizer.ts (see tests/webUnits.test.mjs) and docs/STAGE2_AI_DATA_HANDLING_AUDIT.md
 * sections 1 and 7. Keep all three in step. */
function externalAiNotice() {
  return `<div class="banner banner--info" role="note" data-disclosure="external-ai"><span class="ico">${ICONS.info}</span><div>
      <b>External AI processing: what happens to this evidence</b>
      <ul>
        <li><b>If Gemini analysis is enabled for this deployment,</b> the evidence you submit is sent to Google's Gemini API for processing: the release name, user story and release scope, acceptance-criteria text, test titles, defect descriptions, ids, statuses, severities, criticality, area names, and which criteria each test covers. Rows from uploaded CSV and JSON files are sent once they are entered as criteria, tests or defects.</li>
        <li><b>Not sent to the AI provider:</b> business rules, text notes from TXT files, and the names, sizes and types of uploaded files. <b>PDF, DOCX and XLSX contents are not read.</b></li>
        <li><b>If Gemini analysis is not enabled,</b> an offline rules-based analysis runs on this application's server and no request is made to the AI provider.</li>
        <li><b>If it is enabled and the live request fails or its response is unusable,</b> the evidence may already have been sent in that attempt. The application then falls back to the offline rules-based analysis. The report is then labelled "Rules based" and states that a live request was started and did not give usable findings. Starting a request does not confirm that the provider received it.</li>
        <li><b>Do not submit secrets, credentials, personal data or confidential production or customer evidence</b> unless the applicable data-handling requirements have been reviewed and approved. What the provider keeps or uses depends on the terms of the account behind this deployment, which this application cannot show or verify.</li>
        <li>The release decision is made by the deterministic quality gates, not by the AI.</li>
      </ul>
    </div></div>`;
}

function evidenceStageHtml() {
  return `
    ${validationBlock()}
    ${externalAiNotice()}
    <section class="card card--evidence-status" aria-labelledby="h-evs">
      <div class="card__head"><span class="ico">${ICONS.clipboard}</span><h2 id="h-evs">Evidence Provided So Far</h2></div>
      <div class="card__body" data-preview>${(lastPreviewHtml = evidenceSummaryBlock())}</div>
    </section>

    <section class="card" aria-labelledby="h-tc">
      <div class="card__head"><span class="ico">${ICONS.list}</span><h2 id="h-tc">QA Evidence · Existing Test Cases</h2>${sectionBadge("tests")}</div>
      <div class="card__body">
        ${state.testCases.length
          ? `<div class="rows">${state.testCases.map(tcRow).join("")}</div>`
          : `<div class="empty"><span class="ico">${ICONS.info}</span><div><b>No test cases added</b>Without a passing test mapped to an acceptance criterion the release cannot be GO. No tests are invented.</div></div>`}
        <button class="addrow" type="button" data-act="tc-add">${ICONS.plus} Add test case</button>
      </div>
    </section>

    <section class="card" aria-labelledby="h-df">
      <div class="card__head"><span class="ico">${ICONS.bug}</span><h2 id="h-df">Known Defects</h2>${sectionBadge("defects")}</div>
      <div class="card__body">
        ${state.knownDefects.length
          ? `<div class="rows">${state.knownDefects.map(dfRow).join("")}</div>`
          : `<div class="empty"><span class="ico">${ICONS.info}</span><div><b>No known defects added</b>Add open or closed defects so the analysis can account for them.</div></div>`}
        <button class="addrow" type="button" data-act="df-add">${ICONS.plus} Add defect</button>
      </div>
    </section>

    <section class="card" aria-labelledby="h-docs">
      <div class="card__head"><span class="ico">${ICONS.upload}</span><h2 id="h-docs">Supporting Documents</h2>${sectionBadge("docs")}</div>
      <div class="card__body">
        <div class="dropzone" data-drop>
          <span class="dropzone__icon">${ICONS.upload}</span>
          <p class="dropzone__title"><strong>Drop files here</strong> or <button class="linkbtn" type="button" data-act="pick-file">choose files</button></p>
          <p class="field__hint">${TEXT_EXT.join(", ")} are parsed into rows or notes. ${REFERENCE_EXT.join(", ")} are attached as references only (no document parsing). Executable and script files are rejected.</p>
          <input type="file" data-file-input multiple accept=".json,.csv,.txt,.pdf,.docx,.xlsx" aria-label="Choose evidence files" hidden />
        </div>
        ${state.uploadError ? `<div class="validation" role="alert" style="margin:12px 0 0">${esc(state.uploadError)}</div>` : ""}
        ${docChips()}
        <p class="field__hint" style="margin-top:12px">Templates:
          <button class="linkbtn" type="button" data-act="tpl-tc">test cases CSV</button> ·
          <button class="linkbtn" type="button" data-act="tpl-df">defects CSV</button>
        </p>
      </div>
    </section>

    <p class="foot-note">${ICONS.shield} Your software is not executed or tested by this application. Where the evidence is processed depends on the analysis mode: see the external AI processing notice above.</p>`;
}

function formHtml() {
  return `
  <div class="ws">
    ${pageHead()}
    ${state.stage === "context" ? contextStageHtml() : evidenceStageHtml()}
    ${actionBar()}
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
    if (key.top) sel = root.querySelector(`[data-field="${key.field}"]${key.field === "criticality" ? ":checked" : ""}`);
    else if (key.group != null) sel = root.querySelector(`[data-group][data-index="${key.group}"] [data-field="${key.field}"]`);
    if (sel) {
      sel.focus();
      if (caret != null && "setSelectionRange" in sel) { try { sel.setSelectionRange(caret, caret); } catch { /* noop */ } }
    }
  }
}

/** Patch the parts of the screen that depend on the form's validity without
 * rebuilding the inputs (so focus and caret stay put while typing). */
function updateDerived() {
  patchActionBar();
  refreshSectionBadges();
  const pv = root?.querySelector("[data-preview]");
  if (pv) {
    const html = evidenceSummaryBlock();
    if (html !== lastPreviewHtml) { lastPreviewHtml = html; pv.innerHTML = html; }
  }
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

/** Continue is aria-disabled (not disabled) while the context is incomplete so
 * that pressing it explains what is missing instead of doing nothing. */
function explainMissingContext() {
  state.touched = { releaseScope: true, userStory: true, ac: true };
  renderForm();
  const first = !state.releaseScope.trim() ? "#f-scope" : !state.userStory.trim() ? "#f-story" : '[data-group="ac"] textarea';
  root.querySelector(first)?.focus();
}

function onClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  const idx = Number(t.dataset.index);
  syncFromDom();

  switch (act) {
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
      if (!contextReady()) { explainMissingContext(); return; }
      showStage("evidence");
      return;
    case "back-to-context":
      showStage("context");
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

  root.addEventListener("input", (e) => {
    clearDemoFlag(); syncFromDom();
    // A required field that is typed into stops showing its error immediately.
    if (e.target.matches("#f-scope, #f-story") && e.target.value.trim()) {
      e.target.removeAttribute("aria-invalid");
      e.target.parentElement.querySelector("[data-err]")?.parentElement.setAttribute("hidden", "");
    }
    updateDerived();
  });
  root.addEventListener("change", (e) => {
    clearDemoFlag();
    // Some controls change how the form should *look* (covers chips, the live
    // evidence counts). A full re-render preserves focus + caret via renderForm().
    if (e.target.matches('[data-field="covers"], [data-field="relatedAcs"], [data-field="critical"], [data-field="severity"], [data-field="status"]')) {
      syncFromDom(); renderForm();
    } else {
      syncFromDom(); updateDerived();
    }
  });
  root.addEventListener("focusout", (e) => {
    const id = e.target?.id;
    if (id !== "f-scope" && id !== "f-story") return;
    const key = id === "f-scope" ? "releaseScope" : "userStory";
    if (state.touched[key] || e.target.value.trim()) return;
    state.touched[key] = true;
    e.target.setAttribute("aria-invalid", "true");
    const err = e.target.parentElement.querySelector("[data-err]");
    err?.parentElement.removeAttribute("hidden");
  });
  root.addEventListener("click", onClick);

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

export function mountWorkspace(container, opts = {}) {
  root = container;
  onAnalyze = opts.onAnalyze || (() => {});
  onStateChange = opts.onStateChange || (() => {});
  if (opts.reset) state = freshState();
  root.innerHTML = "";
  bind();
  renderForm();
}
