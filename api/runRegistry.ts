/**
 * Short-lived in-memory registry mapping a server-generated runId to a validated
 * assessment payload. Needed because SSE (`EventSource`) is GET-only and cannot
 * carry the POST body. Single-use, TTL-bounded, size-capped.
 */

import { randomUUID } from "node:crypto";

const TTL_MS = 120_000;
const MAX_ENTRIES = 200;

interface Entry { payload: unknown; created: number }
const store = new Map<string, Entry>();

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, entry] of store) if (entry.created < cutoff) store.delete(id);
}

/** Stash a payload, return its runId. */
export function put(payload: unknown): string {
  sweep();
  if (store.size >= MAX_ENTRIES) {
    let oldestId: string | undefined;
    let oldest = Infinity;
    for (const [id, e] of store) if (e.created < oldest) { oldest = e.created; oldestId = id; }
    if (oldestId) store.delete(oldestId);
  }
  const id = randomUUID();
  store.set(id, { payload, created: Date.now() });
  return id;
}

/** Fetch and remove (single-use). Returns undefined if unknown or expired. */
export function take(id: string): unknown | undefined {
  sweep();
  const entry = store.get(id);
  if (!entry) return undefined;
  store.delete(id);
  return entry.payload;
}

/** Test helper. */
export function size(): number {
  sweep();
  return store.size;
}
