import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HttpFacilitatorClient,
  MockFacilitatorClient,
  MockPaymentSigner,
  X402NotConfiguredError,
  X402PaymentClient,
  X402PaymentError,
  X402PaymentGate,
  decodeHeaderJson,
  encodeHeaderJson,
  getHeader,
  type FetchLike,
  type PaymentPayload,
  type PaymentRequiredBody,
} from "../src/index.js";
import {
  RESOURCE_BODY,
  RESOURCE_URL,
  TEST_ASSET,
  TEST_NETWORK,
  TEST_PAYTO,
  TEST_PRICE,
  makeClock,
  makeFakeServer,
} from "./x402-helpers.js";

function makeClient(fetchFn: FetchLike, clock: () => Date, cap?: string): X402PaymentClient {
  return new X402PaymentClient(
    { network: TEST_NETWORK, asset: TEST_ASSET, signer: new MockPaymentSigner(), maxAmountPerPayment: cap },
    fetchFn,
    clock,
  );
}

test("challenge: an unpaid request is answered 402 with decodable requirements matching the config", async () => {
  const { clock } = makeClock();
  const server = makeFakeServer(clock);
  const res = await server.fetchFn({ method: "GET", url: RESOURCE_URL, headers: {} });
  assert.equal(res.status, 402);
  const body = decodeHeaderJson<PaymentRequiredBody>(getHeader(res.headers, "payment-required"));
  assert.ok(body);
  assert.equal(body.accepts.length, 1);
  const req = body.accepts[0];
  assert.equal(req.scheme, "exact");
  assert.equal(req.network, TEST_NETWORK);
  assert.equal(req.asset, TEST_ASSET);
  assert.equal(req.payTo, TEST_PAYTO);
  assert.equal(req.maxAmountRequired, TEST_PRICE);
  assert.equal(req.resource, RESOURCE_URL);
  assert.deepEqual(req.extra, { name: "USD Coin", version: "2" });
});

test("payment: the full flow — challenge, sign, retry, settle — returns the resource and a settlement proof", async () => {
  const { clock } = makeClock();
  const server = makeFakeServer(clock);
  const client = makeClient(server.fetchFn, clock);
  const result = await client.fetchPaid(RESOURCE_URL);
  assert.equal(result.response.status, 200);
  assert.equal(result.response.body, RESOURCE_BODY);
  assert.deepEqual(result.states, ["idle", "challenge-received", "authorization-signed", "retrying", "settled"]);
  assert.ok(result.receipt);
  assert.equal(result.receipt.success, true);
  assert.match(result.receipt.txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(result.receipt.amount, TEST_PRICE);
  assert.equal(result.receipt.payTo, TEST_PAYTO);
  assert.equal(result.receipt.payer, new MockPaymentSigner().address);
  // The facilitator can produce the same receipt again from its registry.
  const stored = await server.facilitator.getReceipt(result.receipt.txHash);
  assert.deepEqual(stored, result.receipt);
});

test("config gates: client, gate and HTTP facilitator refuse to run unconfigured and list what is missing", async () => {
  const { clock } = makeClock();
  const server = makeFakeServer(clock);

  const bareClient = new X402PaymentClient({}, server.fetchFn, clock);
  await assert.rejects(bareClient.fetchPaid(RESOURCE_URL), (err: unknown) => {
    assert.ok(err instanceof X402NotConfiguredError);
    assert.deepEqual(err.missing, ["network", "asset", "signer (payer wallet)"]);
    return true;
  });

  const bareGate = new X402PaymentGate({});
  assert.throws(
    () => bareGate.requirementsFor({ resource: RESOURCE_URL, amountAtomic: "1", description: "x" }),
    (err: unknown) => {
      assert.ok(err instanceof X402NotConfiguredError);
      assert.deepEqual(err.missing, ["network", "asset", "payTo (receiving address)", "facilitator"]);
      return true;
    },
  );

  const bareFacilitator = new HttpFacilitatorClient({}, server.fetchFn);
  await assert.rejects(bareFacilitator.verify(null as never, server.requirements), (err: unknown) => {
    assert.ok(err instanceof X402NotConfiguredError);
    assert.deepEqual(err.missing, ["facilitatorUrl"]);
    return true;
  });
});

test("replay: the same signed payment presented twice is settled once, then rejected as replay", async () => {
  const { clock } = makeClock();
  const server = makeFakeServer(clock);
  const client = makeClient(server.fetchFn, clock);
  const result = await client.fetchPaid(RESOURCE_URL);
  assert.ok(result.payment);
  const replayHeader = encodeHeaderJson(result.payment);

  const outcome = await server.gate.settlePayment(replayHeader, server.requirements);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.reason, "replay");
    assert.equal(outcome.response.status, 402);
  }
});

test("amount mismatch: an authorization for the wrong amount is rejected before the facilitator settles", async () => {
  const { clock } = makeClock();
  const server = makeFakeServer(clock);
  const signer = new MockPaymentSigner();
  const nowSec = Math.floor(clock().getTime() / 1000);
  // Sign for a *different* (cheaper) requirement set, then present it against the real one.
  const cheap = { ...server.requirements, maxAmountRequired: "1" };
  const { authorization, signature } = await signer.signAuthorization({
    requirements: cheap,
    validAfter: String(nowSec - 60),
    validBefore: String(nowSec + 300),
    nonce: "0x" + "ab".repeat(32),
  });
  const payment: PaymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: TEST_NETWORK,
    payload: { signature, authorization },
  };
  const outcome = await server.gate.settlePayment(encodeHeaderJson(payment), server.requirements);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.reason, "amount-mismatch");
  }
  // Nothing was settled: the nonce is still unused, so the honest payment for the full amount goes through.
  const client = makeClient(server.fetchFn, clock);
  const ok = await client.fetchPaid(RESOURCE_URL);
  assert.equal(ok.response.status, 200);
});

test("expired: an authorization whose window has passed is rejected as expired", async () => {
  const { clock, advanceSeconds } = makeClock();
  const server = makeFakeServer(clock);
  const signer = new MockPaymentSigner();
  const nowSec = Math.floor(clock().getTime() / 1000);
  const { authorization, signature } = await signer.signAuthorization({
    requirements: server.requirements,
    validAfter: String(nowSec - 60),
    validBefore: String(nowSec + 120),
    nonce: "0x" + "cd".repeat(32),
  });
  const payment: PaymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: TEST_NETWORK,
    payload: { signature, authorization },
  };
  advanceSeconds(600); // ten minutes later — the two-minute window is gone
  const outcome = await server.gate.settlePayment(encodeHeaderJson(payment), server.requirements);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.reason, "authorization-expired");
  }
  // The facilitator independently agrees.
  const verdict = await server.facilitator.verify(payment, server.requirements);
  assert.equal(verdict.isValid, false);
  assert.match(verdict.invalidReason ?? "", /expired/);
});

test("spend cap: a challenge above maxAmountPerPayment is refused before signing", async () => {
  const { clock } = makeClock();
  const server = makeFakeServer(clock);
  const client = makeClient(server.fetchFn, clock, "9999"); // price is 10000
  await assert.rejects(client.fetchPaid(RESOURCE_URL), (err: unknown) => {
    assert.ok(err instanceof X402PaymentError);
    assert.equal(err.code, "amount-exceeds-cap");
    return true;
  });
});

test("no matching requirement: a challenge for another network is refused", async () => {
  const { clock } = makeClock();
  const server = makeFakeServer(clock);
  const foreignFetch: FetchLike = async (req) => {
    if (!getHeader(req.headers, "x-payment")) {
      const foreign = { ...server.requirements, network: "eip155:1" };
      return server.gate.challenge([foreign]);
    }
    return { status: 500, headers: {}, body: "should not be reached" };
  };
  const client = makeClient(foreignFetch, clock);
  await assert.rejects(client.fetchPaid(RESOURCE_URL), (err: unknown) => {
    assert.ok(err instanceof X402PaymentError);
    assert.equal(err.code, "no-matching-requirement");
    return true;
  });
});

test("rejected payment: a server that still answers 402 after payment surfaces payment-rejected", async () => {
  const { clock } = makeClock();
  const server = makeFakeServer(clock);
  // A gate whose facilitator has already burned every nonce it sees: simulate by
  // settling the client's exact payment first through a parallel path is racy;
  // instead use a fetch that always challenges — the client must report rejection.
  const alwaysChallenge: FetchLike = async () => server.gate.challenge([server.requirements], "facilitator-rejected: nope");
  const client = makeClient(alwaysChallenge, clock);
  await assert.rejects(client.fetchPaid(RESOURCE_URL), (err: unknown) => {
    assert.ok(err instanceof X402PaymentError);
    assert.equal(err.code, "payment-rejected");
    assert.match(err.message, /nope/);
    return true;
  });
});

test("HTTP facilitator: the gate settles end to end through the HTTP facilitator client", async () => {
  const { clock } = makeClock();
  // Facilitator service simulated in-process: /verify and /settle JSON endpoints
  // backed by a MockFacilitatorClient.
  const backing = new MockFacilitatorClient(clock);
  const facilitatorHttp: FetchLike = async (req): Promise<import("../src/index.js").HttpResponse> => {
    const { paymentPayload, paymentRequirements } = JSON.parse(req.body ?? "{}") as {
      paymentPayload: PaymentPayload;
      paymentRequirements: typeof serverReq;
    };
    if (req.url.endsWith("/verify")) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(await backing.verify(paymentPayload, paymentRequirements)),
      };
    }
    if (req.url.endsWith("/settle")) {
      const receipt = await backing.settle(paymentPayload, paymentRequirements);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...receipt, transaction: receipt.txHash }),
      };
    }
    return { status: 404, headers: {}, body: "unknown facilitator path" };
  };
  const serverReq = {
    scheme: "exact",
    network: TEST_NETWORK,
    asset: TEST_ASSET,
    payTo: TEST_PAYTO,
    maxAmountRequired: TEST_PRICE,
    resource: RESOURCE_URL,
    description: "One paid brief",
    maxTimeoutSeconds: 300,
  };
  const gate = new X402PaymentGate(
    {
      network: TEST_NETWORK,
      asset: TEST_ASSET,
      payTo: TEST_PAYTO,
      facilitator: new HttpFacilitatorClient({ facilitatorUrl: "https://facilitator.example.test/" }, facilitatorHttp),
    },
    clock,
  );
  const signer = new MockPaymentSigner();
  const nowSec = Math.floor(clock().getTime() / 1000);
  const { authorization, signature } = await signer.signAuthorization({
    requirements: serverReq,
    validAfter: String(nowSec - 60),
    validBefore: String(nowSec + 300),
    nonce: "0x" + "ef".repeat(32),
  });
  const payment: PaymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: TEST_NETWORK,
    payload: { signature, authorization },
  };
  const outcome = await gate.settlePayment(encodeHeaderJson(payment), serverReq);
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.match(outcome.receipt.txHash, /^0x[0-9a-f]{64}$/);
    assert.equal(outcome.receipt.facilitator, "http-facilitator");
    assert.equal(outcome.receipt.amount, TEST_PRICE);
  }
});
