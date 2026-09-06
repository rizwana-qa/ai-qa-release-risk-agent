// Client-side parsing of QA evidence files. Everything here treats file content
// as untrusted plain data: it is parsed into rows/notes and rendered through the
// escaping helpers in format.js. No file content is ever executed or eval'd, and
// binary office formats are kept as reference metadata only.

export const TEXT_EXT = ["json", "csv", "txt"];
export const REFERENCE_EXT = ["pdf", "docx", "xlsx"];
// Formats we refuse outright — executables / scripts / archives.
const BLOCKED_EXT = [
  "exe", "dll", "bat", "cmd", "com", "msi", "sh", "bash", "ps1", "psm1",
  "js", "mjs", "cjs", "jsx", "ts", "vbs", "scr", "jar", "app", "bin",
  "zip", "rar", "7z", "gz", "tar", "html", "htm", "svg",
];

const MAX_TEXT_BYTES = 2 * 1024 * 1024; // parse budget for text evidence
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // matches api/policy.ts LIMITS.fileBytes

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
}

/**
 * Decide how a filename may be used, purely from its extension:
 *   "text"       -> parsed into rows / notes in the browser
 *   "reference"  -> attached as metadata only, never parsed
 *   "blocked"    -> refused (executables, scripts, archives, markup, or no extension)
 */
export function classifyExt(name) {
  const ext = extOf(name);
  if (!ext || BLOCKED_EXT.includes(ext)) return "blocked";
  if (TEXT_EXT.includes(ext)) return "text";
  if (REFERENCE_EXT.includes(ext)) return "reference";
  return "blocked";
}

/** Minimal RFC-4180-ish CSV parser. Returns an array of plain objects. */
export function csvToRows(text) {
  const rows = [];
  let field = "";
  let record = [];
  let inQuotes = false;
  const src = String(text).replace(/\r\n?/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field); field = "";
    } else if (ch === "\n") {
      record.push(field); rows.push(record); field = ""; record = [];
    } else {
      field += ch;
    }
  }
  if (field.length || record.length) { record.push(field); rows.push(record); }

  const cells = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (cells.length < 1) return [];
  const header = cells[0].map((h) => h.trim());
  return cells.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = (r[idx] ?? "").trim(); });
    return obj;
  });
}

function rowsFromJson(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const key of ["testCases", "tests", "knownDefects", "defects", "rows", "items"]) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return [];
}

/**
 * Read one file. Resolves to a descriptor:
 *   { ok:true, kind:"rows",      name, size, type, rows }          json / csv
 *   { ok:true, kind:"note",      name, size, type, text }          txt
 *   { ok:true, kind:"reference", name, size, type }                pdf / docx / xlsx
 *   { ok:false, name, error }
 */
export function readEvidenceFile(file) {
  return new Promise((resolve) => {
    const name = String(file.name || "file");
    const ext = extOf(name);
    const size = Number(file.size) || 0;

    if (BLOCKED_EXT.includes(ext) || ext === "") {
      resolve({ ok: false, name, error: `"${name}": file type .${ext || "?"} is not supported.` });
      return;
    }
    if (size > MAX_FILE_BYTES) {
      resolve({ ok: false, name, error: `"${name}" is larger than ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.` });
      return;
    }

    if (REFERENCE_EXT.includes(ext)) {
      resolve({ ok: true, kind: "reference", name, size, type: ext });
      return;
    }

    if (!TEXT_EXT.includes(ext)) {
      resolve({ ok: false, name, error: `"${name}": only ${TEXT_EXT.join(", ")} are parsed; ${REFERENCE_EXT.join(", ")} are attached as references.` });
      return;
    }

    if (size > MAX_TEXT_BYTES) {
      resolve({ ok: false, name, error: `"${name}" is too large to parse in the browser (${Math.round(size / 1024)} KB).` });
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => resolve({ ok: false, name, error: `"${name}" could not be read.` });
    reader.onload = () => {
      const text = String(reader.result ?? "");
      try {
        if (ext === "json") {
          const rows = rowsFromJson(JSON.parse(text));
          resolve({ ok: true, kind: "rows", name, size, type: "json", rows });
        } else if (ext === "csv") {
          resolve({ ok: true, kind: "rows", name, size, type: "csv", rows: csvToRows(text) });
        } else {
          resolve({ ok: true, kind: "note", name, size, type: "txt", text: text.slice(0, 20000) });
        }
      } catch (err) {
        resolve({ ok: false, name, error: `"${name}" is not valid ${ext.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}` });
      }
    };
    reader.readAsText(file);
  });
}

/* ----- mapping parsed rows onto the workspace evidence models ----- */

const pick = (row, keys) => {
  for (const k of Object.keys(row)) {
    if (keys.includes(k.trim().toLowerCase())) return String(row[k] ?? "").trim();
  }
  return "";
};

export function rowsToTestCases(rows) {
  return rows.map((r) => ({
    label: pick(r, ["test id", "testid", "id", "test case", "case"]),
    title: pick(r, ["title", "name", "description", "summary"]) || "Untitled test",
    area: pick(r, ["area", "feature", "module", "component"]),
    testType: pick(r, ["type", "test type", "testtype"]) || "integration",
    status: pick(r, ["status", "result", "outcome"]) || "not-run",
    covers: pick(r, ["covers", "ac", "acs", "acceptance criteria", "criteria"])
      .split(/[,;/\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean),
  })).filter((t) => t.title || t.label);
}

export function rowsToDefects(rows) {
  return rows.map((r) => ({
    label: pick(r, ["defect id", "defectid", "id", "bug id", "ticket"]),
    severity: (pick(r, ["severity", "priority", "sev"]) || "medium").toLowerCase(),
    status: (pick(r, ["status", "state"]) || "open").toLowerCase(),
    area: pick(r, ["area", "feature", "module", "component"]),
    security: /^(y|yes|true|1|security)$/i.test(pick(r, ["security", "security issue", "is security"])),
    description: pick(r, ["description", "summary", "title", "details"]) || "(no description provided)",
    relatedAcs: pick(r, ["related ac", "ac", "acs", "acceptance criteria"])
      .split(/[,;/\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean),
  })).filter((d) => d.description || d.label);
}

/* ----- downloadable CSV templates ----- */

export const TEMPLATES = {
  "qa-test-cases-template.csv":
    "Test ID,Title,Area,Type,Status,Covers\n" +
    "TC-001,Valid login redirects to dashboard,Authentication,e2e,passed,AC1\n" +
    "TC-002,Locked account cannot log in,Authentication,integration,failed,AC2\n",
  "qa-defects-template.csv":
    "Defect ID,Severity,Status,Area,Security,Description,Related AC\n" +
    "DEF-001,high,open,Authentication,yes,Session token not rotated after password reset,AC2\n",
};

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
