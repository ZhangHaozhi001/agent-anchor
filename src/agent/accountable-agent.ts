import { AuditLog, type AuditRecord, type Clock, type JsonValue } from "../audit/audit-log.js";

/**
 * Who the agent is, for accountability purposes. `ownerRef` is the link to
 * the accountable human: a reference to the identity they verified once
 * with a Concordium identity provider (never the personal data itself).
 * `homeChainAddress` is the address the agent already uses on its home
 * chain — the one its ERC-8004 Agent Card in the Concordium Agent Registry
 * points back to.
 */
export interface AgentIdentity {
  agentId: string;
  ownerRef: string;
  homeChainAddress?: string;
}

/**
 * An agent whose every action is written into a hash-chained audit log the
 * moment it happens. Semantic helpers cover the action types the demo and
 * the hackathon story exercise; {@link AccountableAgent.perform} records
 * anything else.
 */
export class AccountableAgent {
  readonly identity: AgentIdentity;
  readonly log: AuditLog;

  constructor(identity: AgentIdentity, clock?: Clock) {
    this.identity = identity;
    this.log = new AuditLog({ agentId: identity.agentId, ownerRef: identity.ownerRef, clock });
  }

  /** Record an arbitrary action. */
  perform(actionType: string, payload: Record<string, JsonValue>): AuditRecord {
    return this.log.append({ actionType, payload, actor: "agent" });
  }

  /** Record checking a counterparty's "Verified by Concordium" badge before dealing with it. */
  recordBadgeChecked(input: { counterparty: string; result: "verified" | "unverified" | "rejected" }): AuditRecord {
    return this.perform("registry.badge_checked", { ...input });
  }

  /**
   * Record presenting a zero-knowledge attribute proof about the accountable
   * owner (e.g. "verified adult in a permitted jurisdiction") — the proof
   * type and verifier are logged, the underlying identity is not.
   */
  recordAttributeProofPresented(input: { proofType: string; verifier: string }): AuditRecord {
    return this.perform("identity.attribute_proof_presented", { ...input });
  }

  /** Record an outgoing x402 payment. Amounts are decimal strings. */
  recordPaymentSent(input: { amount: string; asset: string; to: string; rail: string; sponsored: boolean }): AuditRecord {
    return this.perform("payment.sent", { ...input });
  }

  /** Record an incoming x402 payment. Amounts are decimal strings. */
  recordPaymentReceived(input: { amount: string; asset: string; from: string; rail: string; sponsored: boolean }): AuditRecord {
    return this.perform("payment.received", { ...input });
  }
}
