import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnchorNotConfiguredError,
  AuditLog,
  ConcordiumAnchorClient,
  MockAnchorClient,
} from "../src/index.js";

function samplePayload() {
  let t = Date.parse("2026-11-18T00:00:00.000Z");
  const log = new AuditLog({
    agentId: "agent:anchor-01",
    ownerRef: "concordium-id:anchor-owner",
    clock: () => new Date((t += 1000)),
  });
  log.append({ actionType: "payment.sent", payload: { amount: "1.00" } });
  log.append({ actionType: "task.completed", payload: { task: "x" } });
  return log.anchorPayload();
}

test("mock client anchors a payload and the receipt verifies against it", async () => {
  const client = new MockAnchorClient(() => new Date("2026-11-18T02:00:00.000Z"));
  const payload = samplePayload();
  const receipt = await client.anchor(payload);
  assert.equal(receipt.clientKind, "mock");
  assert.equal(receipt.network, "local-simulated");
  assert.equal(receipt.explorerUrl, null);
  assert.equal(receipt.rootHash, payload.rootHash);
  assert.equal(receipt.recordCount, payload.recordCount);
  assert.equal(receipt.anchoredAt, "2026-11-18T02:00:00.000Z");
  assert.equal(await client.verify(payload, receipt), true);
  assert.deepEqual(await client.getReceipt(receipt.anchorId), receipt);
});

test("mock anchor ids are deterministic for the same payload", async () => {
  const client = new MockAnchorClient();
  const payload = samplePayload();
  const a = await client.anchor(payload);
  const b = await client.anchor(payload);
  assert.equal(a.anchorId, b.anchorId);
});

test("mock verify fails when the payload's root hash moved on", async () => {
  const client = new MockAnchorClient();
  const payload = samplePayload();
  const receipt = await client.anchor(payload);
  const moved = { ...payload, rootHash: "f".repeat(64), recordCount: payload.recordCount + 1 };
  assert.equal(await client.verify(moved, receipt), false);
  assert.equal(await client.getReceipt("mock-does-not-exist"), null);
});

test("concordium client without configuration refuses with AnchorNotConfiguredError", async () => {
  const client = new ConcordiumAnchorClient();
  assert.equal(client.kind, "concordium");
  assert.equal(client.network, "concordium-testnet");
  await assert.rejects(() => client.anchor(samplePayload()), AnchorNotConfiguredError);
  await assert.rejects(() => client.anchor(samplePayload()), /testnet wallet/);
});

test("concordium client with full config reaches the transport seam, not the config error", async () => {
  const client = new ConcordiumAnchorClient({
    grpcEndpoint: "https://grpc.testnet.concordium.com:20000",
    accountAddress: "3xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    contractAddress: "1234,0",
  });
  await assert.rejects(
    () => client.anchor(samplePayload()),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!(err instanceof AnchorNotConfiguredError));
      assert.match(err.message, /not wired yet/);
      return true;
    },
  );
});
