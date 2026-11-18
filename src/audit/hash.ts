import { createHash } from "node:crypto";

/** Domain separator so AgentAnchor hashes can never collide with other SHA-256 uses. */
export const HASH_DOMAIN = "agentanchor/audit/v1";

/** prevHash of the very first record in a chain (64 zero hex chars). */
export const GENESIS_HASH = "0".repeat(64);

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Deterministic JSON encoding: object keys are sorted recursively, arrays
 * keep their order, and `undefined` object fields are dropped (the same rule
 * JSON.stringify applies). Two payloads that differ only in key order encode
 * — and therefore hash — identically.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v === undefined ? null : v)).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v)).join(",") + "}";
}

/** Deep copy for JSON-safe values (audit records and payloads always are). */
export function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
