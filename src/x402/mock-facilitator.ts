import { randomBytes } from "node:crypto";
import { canonicalJson, sha256Hex } from "../audit/hash.js";
import type { Clock } from "../audit/audit-log.js";
import type {
  FacilitatorClient,
  PaymentPayload,
  PaymentReceipt,
  PaymentRequirements,
  PaymentSigner,
  TransferAuthorization,
} from "./types.js";

/**
 * Local simulations for the x402 payment layer — the equivalent of
 * MockAnchorClient for payments. Everything here is deterministic,
 * in-memory and labelled local-simulated; nothing settles on any chain.
 * They exist so the full flow — challenge → sign → verify → settle →
 * audit — runs end to end (and is tested) before the payer's real wallet
 * and a real facilitator exist.
 */

const MOCK_SIGNATURE_DOMAIN = "agentanchor/x402-mock/v1";

function mockSignature(authorization: TransferAuthorization): string {
  return "mock-sig-" + sha256Hex(MOCK_SIGNATURE_DOMAIN + "\n" + canonicalJson(authorization));
}

/**
 * Deterministic stand-in signer. Its "signature" is a hash anyone can
 * recompute — it proves the *flow*, not possession of a key, and says so.
 * The real signer (viem + the agent wallet's key) implements the same
 * {@link PaymentSigner} interface at wiring time.
 */
export class MockPaymentSigner implements PaymentSigner {
  readonly address: string;

  constructor() {
    this.address = "0x" + sha256Hex("agentanchor/mock-signer/v1").slice(0, 40);
  }

  async signAuthorization(input: {
    requirements: PaymentRequirements;
    validAfter: string;
    validBefore: string;
    nonce: string;
  }): Promise<{ authorization: TransferAuthorization; signature: string }> {
    const authorization: TransferAuthorization = {
      from: this.address,
      to: input.requirements.payTo,
      value: input.requirements.maxAmountRequired,
      validAfter: input.validAfter,
      validBefore: input.validBefore,
      nonce: input.nonce,
    };
    return { authorization, signature: mockSignature(authorization) };
  }
}

/**
 * In-memory facilitator: verifies mock signatures, authorization windows
 * and amounts, enforces single-use nonces (replay protection), and
 * "settles" by issuing a deterministic local receipt.
 */
export class MockFacilitatorClient implements FacilitatorClient {
  readonly kind = "mock-facilitator (local-simulated)";
  private readonly clock: Clock;
  private readonly usedNonces = new Set<string>();
  private readonly receipts = new Map<string, PaymentReceipt>();

  constructor(clock: Clock = () => new Date()) {
    this.clock = clock;
  }

  async verify(
    payment: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }> {
    const auth = payment.payload.authorization;
    const fail = (invalidReason: string) => ({ isValid: false, invalidReason });
    if (payment.scheme !== requirements.scheme || payment.network !== requirements.network) {
      return fail("scheme/network do not match the requirements");
    }
    if (auth.to !== requirements.payTo) {
      return fail(`authorization recipient ${auth.to} does not match payTo ${requirements.payTo}`);
    }
    if (auth.value !== requirements.maxAmountRequired) {
      return fail(
        `authorization value ${auth.value} does not match required amount ${requirements.maxAmountRequired}`,
      );
    }
    const now = Math.floor(this.clock().getTime() / 1000);
    if (BigInt(auth.validBefore) <= BigInt(now)) {
      return fail("authorization expired (validBefore is in the past)");
    }
    if (BigInt(auth.validAfter) > BigInt(now)) {
      return fail("authorization not yet valid (validAfter is in the future)");
    }
    if (this.usedNonces.has(auth.nonce)) {
      return fail("authorization nonce already used (replay)");
    }
    if (payment.payload.signature !== mockSignature(auth)) {
      return fail("signature does not match the authorization (mock signature check)");
    }
    return { isValid: true, payer: auth.from };
  }

  async settle(payment: PaymentPayload, requirements: PaymentRequirements): Promise<PaymentReceipt> {
    const verdict = await this.verify(payment, requirements);
    if (!verdict.isValid) {
      throw new Error(`mock facilitator refuses to settle: ${verdict.invalidReason}`);
    }
    const auth = payment.payload.authorization;
    this.usedNonces.add(auth.nonce);
    const txHash =
      "0x" +
      sha256Hex(
        `agentanchor/x402-settle/v1\n${auth.nonce}\n${auth.from}\n${auth.to}\n${auth.value}`,
      );
    const receipt: PaymentReceipt = {
      success: true,
      txHash,
      network: requirements.network,
      payer: auth.from,
      payTo: auth.to,
      amount: auth.value,
      asset: requirements.asset,
      settledAt: this.clock().toISOString(),
      facilitator: this.kind,
    };
    this.receipts.set(txHash, receipt);
    return { ...receipt };
  }

  /** Fetch a previously issued mock settlement receipt by tx hash, or null. */
  async getReceipt(txHash: string): Promise<PaymentReceipt | null> {
    const receipt = this.receipts.get(txHash);
    return receipt ? { ...receipt } : null;
  }
}

/** Fresh single-use authorization nonce (32 random bytes, 0x-prefixed hex). */
export function newNonce(): string {
  return "0x" + randomBytes(32).toString("hex");
}
