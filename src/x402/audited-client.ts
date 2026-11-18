import type { AccountableAgent } from "../agent/accountable-agent.js";
import type { AuditRecord } from "../audit/audit-log.js";
import { X402PaymentClient, type PaidCallResult } from "./client.js";
import { proofRefFromReceipt, type PaymentReceipt } from "./types.js";

/**
 * The bridge between the x402 payment layer and the audit log — the point
 * of AgentAnchor: a payment an agent makes is not just executed, it is
 * *accounted for*, in the hash chain, with the settlement proof attached.
 *
 * Outgoing: {@link AuditedPaymentClient.fetchPaid} runs a paid call and,
 * the moment it settles, appends a `payment.sent` record whose payload
 * carries `paymentProof` (settlement tx hash + network + facilitator +
 * settlement time). Incoming: {@link recordSettledPaymentReceived} does
 * the same for a payment the agent's own gate settled. The Article 12
 * exporter surfaces the proof next to the event, so a compliance reader
 * sees evidence, not just a claim.
 */
export class AuditedPaymentClient {
  private readonly agent: AccountableAgent;
  private readonly client: X402PaymentClient;

  constructor(agent: AccountableAgent, client: X402PaymentClient) {
    this.agent = agent;
    this.client = client;
  }

  /** Perform a paid call and record it in the agent's audit log with its settlement proof. */
  async fetchPaid(
    url: string,
    init?: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ result: PaidCallResult; record: AuditRecord | null }> {
    const result = await this.client.fetchPaid(url, init);
    if (result.requirements === null || result.payment === null) {
      return { result, record: null }; // resource was free — nothing to account for
    }
    const record = this.agent.recordPaymentSent({
      amount: result.requirements.maxAmountRequired,
      asset: result.requirements.asset,
      to: result.requirements.payTo,
      rail: "x402",
      sponsored: true, // EIP-3009 settlement is gasless for the payer by construction
      resource: url,
      paymentProof: result.receipt ? proofRefFromReceipt(result.receipt) : undefined,
    });
    return { result, record };
  }
}

/**
 * Record an incoming settled payment (the agent's own priced resource was
 * paid through its gate) with the settlement proof attached.
 */
export function recordSettledPaymentReceived(
  agent: AccountableAgent,
  receipt: PaymentReceipt,
  input: { resource: string },
): AuditRecord {
  return agent.recordPaymentReceived({
    amount: receipt.amount,
    asset: receipt.asset,
    from: receipt.payer,
    rail: "x402",
    sponsored: true,
    resource: input.resource,
    paymentProof: proofRefFromReceipt(receipt),
  });
}
