// Quality Gates page: a read-only description of the existing gates.
//
// Everything shown comes from GET /api/quality-gates, which reads the gate
// rules from src/releaseGate.ts and the fixed policy. Nothing here evaluates a
// gate, calculates risk or decides anything.

import { ICONS } from "./icons.js";
import { esc, headingCase, decisionLabel } from "./format.js";

const NOT_DEFINED = "Not Explicitly Defined in the Current Implementation";

const decisionTone = (d) => (d === "GO" ? "b-low" : d === "CONDITIONAL" ? "b-medium" : "b-high");
const decisionText = (d) => decisionLabel(d);

const row = (label, valueHtml) => `<div class="qg-row"><dt>${esc(label)}</dt><dd>${valueHtml}</dd></div>`;
const list = (items) => `<ul class="qg-list">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;

function gateCard(g) {
  return `<article class="card qg-gate" aria-labelledby="qg-${esc(g.id)}">
    <div class="card__head">
      <span class="qg-id">${esc(g.id)}</span>
      <h3 id="qg-${esc(g.id)}">${esc(headingCase(g.title))}</h3>
      <span class="badge ${decisionTone(g.decision)}">${esc(decisionText(g.decision))}</span>
    </div>
    <div class="card__body">
      <dl class="qg-dl">
        ${row("Purpose", esc(g.purpose))}
        ${row("Rule", esc(g.condition))}
        ${row("Evidence Used", list(g.evidence))}
        ${row("Risk Relationship", esc(g.riskRelationship))}
        ${row("Consequence", esc(g.consequence))}
        ${row("Where Established", `<code>${esc(g.source)}</code>`)}
      </dl>
    </div>
  </article>`;
}

function subRules(title, id, rule, intro) {
  return `<section class="card" aria-labelledby="${id}">
    <div class="card__head"><span class="ico">${ICONS.list}</span><h3 id="${id}">${esc(headingCase(title))}</h3></div>
    <div class="card__body">
      <p>${esc(intro)} ${esc(rule.description)}</p>
      <dl class="qg-dl">${rule.conditions.map((c) => row(c.id, `${esc(c.text)}${typeof c.threshold === "number" ? ` <span class="badge b-out">Threshold: ${esc(c.threshold)} (illustrative)</span>` : ""}`)).join("")}</dl>
    </div>
  </section>`;
}

export function qualityGatesView(doc) {
  const order = doc.evaluationOrder.map((id) => `<li>${esc(id)}</li>`).join("");
  return `<div class="pagehead qg-head">
      <div>
        <span class="eyebrow">Reference</span>
        <h1 id="qg-h" tabindex="-1">Quality Gates</h1>
        <p>The release decision is made by a fixed set of quality gates in code. This page describes them as implemented; it does not evaluate anything or change any result.</p>
      </div>
      <a class="btn btn--ghost" href="#/" data-act="close-gates">Back to Workflow</a>
    </div>

    <section class="card" aria-labelledby="qg-purpose">
      <div class="card__head"><span class="ico">${ICONS.info}</span><h2 id="qg-purpose">Purpose</h2></div>
      <div class="card__body">
        <p>A quality gate is a rule checked against the evidence for a release (acceptance criteria, test cases and defects). The first gate whose condition holds decides the release recommendation: <b>${doc.decisions.map((d) => esc(decisionText(d))).join(", ")}</b>. The AI analysis explains risk but never makes that decision.</p>
      </div>
    </section>

    <h2 class="qg-h2" id="qg-inventory">Quality Gate Inventory</h2>
    <p class="muted qg-intro">Gates are listed in evaluation order. Gates have no separate severity rating or numeric risk contribution: ${NOT_DEFINED}. Each gate's consequence is the decision it returns.</p>
    ${doc.gates.map(gateCard).join("")}
    <article class="card qg-gate" aria-labelledby="qg-FAILSAFE">
      <div class="card__head"><span class="qg-id">${esc(doc.failSafe.id)}</span><h3 id="qg-FAILSAFE">Fail-Safe</h3><span class="badge ${decisionTone(doc.failSafe.decision)}">${esc(decisionText(doc.failSafe.decision))}</span></div>
      <div class="card__body"><dl class="qg-dl">
        ${row("Rule", esc(doc.failSafe.condition))}
        ${row("Consequence", "Missing data is never treated as safe.")}
        ${row("Where Established", `<code>${esc(doc.failSafe.source)}</code>`)}
      </dl></div>
    </article>

    <h2 class="qg-h2" id="qg-conditions">Conditions Behind The Gates</h2>
    ${subRules("Coverage Conditions (Used by GATE-4)", "qg-cov", doc.coverageRule, "Insufficient coverage is checked only through GATE-4.")}
    ${subRules("Security Conditions (Used by GATE-2)", "qg-sec", doc.securityRule, "A security failure is checked only through GATE-2.")}

    <section class="card" aria-labelledby="qg-flow">
      <div class="card__head"><span class="ico">${ICONS.route}</span><h2 id="qg-flow">Evaluation And Decision Flow</h2></div>
      <div class="card__body">
        <ol class="qg-flow">${doc.flow.map((f) => `<li><b>${esc(f.label)}</b><span>${esc(f.text)}</span></li>`).join("")}</ol>
        <p class="hint">Gate order:</p>
        <ol class="qg-order" aria-label="Gate evaluation order">${order}</ol>
        <p>${esc(doc.evaluationNote)}</p>
      </div>
    </section>

    <section class="card" aria-labelledby="qg-source">
      <div class="card__head"><span class="ico">${ICONS.file}</span><h2 id="qg-source">Source Of Truth</h2></div>
      <div class="card__body">
        <h3 class="qg-h3">Evidence The Gates Read</h3>
        <dl class="qg-dl">${doc.evidenceSources.map((e) => row(e.label, esc(e.text))).join("")}</dl>
        <h3 class="qg-h3">How Risk And Criticality Are Derived</h3>
        <dl class="qg-dl">${doc.riskDerivation.map((r) => row(r.label, `${esc(r.text)} <code>${esc(r.source)}</code>`)).join("")}</dl>
      </div>
    </section>

    <section class="card" aria-labelledby="qg-limits">
      <div class="card__head"><span class="ico">${ICONS.alert}</span><h2 id="qg-limits">Limitations And Undefined Behavior</h2></div>
      <div class="card__body">${list(doc.limitations)}</div>
    </section>`;
}

export function qualityGatesError(message) {
  return `<div class="pagehead"><div><span class="eyebrow">Reference</span><h1 id="qg-h" tabindex="-1">Quality Gates</h1></div></div>
    <div class="card"><div class="card__body"><p role="alert">The quality gate definitions could not be loaded: ${esc(message)}</p>
    <a class="btn btn--ghost" href="#/" data-act="close-gates">Back to Workflow</a></div></div>`;
}
