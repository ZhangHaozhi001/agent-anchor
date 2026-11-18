import type { Clock } from "../audit/audit-log.js";

/**
 * x402 payment layer — protocol types.
 *
 * x402 (as exercised live against Blockchain IQ's API on Base, see the
 * project notes) works like this: an unpaid request is answered with
 * HTTP 402 and a set of {@link PaymentRequirements}; the payer signs an
 * EIP-3009 `transferWithAuthorization` for exactly the required amount
 * (gasless for the payer — a facilitator submits the transaction and pays
 * the gas), retries with the signed payload in the `X-PAYMENT` header,
 * and the server verifies + settles through the facilitator, returning
 * the settlement proof in the `PAYMENT-RESPONSE` header.
 *
 * Amounts are always atomic-unit decimal strings (e.g. USDC has 6
 * decimals, so "10000" is 0.01 USDC) — never floats.
 */

/** Minimal HTTP shapes so the layer stays framework-agnostic (no express/fetch lock-in). */
export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Anything that can carry an {@link HttpRequest} — a real fetch adapter or an in-process fake. */
export type FetchLike = (req: HttpRequest) => Promise<HttpResponse>;

/** One acceptable way to pay for a resource, as advertised in a 402 challenge. */
export interface PaymentRequirements {
  /** Payment scheme; this layer implements "exact" (pay the exact amount). */
  scheme: string;
  /** CAIP-2 network id, e.g. "eip155:8453" (Base). */
  network: string;
  /** Token contract address on that network. */
  asset: string;
  /** Recipient of the payment. */
  payTo: string;
  /** Exact amount to pay, in atomic units, as a decimal string. */
  maxAmountRequired: string;
  /** The resource being paid for (URL or identifier). */
  resource: string;
  description: string;
  /** Seconds the signed authorization stays valid. */
  maxTimeoutSeconds: number;
  /** EIP-712 domain of the token (name/version), needed for EIP-3009 signatures. */
  extra?: { name: string; version: string };
}

/** Body of an HTTP 402 response (x402 v2 shape). */
export interface PaymentRequiredBody {
  x402Version: number;
  error?: string;
  accepts: PaymentRequirements[];
}

/** EIP-3009 transferWithAuthorization parameters. Times are unix seconds, as decimal strings. */
export interface TransferAuthorization {
  from: string;
  to: string;
  /** Atomic-unit amount, decimal string. */
  value: string;
  validAfter: string;
  validBefore: string;
  /** Random 32-byte hex nonce — single-use, this is the replay protection. */
  nonce: string;
}

/** The signed payment the client sends back in the X-PAYMENT header (base64-encoded JSON). */
export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: string;
    authorization: TransferAuthorization;
  };
}

/** Settlement proof returned by the facilitator after a successful settle. */
export interface PaymentReceipt {
  success: true;
  /** On-chain settlement transaction hash — the payment evidence. */
  txHash: string;
  network: string;
  payer: string;
  payTo: string;
  /** Atomic-unit amount, decimal string. */
  amount: string;
  asset: string;
  /** ISO 8601 settlement time. */
  settledAt: string;
  /** Which facilitator settled it (its `kind`). */
  facilitator: string;
}

/**
 * The payment-evidence reference stored inside audit-log payloads
 * (payload key `paymentProof`), so an Article 12 export can show *proof*
 * of payment next to the recorded action, not just a claim that it happened.
 */
export type PaymentProofRef = {
  txHash: string;
  network: string;
  facilitator: string;
  settledAt: string;
};

/** Extract the audit-storable proof reference from a full settlement receipt. */
export function proofRefFromReceipt(receipt: PaymentReceipt): PaymentProofRef {
  return {
    txHash: receipt.txHash,
    network: receipt.network,
    facilitator: receipt.facilitator,
    settledAt: receipt.settledAt,
  };
}

/**
 * Thrown when an x402 component is used before its configuration exists.
 * Mirrors AnchorNotConfiguredError: the missing items are listed by name so
 * the wiring step knows exactly what to supply. Nothing in this layer
 * silently defaults to a placeholder network, token or address.
 */
export class X402NotConfiguredError extends Error {
  readonly missing: string[];
  constructor(component: string, missing: string[]) {
    super(
      `x402 ${component} is not configured — missing: ` +
        missing.join(", ") +
        ". Network, asset, recipient and signer come from deployment configuration " +
        "(the payer's wallet step); use the mock facilitator/signer for local runs until then.",
    );
    this.name = "X402NotConfiguredError";
    this.missing = missing;
  }
}

export type X402PaymentErrorCode =
  | "invalid-challenge"
  | "no-matching-requirement"
  | "amount-exceeds-cap"
  | "payment-rejected"
  | "unexpected-status";

/** A payment flow failure with a machine-readable code. */
export class X402PaymentError extends Error {
  readonly code: X402PaymentErrorCode;
  constructor(code: X402PaymentErrorCode, message: string) {
    super(message);
    this.name = "X402PaymentError";
    this.code = code;
  }
}

/**
 * Signs EIP-3009 authorizations. This is the seam where a real wallet
 * (viem/ethers + the agent's key, held outside this layer) plugs in; the
 * layer itself never holds a private key.
 */
export interface PaymentSigner {
  /** The payer address authorizations are signed for. */
  readonly address: string;
  signAuthorization(input: {
    requirements: PaymentRequirements;
    validAfter: string;
    validBefore: string;
    nonce: string;
  }): Promise<{ authorization: TransferAuthorization; signature: string }>;
}

/**
 * The facilitator verifies signed payloads and settles them on-chain
 * (submitting the EIP-3009 transfer and paying the gas). Implementations:
 * {@link MockFacilitatorClient} locally, {@link HttpFacilitatorClient}
 * against a real facilitator service (e.g. Coinbase's) over HTTP.
 */
export interface FacilitatorClient {
  readonly kind: string;
  verify(
    payment: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>;
  settle(payment: PaymentPayload, requirements: PaymentRequirements): Promise<PaymentReceipt>;
}

export type { Clock };

/** base64-encode a JSON value for an x402 header (X-PAYMENT / PAYMENT-REQUIRED / PAYMENT-RESPONSE). */
export function encodeHeaderJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** Decode a base64 JSON x402 header; returns null on any malformed input instead of throwing. */
export function decodeHeaderJson<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** Case-insensitive header lookup over the plain-object header shape used in this layer. */
export function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}
