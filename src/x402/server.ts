import type { Clock } from "../audit/audit-log.js";
import {
  X402NotConfiguredError,
  decodeHeaderJson,
  encodeHeaderJson,
  type FacilitatorClient,
  type HttpResponse,
  type PaymentPayload,
  type PaymentReceipt,
  type PaymentRequirements,
  type PaymentRequiredBody,
} from "./types.js";

export interface X402ServerConfig {
  /** CAIP-2 network payments are accepted on, e.g. "eip155:8453". No default — must be configured. */
  network?: string;
  /** Token contract address accepted. No default — must be configured. */
  asset?: string;
  /** Address payments go to (the service owner's receiving address). No default — must be configured. */
  payTo?: string;
  /** Verifies and settles payments. */
  facilitator?: FacilitatorClient;
  /** EIP-712 token domain, advertised in challenges for EIP-3009 signing. */
  tokenName?: string;
  tokenVersion?: string;
}

export type PaymentRejectionReason =
  | "missing-payment"
  | "malformed-payment"
  | "requirement-mismatch"
  | "amount-mismatch"
  | "authorization-expired"
  | "authorization-not-yet-valid"
  | "replay"
  | "facilitator-rejected";

export type SettleOutcome =
  | { ok: true; receipt: PaymentReceipt }
  | { ok: false; reason: PaymentRejectionReason; detail: string; response: HttpResponse };

/**
 * Server side of the x402 flow: issue 402 challenges for priced resources
 * and settle incoming payments through the facilitator.
 *
 * Defence order in {@link X402PaymentGate.settlePayment} (cheap, local
 * checks first — the facilitator is only called for a payment that is
 * structurally right):
 *   1. header present and decodable;
 *   2. scheme/network/asset/recipient match the issued requirement;
 *   3. authorized amount equals the required amount exactly;
 *   4. authorization window covers now (not expired, not early);
 *   5. nonce never settled here before (replay), then facilitator
 *      verify + settle (the facilitator enforces its own nonce registry).
 *
 * Framework-agnostic: it consumes/produces the plain {@link HttpResponse}
 * shape, so it drops into any HTTP stack via a thin adapter.
 */
export class X402PaymentGate {
  private readonly config: X402ServerConfig;
  private readonly clock: Clock;
  private readonly settledNonces = new Set<string>();

  constructor(config: X402ServerConfig, clock: Clock = () => new Date()) {
    this.config = config;
    this.clock = clock;
  }

  private requireConfig(): Required<
    Pick<X402ServerConfig, "network" | "asset" | "payTo" | "facilitator">
  > &
    X402ServerConfig {
    const missing: string[] = [];
    if (!this.config.network) missing.push("network");
    if (!this.config.asset) missing.push("asset");
    if (!this.config.payTo) missing.push("payTo (receiving address)");
    if (!this.config.facilitator) missing.push("facilitator");
    if (missing.length > 0) {
      throw new X402NotConfiguredError("payment gate", missing);
    }
    return this.config as Required<Pick<X402ServerConfig, "network" | "asset" | "payTo" | "facilitator">> &
      X402ServerConfig;
  }

  /** Build the payment requirement for one priced resource. Amount is in atomic units. */
  requirementsFor(input: {
    resource: string;
    amountAtomic: string;
    description: string;
    maxTimeoutSeconds?: number;
  }): PaymentRequirements {
    const cfg = this.requireConfig();
    return {
      scheme: "exact",
      network: cfg.network,
      asset: cfg.asset,
      payTo: cfg.payTo,
      maxAmountRequired: input.amountAtomic,
      resource: input.resource,
      description: input.description,
      maxTimeoutSeconds: input.maxTimeoutSeconds ?? 300,
      extra:
        cfg.tokenName && cfg.tokenVersion
          ? { name: cfg.tokenName, version: cfg.tokenVersion }
          : undefined,
    };
  }

  /** The HTTP 402 challenge response advertising the given requirements. */
  challenge(requirements: PaymentRequirements[], error = "payment required"): HttpResponse {
    const body: PaymentRequiredBody = { x402Version: 2, error, accepts: requirements };
    return {
      status: 402,
      headers: {
        "content-type": "application/json",
        "payment-required": encodeHeaderJson(body),
      },
      body: JSON.stringify(body),
    };
  }

  private reject(
    requirements: PaymentRequirements,
    reason: PaymentRejectionReason,
    detail: string,
  ): SettleOutcome {
    return {
      ok: false,
      reason,
      detail,
      response: this.challenge([requirements], `${reason}: ${detail}`),
    };
  }

  /**
   * Verify + settle the payment carried by an X-PAYMENT header value
   * against the requirement it claims to pay. On success the caller
   * should serve the resource and attach {@link X402PaymentGate.settlementHeaders}.
   */
  async settlePayment(
    paymentHeader: string | undefined,
    requirements: PaymentRequirements,
  ): Promise<SettleOutcome> {
    const cfg = this.requireConfig();
    if (!paymentHeader) {
      return this.reject(requirements, "missing-payment", "no X-PAYMENT header on the request");
    }
    const payment = decodeHeaderJson<PaymentPayload>(paymentHeader);
    if (!payment || !payment.payload || !payment.payload.authorization) {
      return this.reject(requirements, "malformed-payment", "X-PAYMENT header is not a decodable payment payload");
    }
    const auth = payment.payload.authorization;
    if (
      payment.scheme !== requirements.scheme ||
      payment.network !== requirements.network ||
      auth.to !== requirements.payTo
    ) {
      return this.reject(
        requirements,
        "requirement-mismatch",
        `payment is for scheme=${payment.scheme} network=${payment.network} to=${auth.to}, ` +
          `expected scheme=${requirements.scheme} network=${requirements.network} to=${requirements.payTo}`,
      );
    }
    if (auth.value !== requirements.maxAmountRequired) {
      return this.reject(
        requirements,
        "amount-mismatch",
        `authorized ${auth.value} atomic units, required exactly ${requirements.maxAmountRequired}`,
      );
    }
    const now = BigInt(Math.floor(this.clock().getTime() / 1000));
    if (BigInt(auth.validBefore) <= now) {
      return this.reject(
        requirements,
        "authorization-expired",
        `authorization validBefore ${auth.validBefore} is not after now ${now.toString()}`,
      );
    }
    if (BigInt(auth.validAfter) > now) {
      return this.reject(
        requirements,
        "authorization-not-yet-valid",
        `authorization validAfter ${auth.validAfter} is after now ${now.toString()}`,
      );
    }
    if (this.settledNonces.has(auth.nonce)) {
      return this.reject(requirements, "replay", `authorization nonce ${auth.nonce} was already settled here`);
    }
    const verdict = await cfg.facilitator.verify(payment, requirements);
    if (!verdict.isValid) {
      const reason: PaymentRejectionReason =
        verdict.invalidReason && verdict.invalidReason.includes("already used") ? "replay" : "facilitator-rejected";
      return this.reject(requirements, reason, verdict.invalidReason ?? "facilitator rejected the payment");
    }
    const receipt = await cfg.facilitator.settle(payment, requirements);
    this.settledNonces.add(auth.nonce);
    return { ok: true, receipt };
  }

  /** Headers carrying the settlement proof for a successful response (PAYMENT-RESPONSE). */
  settlementHeaders(receipt: PaymentReceipt): Record<string, string> {
    return { "payment-response": encodeHeaderJson(receipt) };
  }
}
