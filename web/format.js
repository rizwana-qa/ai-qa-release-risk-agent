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
