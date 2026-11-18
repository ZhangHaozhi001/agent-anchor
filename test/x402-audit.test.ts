import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountableAgent,
  AuditedPaymentClient,
  MockPaymentSigner,
  X402PaymentClient,
  exportArticle12Json,
  exportArticle12Text,
  recordSettledPaymentReceived,
  type FetchLike,
} from "../src/index.js";
import { RESOURCE_URL, TEST_ASSET, TEST_NETWORK, TEST_PRICE, makeClock, makeFakeServer } from "./x402-helpers.js";

function makeAgent(): AccountableAgent {
  return new AccountableAgent({
    agentId: "agent:paying-01",
    ownerRef: "concordium-id:paying-owner",
    homeChainAddress: "0xabc",
  });
}

test("audited client: a settled paid call lands in the hash chain with its payment proof attached", async () => {
  const { clock } = makeClock();
  const server = makeFakeServer(clock);
  const agent = makeAgent();
  const client = new X402PaymentClient(
    { network: TEST_NETWORK, asset: TEST_ASSET, signer: new MockPaymentSigner() },
    server.fetchFn,
    clock,
  );
  const audited = new AuditedPaymentClient(agent, client);
  const { result, record } = await audited.fetchPaid(RESOURCE_URL);

  assert.ok(result.receipt);
  assert.ok(record);
  assert.equal(record.actionType, "payment.sent");
  assert.equal(record.payload["amount"], TEST_PRICE);
  assert.equal(record.payload["asset"], TEST_ASSET);
  assert.equal(record.payload["resource"], RESOURCE_URL);
  const proof = record.payload["paymentProof"] as { txHash: string; network: string; facilitator: string; settledAt: string };
  assert.equal(proof.txHash, result.receipt.txHash);
  assert.equal(proof.network, TEST_NETWORK);
  assert.match(proof.facilitator, /mock-facilitator/);
  assert.equal(proof.settledAt, result.receipt.settledAt);
  assert.equal(agent.log.verify().ok, true);
});

test("audited client: a free resource (200, no challenge) writes no payment record", async () => {
  const { clock } = makeClock();
  const agent = makeAgent();
  const freeFetch: FetchLike = async () => ({ status: 200, headers: {}, body: "free" });
  const client = new X402PaymentClient(
    { network: TEST_NETWORK, asset: TEST_ASSET, signer: new MockPaymentSigner() },
    freeFetch,
    clock,
  );
  const audited = new AuditedPaymentClient(agent, client);
  const { record } = await audited.fetchPaid("https://api.example.test/free");
  assert.equal(record, null);
  assert.equal(agent.log.length, 0);
});

test("recordSettledPaymentReceived: an incoming settled payment is recorded with proof", async () => {
  const { clock } = makeClock();
  const server = makeFakeServer(clock);
  const client = new X402PaymentClient(
    { network: TEST_NETWORK, asset: TEST_ASSET, signer: new MockPaymentSigner() },
    server.fetchFn,
    clock,
  );
  const { receipt } = await client.fetchPaid(RESOURCE_URL);
  assert.ok(receipt);

  const receiver = makeAgent();
  const record = recordSettledPaymentReceived(receiver, receipt, { resource: RESOURCE_URL });
  assert.equal(record.actionType, "payment.received");
  assert.equal(record.payload["from"], receipt.payer);
  const proof = record.payload["paymentProof"] as { txHash: string };
  assert.equal(proof.txHash, receipt.txHash);
  assert.equal(receiver.log.verify().ok, true);
});

test("export: the Article 12 export surfaces the payment proof next to the payment event", async () => {
  const { clock } = makeClock();
  const server = makeFakeServer(clock);
  const agent = makeAgent();
  const client = new X402PaymentClient(
    { network: TEST_NETWORK, asset: TEST_ASSET, signer: new MockPaymentSigner() },
    server.fetchFn,
    clock,
  );
  const audited = new AuditedPaymentClient(agent, client);
  const { result } = await audited.fetchPaid(RESOURCE_URL);
  assert.ok(result.receipt);
  agent.perform("task.completed", { task: "summarise-market-report" });

  const json = exportArticle12Json(agent.log, { generatedAt: "2026-11-19T01:00:00.000Z" });
  const paymentEvent = json.events.find((e) => e.event === "payment.sent");
  assert.ok(paymentEvent);
  assert.ok(paymentEvent.paymentProof);
  assert.equal(paymentEvent.paymentProof["txHash"], result.receipt.txHash);
  const taskEvent = json.events.find((e) => e.event === "task.completed");
  assert.ok(taskEvent);
  assert.equal(taskEvent.paymentProof, undefined);

  const text = exportArticle12Text(agent.log, { generatedAt: "2026-11-19T01:00:00.000Z" });
  assert.match(text, new RegExp(`proof tx=${result.receipt.txHash}`));
  assert.match(text, /Chain verification: OK/);
});
