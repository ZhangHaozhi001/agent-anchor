import { HASH_DOMAIN, canonicalJson } from "./hash.js";
import type { AuditLog, VerifyResult } from "./audit-log.js";

/**
 * EU AI Act Article 12 requires high-risk AI systems to keep logs that allow
 * traceability of their operation: what happened, when, and under whose
 * responsibility. AgentAnchor's export renders the hash-chained audit log in
 * exactly that shape — one event per record, with the chain's integrity
 * verdict attached so a compliance team can file it as evidence.
 */
export interface Article12Event {
  seq: number;
  /** ISO 8601 time of the event. */
  dateTime: string;
  /** The recorded action, e.g. "payment.sent". */
  event: string;
  /** Who performed the action ("agent", "owner", or a counterparty id). */
  actor: string;
  /** Structured details of the event. */
  details: Record<string, unknown>;
  /**
   * Settlement evidence for payment events, extracted from the record's
   * `paymentProof` payload field (settlement tx hash, network,
   * facilitator, settlement time); absent for non-payment events and for
   * payments recorded without proof.
   */
  paymentProof?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface Article12Export {
  recordType: string;
  /** The record-keeping duty this export is modelled on. */
  standard: string;
  generatedAt: string;
  system: {
    name: string;
    agentId: string;
    /** Reference to the verified, accountable human behind the agent. */
    accountableOwnerRef: string;
    ownerNote: string;
  };
  period: { start: string | null; end: string | null };
  integrity: {
    algorithm: string;
    hashDomain: string;
    recordCount: number;
    /** Head hash of the chain — the value anchored on Concordium. */
    rootHash: string;
    chainVerified: boolean;
    verification: VerifyResult;
  };
  events: Article12Event[];
}

export interface ExportOptions {
  /** ISO 8601 generation time; defaults to now. Inject in tests for determinism. */
  generatedAt?: string;
}

export function exportArticle12Json(log: AuditLog, options: ExportOptions = {}): Article12Export {
  const records = log.list();
  const verification = log.verify();
  return {
    recordType: "AgentAnchor audit record export",
    standard: "EU AI Act Article 12 (record-keeping of events) — style",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    system: {
      name: "AgentAnchor",
      agentId: log.agentId,
      accountableOwnerRef: log.ownerRef,
      ownerNote:
        "The accountable owner verified their identity once with a Concordium identity provider. " +
        "This export carries only the identity reference — no personal data.",
    },
    period: {
      start: records.length === 0 ? null : records[0].timestamp,
      end: records.length === 0 ? null : records[records.length - 1].timestamp,
    },
    integrity: {
      algorithm: "SHA-256",
      hashDomain: HASH_DOMAIN,
      recordCount: records.length,
      rootHash: log.rootHash(),
      chainVerified: verification.ok,
      verification,
    },
    events: records.map((rec) => {
      const proof = rec.payload["paymentProof"];
      return {
        seq: rec.seq,
        dateTime: rec.timestamp,
        event: rec.actionType,
        actor: rec.actor,
        details: rec.payload,
        ...(typeof proof === "object" && proof !== null && !Array.isArray(proof)
          ? { paymentProof: proof as Record<string, unknown> }
          : {}),
        prevHash: rec.prevHash,
        hash: rec.hash,
      };
    }),
  };
}

/** Human-readable rendering of the same export, for filing or attaching to a report. */
export function exportArticle12Text(log: AuditLog, options: ExportOptions = {}): string {
  const data = exportArticle12Json(log, options);
  const lines: string[] = [];
  lines.push("AgentAnchor — Audit Record Export");
  lines.push("Modelled on: EU AI Act Article 12 (record-keeping of events)");
  lines.push(`Generated: ${data.generatedAt}`);
  lines.push(`Agent: ${data.system.agentId}`);
  lines.push(`Accountable owner (identity reference): ${data.system.accountableOwnerRef}`);
  lines.push(`Period: ${data.period.start ?? "—"} to ${data.period.end ?? "—"}`);
  lines.push(
    `Integrity: SHA-256 hash chain, ${data.integrity.recordCount} records, root hash ${data.integrity.rootHash}`,
  );
  lines.push(
    data.integrity.chainVerified
      ? `Chain verification: OK — all ${data.integrity.recordCount} records verified, chain intact.`
      : `Chain verification: FAILED at seq ${data.integrity.verification.firstBadSeq} — ${data.integrity.verification.reason}`,
  );
  lines.push("");
  lines.push("Events:");
  for (const ev of data.events) {
    const proofSuffix = ev.paymentProof
      ? `  proof tx=${String(ev.paymentProof["txHash"])} network=${String(ev.paymentProof["network"])} facilitator=${String(ev.paymentProof["facilitator"])} settledAt=${String(ev.paymentProof["settledAt"])}`
      : "";
    lines.push(
      `#${String(ev.seq).padStart(4, "0")}  ${ev.dateTime}  ${ev.event}  actor=${ev.actor}  ` +
        `hash=${ev.hash}  prev=${ev.prevHash}  details=${canonicalJson(ev.details)}${proofSuffix}`,
    );
  }
  return lines.join("\n") + "\n";
}
