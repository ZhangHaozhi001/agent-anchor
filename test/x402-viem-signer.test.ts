import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountableAgent,
  AuditedPaymentClient,
  ViemPaymentSigner,
  X402NotConfiguredError,
  X402PaymentClient,
  X402PaymentError,
  X402PaymentGate,
  chainIdFromNetwork,
  getHeader,
  sha256Hex,
  verifyTransferAuthorization,
  type FacilitatorClient,
  type FetchLike,
  type HttpResponse,
  type PaymentPayload,
  type PaymentReceipt,
  type PaymentRequirements,
} from "../src/index.js";
import { RESOURCE_BODY, RESOURCE_URL, TEST_ASSET, TEST_NETWORK, TEST_PAYTO, TEST_PRICE, makeClock } from "./x402-helpers.js";

// The well-known Hardhat/Anvil default account #0 — a public test vector
// printed in every local-dev tool's docs. It holds no funds anywhere that
// matters and exists here only so signatures are deterministic to check.
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// A second throwaway key (Hardhat account #1, also a public test vector).
const OTHER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const REQUIREMENTS: PaymentRequirements = {
  scheme: "exact",
  network: TEST_NETWORK,
  asset: TEST_ASSET,
  payTo: TEST_PAYTO,
  maxAmountRequired: TEST_PRICE,
  resource: RESOURCE_URL,
  description: "One paid brief",
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
};
const NONCE = "0x" + "ab".repeat(32);

test("viem signer: missing key/account is a configuration error listing what is missing", () => {
  assert.throws(
    () => new ViemPaymentSigner({}),
    (err: unknown) => {
      assert.ok(err instanceof X402NotConfiguredError);
      assert.match(err.missing.join(","), /privateKey/);
      return true;
    },
  );
});

test("viem signer: the payer address is derived from the injected key", () => {
  const signer = new ViemPaymentSigner({ privateKey: TEST_PRIVATE_KEY });
  assert.equal(signer.address, TEST_ADDRESS);
});

test("viem signer: signs a real EIP-3009 authorization that verifies offline", async () => {
  const signer = new ViemPaymentSigner({ privateKey: TEST_PRIVATE_KEY });
  const { authorization, signature } = await signer.signAuthorization({
    requirements: REQUIREMENTS,
    validAfter: "1767225600",
    validBefore: "1767225900",
    nonce: NONCE,
  });
  assert.equal(authorization.from, TEST_ADDRESS);
  assert.equal(authorization.to, TEST_PAYTO);
  assert.equal(authorization.value, TEST_PRICE);
  assert.equal(authorization.validAfter, "1767225600");
  assert.equal(authorization.validBefore, "1767225900");
  assert.equal(authorization.nonce, NONCE);
  assert.match(signature, /^0x[0-9a-fA-F]{130}$/);

  const ok = await verifyTransferAuthorization({ requirements: REQUIREMENTS, authorization, signature });
  assert.equal(ok, true);
});

test("viem signer: tampered amounts and foreign signatures do not verify", async () => {
  const signer = new ViemPaymentSigner({ privateKey: TEST_PRIVATE_KEY });
  const { authorization, signature } = await signer.signAuthorization({
    requirements: REQUIREMENTS,
    validAfter: "1767225600",
    validBefore: "1767225900",
    nonce: NONCE,
  });
  const tampered = { ...authorization, value: "1" };
  assert.equal(
    await verifyTransferAuthorization({ requirements: REQUIREMENTS, authorization: tampered, signature }),
    false,
  );

  const other = new ViemPaymentSigner({ privateKey: OTHER_PRIVATE_KEY });
  const foreign = await other.signAuthorization({
    requirements: REQUIREMENTS,
    validAfter: "1767225600",
    validBefore: "1767225900",
    nonce: NONCE,
  });
  // The foreign signature is genuine — but for the other account, not for `from`.
  const claimed = { ...foreign.authorization, from: TEST_ADDRESS };
  assert.equal(
    await verifyTransferAuthorization({ requirements: REQUIREMENTS, authorization: claimed, signature: foreign.signature }),
    false,
  );
});

test("viem signer: a challenge without the token EIP-712 domain is a configuration error", async () => {
  const signer = new ViemPaymentSigner({ privateKey: TEST_PRIVATE_KEY });
  const { extra: _extra, ...noDomain } = REQUIREMENTS;
  await assert.rejects(
    signer.signAuthorization({
      requirements: noDomain,
      validAfter: "1767225600",
      validBefore: "1767225900",
      nonce: NONCE,
    }),
    (err: unknown) => {
      assert.ok(err instanceof X402NotConfiguredError);
      assert.match(err.missing.join(","), /EIP-712 domain/);
      return true;
    },
  );
});

test("viem signer: malformed nonce and non-EVM network are rejected", async () => {
  const signer = new ViemPaymentSigner({ privateKey: TEST_PRIVATE_KEY });
  await assert.rejects(
    signer.signAuthorization({
      requirements: REQUIREMENTS,
      validAfter: "1767225600",
      validBefore: "1767225900",
      nonce: "0x1234",
    }),
    (err: unknown) => err instanceof X402PaymentError && err.code === "invalid-challenge",
  );
  assert.throws(() => chainIdFromNetwork("solana:mainnet"), /eip155/);
  assert.equal(chainIdFromNetwork("eip155:8453"), 8453);
});

/**
 * A facilitator test double that — unlike the mock — performs the *real*
 * EIP-3009 signature verification (offline, via viem) plus amount/window
 * checks and single-use nonce enforcement, then issues a deterministic
 * local receipt. It proves the real signer interoperates with the client
 * state machine and the server gate; it does not settle on any chain.
 */
class VerifyingFacilitator implements FacilitatorClient {
  readonly kind = "test-verifying-facilitator (offline, real signature checks)";
  private readonly usedNonces = new Set<string>();
  private readonly clock: () => Date;

  constructor(clock: () => Date) {
    this.clock = clock;
  }

  async verify(
    payment: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }> {
    const auth = payment.payload.authorization;
    const fail = (invalidReason: string) => ({ isValid: false, invalidReason });
    if (auth.to !== requirements.payTo) return fail("recipient mismatch");
    if (auth.value !== requirements.maxAmountRequired) return fail("amount mismatch");
    const now = Math.floor(this.clock().getTime() / 1000);
    if (BigInt(auth.validBefore) <= BigInt(now)) return fail("authorization expired");
    if (BigInt(auth.validAfter) > BigInt(now)) return fail("authorization not yet valid");
    if (this.usedNonces.has(auth.nonce)) return fail("authorization nonce already used (replay)");
    const ok = await verifyTransferAuthorization({
      requirements,
      authorization: auth,
      signature: payment.payload.signature,
    });
    if (!ok) return fail("signature does not verify against the authorization");
    return { isValid: true, payer: auth.from };
  }

  async settle(payment: PaymentPayload, requirements: PaymentRequirements): Promise<PaymentReceipt> {
    const verdict = await this.verify(payment, requirements);
    if (!verdict.isValid) {
      throw new Error(`verifying facilitator refuses to settle: ${verdict.invalidReason}`);
    }
    const auth = payment.payload.authorization;
    this.usedNonces.add(auth.nonce);
    return {
      success: true,
      txHash: "0x" + sha256Hex(`agentanchor/test-settle/v1\n${auth.nonce}\n${auth.from}\n${auth.value}`),
      network: requirements.network,
      payer: auth.from,
      payTo: auth.to,
      amount: auth.value,
      asset: requirements.asset,
      settledAt: this.clock().toISOString(),
      facilitator: this.kind,
    };
  }
}

test("viem signer: full paid call through the gate settles and lands in the audit chain with proof", async () => {
  const { clock } = makeClock();
  const facilitator = new VerifyingFacilitator(clock);
  const gate = new X402PaymentGate(
    {
      network: TEST_NETWORK,
      asset: TEST_ASSET,
      payTo: TEST_PAYTO,
      facilitator,
      tokenName: "USD Coin",
      tokenVersion: "2",
    },
    clock,
  );
  const requirements = gate.requirementsFor({
    resource: RESOURCE_URL,
    amountAtomic: TEST_PRICE,
    description: "One paid brief",
  });
  const fetchFn: FetchLike = async (req): Promise<HttpResponse> => {
    const paymentHeader = getHeader(req.headers, "x-payment");
    if (!paymentHeader) return gate.challenge([requirements]);
    const outcome = await gate.settlePayment(paymentHeader, requirements);
    if (!outcome.ok) return outcome.response;
    return {
      status: 200,
      headers: { "content-type": "application/json", ...gate.settlementHeaders(outcome.receipt) },
      body: RESOURCE_BODY,
    };
  };

  const agent = new AccountableAgent({
    agentId: "agent:paying-viem-01",
    ownerRef: "concordium-id:paying-owner",
    homeChainAddress: "0xabc",
  });
  const client = new X402PaymentClient(
    {
      network: TEST_NETWORK,
      asset: TEST_ASSET,
      signer: new ViemPaymentSigner({ privateKey: TEST_PRIVATE_KEY }),
      maxAmountPerPayment: TEST_PRICE,
    },
    fetchFn,
    clock,
  );
  const audited = new AuditedPaymentClient(agent, client);
  const { result, record } = await audited.fetchPaid(RESOURCE_URL);

  assert.deepEqual(result.states, ["idle", "challenge-received", "authorization-signed", "retrying", "settled"]);
  assert.ok(result.payment);
  assert.equal(result.payment.payload.authorization.from, TEST_ADDRESS);
  assert.ok(result.receipt);
  assert.equal(result.receipt.payer, TEST_ADDRESS);
  assert.ok(record);
  const proof = record.payload["paymentProof"] as { txHash: string };
  assert.equal(proof.txHash, result.receipt.txHash);
  assert.equal(agent.log.verify().ok, true);
});
