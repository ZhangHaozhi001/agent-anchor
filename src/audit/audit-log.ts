import { GENESIS_HASH, HASH_DOMAIN, canonicalJson, deepCopy, sha256Hex } from "./hash.js";

/** Any JSON value; audit payloads must stay JSON-safe so records can be exported and re-verified. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface AuditRecordInput {
  /** What happened, e.g. "payment.sent", "identity.attribute_proof_presented". */
  actionType: string;
  /** Structured details of the action. Amounts should be strings to avoid float drift. */
  payload: Record<string, JsonValue>;
  /** Who performed the action: "agent", "owner", or a counterparty identifier. Defaults to "agent". */
  actor?: string;
  /** ISO 8601 timestamp. Defaults to the log's injected clock. */
  timestamp?: string;
}

export interface AuditRecord {
  /** 0-based position in the chain. */
  seq: number;
  /** ISO 8601 time the action was recorded. */
  timestamp: string;
  agentId: string;
  /**
   * Reference to the accountable human behind the agent — e.g. a Concordium
   * identity reference. This is a pointer to a verified identity, never the
   * personal data itself.
   */
  ownerRef: string;
  actionType: string;
  actor: string;
  payload: Record<string, JsonValue>;
  /** Hash of the previous record, or GENESIS_HASH for seq 0. */
  prevHash: string;
  /** SHA-256 over the domain separator + canonical JSON of every field above. */
  hash: string;
}

export interface VerifyResult {
  ok: boolean;
  /** Number of records inspected. */
  checked: number;
  /** seq of the first record that fails verification, or null when the chain is intact. */
  firstBadSeq: number | null;
  /** Human-readable reason for the first failure, or null when ok. */
  reason: string | null;
}

/**
 * The commitment that gets anchored on-chain: the chain's head hash plus the
 * range it covers. Anyone holding the full log can recompute this and check
 * it against the anchored receipt.
 */
export interface AnchorPayload {
  agentId: string;
  ownerRef: string;
  rootHash: string;
  recordCount: number;
  fromSeq: number;
  toSeq: number;
  periodStart: string | null;
  periodEnd: string | null;
}

export type Clock = () => Date;

export interface AuditLogOptions {
  agentId: string;
  ownerRef: string;
  clock?: Clock;
}

type HashInput = Omit<AuditRecord, "hash">;

function computeHash(input: HashInput): string {
  return sha256Hex(HASH_DOMAIN + "\n" + canonicalJson(input));
}

/**
 * A hash-chained, append-only audit log for one agent.
 *
 * Every record commits to the hash of the record before it, so editing,
 * reordering, inserting or deleting any historical record breaks the chain
 * at that point and is detected by {@link AuditLog.verifyRecords}. The head
 * hash ("root hash") is what gets anchored on Concordium — see the anchor
 * layer — which additionally makes truncation of the tail detectable.
 */
export class AuditLog {
  readonly agentId: string;
  readonly ownerRef: string;
  private readonly clock: Clock;
  private records: AuditRecord[] = [];

  constructor(options: AuditLogOptions) {
    this.agentId = options.agentId;
    this.ownerRef = options.ownerRef;
    this.clock = options.clock ?? (() => new Date());
  }

  /** Append one action and return the sealed record. */
  append(input: AuditRecordInput): AuditRecord {
    const seq = this.records.length;
    const base: HashInput = {
      seq,
      timestamp: input.timestamp ?? this.clock().toISOString(),
      agentId: this.agentId,
      ownerRef: this.ownerRef,
      actionType: input.actionType,
      actor: input.actor ?? "agent",
      payload: deepCopy(input.payload),
      prevHash: seq === 0 ? GENESIS_HASH : this.records[seq - 1].hash,
    };
    const record: AuditRecord = { ...base, hash: computeHash(base) };
    this.records.push(record);
    return deepCopy(record);
  }

  get length(): number {
    return this.records.length;
  }

  /** The most recent record, or null when the log is empty. */
  head(): AuditRecord | null {
    return this.records.length === 0 ? null : deepCopy(this.records[this.records.length - 1]);
  }

  /** Hash of the head record; GENESIS_HASH when the log is empty. */
  rootHash(): string {
    return this.records.length === 0 ? GENESIS_HASH : this.records[this.records.length - 1].hash;
  }

  /** A deep-copied snapshot of every record, in chain order. */
  list(): AuditRecord[] {
    return deepCopy(this.records);
  }

  /** Verify this log's own chain. */
  verify(): VerifyResult {
    return AuditLog.verifyRecords(this.records);
  }

  /** Build the on-chain anchoring commitment for the current chain state. */
  anchorPayload(): AnchorPayload {
    const count = this.records.length;
    return {
      agentId: this.agentId,
      ownerRef: this.ownerRef,
      rootHash: this.rootHash(),
      recordCount: count,
      fromSeq: 0,
      toSeq: count - 1,
      periodStart: count === 0 ? null : this.records[0].timestamp,
      periodEnd: count === 0 ? null : this.records[count - 1].timestamp,
    };
  }

  toJSON(): { agentId: string; ownerRef: string; records: AuditRecord[] } {
    return { agentId: this.agentId, ownerRef: this.ownerRef, records: this.list() };
  }

  /**
   * Rebuild a log from exported data WITHOUT recomputing any hash — the
   * stored hashes are taken as-is so {@link AuditLog.verify} can judge them.
   */
  static fromJSON(data: { agentId: string; ownerRef: string; records: AuditRecord[] }): AuditLog {
    const log = new AuditLog({ agentId: data.agentId, ownerRef: data.ownerRef });
    log.records = deepCopy(data.records);
    return log;
  }

  /**
   * Verify an arbitrary record array: sequence continuity, prevHash linkage,
   * a single agent/owner identity across the chain, and every record's hash
   * recomputed from its contents.
   */
  static verifyRecords(records: readonly AuditRecord[]): VerifyResult {
    const fail = (seq: number, reason: string): VerifyResult => ({
      ok: false,
      checked: records.length,
      firstBadSeq: seq,
      reason,
    });
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.seq !== i) {
        return fail(i, `seq mismatch: record at position ${i} claims seq ${rec.seq}`);
      }
      const expectedPrev = i === 0 ? GENESIS_HASH : records[i - 1].hash;
      if (rec.prevHash !== expectedPrev) {
        return fail(i, `prevHash mismatch at seq ${i}: chain link is broken`);
      }
      if (rec.agentId !== records[0].agentId || rec.ownerRef !== records[0].ownerRef) {
        return fail(i, `identity mismatch at seq ${i}: agentId/ownerRef differ from the chain head`);
      }
      const { hash, ...rest } = rec;
      if (computeHash(rest) !== hash) {
        return fail(i, `hash mismatch at seq ${i}: record contents were modified after sealing`);
      }
    }
    return { ok: true, checked: records.length, firstBadSeq: null, reason: null };
  }
}
