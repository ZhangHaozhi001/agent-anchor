import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountableAgent } from "../src/index.js";

test("semantic helpers record the action types the story uses", () => {
  const agent = new AccountableAgent({
    agentId: "agent:helper-01",
    ownerRef: "concordium-id:helper-owner",
    homeChainAddress: "0xabc",
  });
  agent.recordBadgeChecked({ counterparty: "agent:vendor", result: "verified" });
  agent.recordAttributeProofPresented({ proofType: "verified-adult", verifier: "agent:vendor" });
  agent.recordPaymentReceived({ amount: "25.00", asset: "USDC", from: "agent:vendor", rail: "x402", sponsored: true });
  agent.recordPaymentSent({ amount: "0.40", asset: "USDC", to: "api:data", rail: "x402", sponsored: true });

  const types = agent.log.list().map((r) => r.actionType);
  assert.deepEqual(types, [
    "registry.badge_checked",
    "identity.attribute_proof_presented",
    "payment.received",
    "payment.sent",
  ]);
  assert.equal(agent.log.verify().ok, true);
  for (const rec of agent.log.list()) {
    assert.equal(rec.agentId, "agent:helper-01");
    assert.equal(rec.ownerRef, "concordium-id:helper-owner");
    assert.equal(rec.actor, "agent");
  }
});

test("perform records arbitrary actions with their payload intact", () => {
  const agent = new AccountableAgent({ agentId: "a", ownerRef: "o" });
  const rec = agent.perform("task.completed", { task: "t", meta: { pages: 3 } });
  assert.equal(rec.actionType, "task.completed");
  assert.deepEqual(rec.payload, { task: "t", meta: { pages: 3 } });
});
