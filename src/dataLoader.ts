/**
 * Thin data loader.
 *
 * Its only job is to read the Phase 2 synthetic JSON files from `data/` and
 * parse them. It contains no QA logic, no release-decision logic, and no
 * knowledge of MCP. Reading files is the one and only side effect.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Logical dataset names, one per Phase 2 file / per MCP tool. */
export type DatasetName = "requirement" | "existing-tests" | "known-defects" | "risk-rules";

export const DATASET_NAMES: readonly DatasetName[] = [
  "requirement",
  "existing-tests",
  "known-defects",
  "risk-rules",
];

const FILE_BY_DATASET: Record<DatasetName, string> = {
  requirement: "requirement.json",
  "existing-tests": "existing-tests.json",
  "known-defects": "known-defects.json",
  "risk-rules": "risk-rules.json",
};

/** Absolute path to the repository's `data/` directory, resolved from this module. */
export const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));

/**
 * Read and parse one synthetic dataset. Returns parsed JSON as `unknown`;
 * callers (or their tests) are responsible for shape expectations.
 *
 * @throws if `name` is not a known dataset, or the file is missing / not valid JSON.
 */
export function loadDataset(name: DatasetName): unknown {
  const file = FILE_BY_DATASET[name];
  if (file === undefined) {
    throw new Error(`Unknown dataset "${String(name)}". Expected one of: ${DATASET_NAMES.join(", ")}.`);
  }
  const raw = readFileSync(DATA_DIR + file, "utf8");
  return JSON.parse(raw) as unknown;
}
