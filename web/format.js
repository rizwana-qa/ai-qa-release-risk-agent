// Display-only helpers. Every value shown by the UI comes from the backend
// response or the user's own input. NO risk / coverage / security / decision
// logic lives here.

export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
/** For use inside HTML attributes (also collapses newlines). */
export function attr(value) {
  return esc(value).replaceAll("\n", " ").replaceAll("\r", " ");
}

export function humanizeArea(area) {
  const s = String(area ?? "").trim();
  if (!s) return "N/A";
  return s.split(/[-_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Title-casing a short label (e.g. "payments") reads fine; title-casing a
 * sentence someone typed into the same field reads as broken grammar. Use
 * word-count as the signal and only humanize genuinely label-length values.
 * Returns a plain (unescaped) string, exactly like humanizeArea() — callers
 * apply esc() the same way for both. */
export function displayArea(area) {
  const s = String(area ?? "").trim();
  if (!s) return "N/A";
  // Area values are normalized to hyphenated slugs server-side (api/policy.ts
  // slugifyArea()) even when the original text was a long sentence, not a
  // short label — so "words" must be counted on the same delimiters
  // humanizeArea() itself splits on (hyphen/underscore/space), not just
  // whitespace, or a long slugified sentence still gets title-cased.
  const words = s.split(/[-_\s]+/).filter(Boolean);
  return words.length <= 6 ? humanizeArea(s) : s.replace(/[-_]+/g, " ");
}

/**
 * Render free-text the user or the AI supplied (acceptance-criteria text,
 * defect descriptions, narrative explanations) faithfully: fully escaped
 * first (identical safety guarantee to esc()), then real line breaks
 * preserved and a small set of literal markdown markers converted to actual
 * formatting — never silently stripped, never left as raw "**"/"- " noise.
 * Never changes the underlying value, only how this one render presents it.
 */
// Whole-word-only, so this can only ever match the standalone acronym, never
// a substring of an unrelated word — display-only, never touches the
// underlying submitted/AI-generated value, just how this one render presents it.
const ACRONYMS = ["id", "otp", "api", "url", "ui", "pin", "sql", "html", "json", "csv", "pdf"];
const ACRONYM_RE = new RegExp(`\\b(${ACRONYMS.join("|")})\\b`, "gi");

export function formatFreeText(value) {
  let s = esc(value).replaceAll("\r\n", "\n");
  // Bold / italic.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  // Lines starting with "- " or "* " read as a bullet, not literal punctuation.
  s = s
    .split("\n")
    .map((line) => (/^\s*[-*]\s+/.test(line) ? "• " + line.replace(/^\s*[-*]\s+/, "") : line))
    .join("\n");
  s = s.replace(ACRONYM_RE, (m) => m.toUpperCase());
  return s.replaceAll("\n", "<br>");
}

export function upper(value) {
  return String(value ?? "").toUpperCase();
}

/** Map a backend decision token to a label. NEVER invents "GO". */
export function decisionLabel(token) {
  switch (token) {
    case "GO": return "GO";
    case "NO_GO": return "NO GO";
    case "CONDITIONAL": return "CONDITIONAL";
    default: return "UNAVAILABLE";
  }
}
/** A pipeline-trace "detail" string is sometimes written server-side as
 * "<DECISION> (<rule>)" using the raw enum (e.g. "NO_GO (GATE-2)"). Run it
 * through decisionLabel() so the same status never reads two different ways
 * across the report (main pipeline panel vs. Technical Details trace table). */
export function formatTraceDetail(detail) {
  const m = /^(GO|NO_GO|CONDITIONAL)(\s*\(.*)$/.exec(detail ?? "");
  return m ? decisionLabel(m[1]) + m[2] : detail;
}

export function decisionClass(token) {
  switch (token) {
    case "GO": return "d-go";
    case "NO_GO": return "d-no-go";
    case "CONDITIONAL": return "d-conditional";
    default: return "d-unavailable";
  }
}

export function severityClass(sev) {
  const s = String(sev ?? "").toLowerCase();
  if (s === "critical") return "b-critical";
  if (s === "high") return "b-high";
  if (s === "medium") return "b-medium";
  if (s === "low") return "b-low";
  return "b-neutral";
}
export function priorityClass(p) {
  const s = String(p ?? "").toLowerCase();
  if (s === "high") return "b-high";
  if (s === "medium") return "b-medium";
  return "b-neutral";
}
export function riskLevelClass(level) {
  const s = String(level ?? "").toLowerCase();
  if (s === "high") return "b-high";
  if (s === "medium") return "b-medium";
  if (s === "low") return "b-low";
  return "b-neutral";
}
export function coverageClass(c) {
  const s = String(c ?? "").toLowerCase();
  if (s === "covered") return "b-cov";
  if (s === "partial") return "b-medium";
  return "b-notcov";
}
export function testStatusClass(statusRaw) {
  const s = String(statusRaw ?? "").toLowerCase();
  if (s === "passed") return "b-cov";
  if (s === "failed") return "b-critical";
  if (s === "blocked") return "b-medium";
  return "b-neutral";
}

/** Purely presentational grouping of the analyzer's own scenario strings. */
export function groupScenarios(list) {
  const groups = new Map();
  const put = (name, item) => { if (!groups.has(name)) groups.set(name, []); groups.get(name).push(item); };
  for (const raw of list ?? []) {
    const t = String(raw).toLowerCase();
    if (/business rule|\bbr\d/.test(t)) put("Business rules", String(raw));
    else if (/secur|tamper|unauthor|access|encrypt|integrity/.test(t)) put("Security", String(raw));
    else if (/auth/.test(t)) put("Authentication", String(raw));
    else if (/threshold|score|scoring|certif|criteri/.test(t)) put("Scoring / certification", String(raw));
    else if (/retriev|knowledge|guidance|rag|version/.test(t)) put("Retrieval / validation", String(raw));
    else if (/reproduc|consistent|toleranc|repeat/.test(t)) put("Reproducibility", String(raw));
    else put("Functional", String(raw));
  }
  return [...groups.entries()].map(([name, items]) => ({ name, items }));
}

export function acIdsIn(text) {
  return [...String(text ?? "").matchAll(/\bAC-?\d+\b/g)].map((m) => m[0]);
}
export function defectIdsIn(text) {
  return [...String(text ?? "").matchAll(/\bD(?:EF)?-?[A-Za-z0-9]+\b/g)].map((m) => m[0]);
}
