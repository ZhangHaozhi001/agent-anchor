import type { Clock } from "../audit/audit-log.js";
import { newNonce } from "./mock-facilitator.js";
import {
  X402NotConfiguredError,
  X402PaymentError,
  decodeHeaderJson,
  encodeHeaderJson,
  getHeader,
  type FetchLike,
  type HttpRequest,
  type HttpResponse,
  type PaymentPayload,
  type PaymentReceipt,
  type PaymentRequirements,
  type PaymentSigner,
  type PaymentRequiredBody,
} from "./types.js";

export interface X402ClientConfig {
  /** CAIP-2 network the payer will pay on, e.g. "eip155:8453". No default — must be configured. */
  network?: string;
  /** Token contract address the payer will pay with. No default — must be configured. */
  asset?: string;
  /** Signs EIP-3009 authorizations (the payer wallet seam). */
  signer?: PaymentSigner;
  /**
   * Spend control, in atomic units: the client refuses to sign for any
   * challenge asking more than this (the `maxAmountPerPayment` guard from
   * the reference x402 integrations).
   */
  maxAmountPerPayment?: string;
}

/** States of one paid call, in the order a successful flow visits them. */
export type PaymentFlowState =
  | "idle"
  | "challenge-received"
  | "authorization-signed"
  | "retrying"
  | "settled"
  | "failed";

export interface PaidCallResult {
  /** The successful (HTTP 200) response from the paid resource. */
  response: HttpResponse;
  /** The requirement that was paid, or null when the resource answered 200 without a challenge. */
  requirements: PaymentRequirements | null;
  /** The signed payment that was sent on the retry, or null when no payment was needed. */
  payment: PaymentPayload | null;
  /** Settlement proof decoded from the PAYMENT-RESPONSE header, or null if the server sent none. */
  receipt: PaymentReceipt | null;
  /** Every state the flow passed through, in order — the state-machine trace. */
  states: PaymentFlowState[];
}

/**
 * Client side of the x402 flow, as an explicit state machine:
 *
 *   idle ──request──▶ (200: done, no payment needed)
 *        └─request──▶ (402) challenge-received ──sign──▶ authorization-signed
 *                        │                                    │
 *                        │ no matching requirement /          ▼
 *                        │ amount over cap ──▶ failed      retrying ──200──▶ settled
 *                        │                                    │
 *                        └──────────── 402 again / error ──▶ failed
 *
 * The payer never holds gas: the signed EIP-3009 authorization is settled
 * by the server's facilitator. This class never holds a private key — it
 * delegates signing to the injected {@link PaymentSigner}.
 */
export class X402PaymentClient {
  private readonly config: X402ClientConfig;
  private readonly fetchFn: FetchLike;
  private readonly clock: Clock;

  constructor(config: X402ClientConfig, fetchFn: FetchLike, clock: Clock = () => new Date()) {
    this.config = config;
    this.fetchFn = fetchFn;
    this.clock = clock;
  }

  private requireConfig(): Required<Pick<X402ClientConfig, "network" | "asset" | "signer">> &
    X402ClientConfig {
    const missing: string[] = [];
    if (!this.config.network) missing.push("network");
    if (!this.config.asset) missing.push("asset");
    if (!this.config.signer) missing.push("signer (payer wallet)");
    if (missing.length > 0) {
      throw new X402NotConfiguredError("payment client", missing);
    }
    return this.config as Required<Pick<X402ClientConfig, "network" | "asset" | "signer">> &
      X402ClientConfig;
  }

  /** Perform one paid call: request, answer a 402 challenge if any, retry with the signed payment. */
  async fetchPaid(url: string, init: Omit<HttpRequest, "url"> = { method: "GET", headers: {} }): Promise<PaidCallResult> {
    const cfg = this.requireConfig();
    const states: PaymentFlowState[] = ["idle"];
    try {
      const first = await this.fetchFn({ ...init, url });
      if (first.status === 200) {
        states.push("settled");
        return { response: first, requirements: null, payment: null, receipt: null, states };
      }
      if (first.status !== 402) {
        throw new X402PaymentError(
          "unexpected-status",
          `paid call to ${url} answered HTTP ${first.status} (expected 200 or 402)`,
        );
      }
      states.push("challenge-received");

      const challenge =
        decodeHeaderJson<PaymentRequiredBody>(getHeader(first.headers, "payment-required")) ??
        (first.body ? (JSON.parse(first.body) as PaymentRequiredBody) : null);
      if (!challenge || !Array.isArray(challenge.accepts) || challenge.accepts.length === 0) {
        throw new X402PaymentError("invalid-challenge", `402 from ${url} carried no usable payment requirements`);
      }
      const requirements = challenge.accepts.find(
        (r) => r.network === cfg.network && r.asset === cfg.asset && r.scheme === "exact",
      );
      if (!requirements) {
        throw new X402PaymentError(
          "no-matching-requirement",
          `402 from ${url} offers no "exact" requirement on ${cfg.network} for asset ${cfg.asset}`,
        );
      }
      if (
        cfg.maxAmountPerPayment !== undefined &&
        BigInt(requirements.maxAmountRequired) > BigInt(cfg.maxAmountPerPayment)
      ) {
        throw new X402PaymentError(
          "amount-exceeds-cap",
          `challenge asks ${requirements.maxAmountRequired} atomic units, above the configured cap ${cfg.maxAmountPerPayment}`,
        );
      }

      const nowSec = Math.floor(this.clock().getTime() / 1000);
      const { authorization, signature } = await cfg.signer.signAuthorization({
        requirements,
        validAfter: String(nowSec - 60),
        validBefore: String(nowSec + requirements.maxTimeoutSeconds),
        nonce: newNonce(),
      });
      const payment: PaymentPayload = {
        x402Version: challenge.x402Version ?? 2,
        scheme: requirements.scheme,
        network: requirements.network,
        payload: { signature, authorization },
      };
      states.push("authorization-signed");

      states.push("retrying");
      const second = await this.fetchFn({
        ...init,
        url,
        headers: { ...init.headers, "x-payment": encodeHeaderJson(payment) },
      });
      if (second.status === 402) {
        const body = second.body ? (JSON.parse(second.body) as PaymentRequiredBody) : null;
        throw new X402PaymentError(
          "payment-rejected",
          `server rejected the payment for ${url}: ${body?.error ?? "still 402 after payment"}`,
        );
      }
      if (second.status !== 200) {
        throw new X402PaymentError(
          "unexpected-status",
          `paid retry to ${url} answered HTTP ${second.status} (expected 200)`,
        );
      }
      const receipt = decodeHeaderJson<PaymentReceipt>(getHeader(second.headers, "payment-response"));
      states.push("settled");
      return { response: second, requirements, payment, receipt, states };
    } catch (err) {
      states.push("failed");
      throw err;
    }
  }
}
