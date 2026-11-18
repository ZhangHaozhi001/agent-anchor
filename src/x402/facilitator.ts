import {
  X402NotConfiguredError,
  type FacilitatorClient,
  type FetchLike,
  type PaymentPayload,
  type PaymentReceipt,
  type PaymentRequirements,
} from "./types.js";

export interface HttpFacilitatorConfig {
  /** Base URL of the facilitator service, e.g. "https://facilitator.example.com". */
  facilitatorUrl?: string;
}

/**
 * Facilitator client against a real x402 facilitator service over HTTP
 * (the pattern used by Coinbase's facilitator: POST /verify and /settle
 * with `{ paymentPayload, paymentRequirements }`).
 *
 * Configuration-gated like ConcordiumAnchorClient: without a
 * `facilitatorUrl` every call throws {@link X402NotConfiguredError}
 * listing what is missing. The transport is an injected {@link FetchLike},
 * so the same class is testable in-process against the mock facilitator.
 */
export class HttpFacilitatorClient implements FacilitatorClient {
  readonly kind = "http-facilitator";
  private readonly config: HttpFacilitatorConfig;
  private readonly fetchFn: FetchLike;

  constructor(config: HttpFacilitatorConfig, fetchFn: FetchLike) {
    this.config = config;
    this.fetchFn = fetchFn;
  }

  private baseUrl(): string {
    if (!this.config.facilitatorUrl) {
      throw new X402NotConfiguredError("facilitator client", ["facilitatorUrl"]);
    }
    return this.config.facilitatorUrl.replace(/\/+$/, "");
  }

  private async post(
    path: string,
    payment: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<unknown> {
    const res = await this.fetchFn({
      method: "POST",
      url: this.baseUrl() + path,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: payment, paymentRequirements: requirements }),
    });
    if (res.status !== 200) {
      throw new Error(`facilitator ${path} answered HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    }
    return JSON.parse(res.body) as unknown;
  }

  async verify(
    payment: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }> {
    const out = (await this.post("/verify", payment, requirements)) as {
      isValid: boolean;
      invalidReason?: string;
      payer?: string;
    };
    return { isValid: out.isValid, invalidReason: out.invalidReason, payer: out.payer };
  }

  async settle(payment: PaymentPayload, requirements: PaymentRequirements): Promise<PaymentReceipt> {
    const out = (await this.post("/settle", payment, requirements)) as PaymentReceipt & {
      transaction?: string;
    };
    // Facilitator APIs name the settlement hash `transaction`; normalise to txHash.
    return { ...out, txHash: out.txHash ?? out.transaction ?? "", facilitator: this.kind };
  }
}
