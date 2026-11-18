import { AccountableAgent } from "./agent/accountable-agent.js";
import { MockAnchorClient } from "./anchor/mock-anchor-client.js";
import { exportArticle12Json, exportArticle12Text } from "./audit/export.js";

/**
 * Demo scenario: an agent checks a counterparty's badge, proves its owner
 * is a verified adult without revealing who they are, gets paid over x402,
 * does the work, pays for an API call — and every step lands in the
 * hash-chained audit log, whose root hash is then anchored (locally
 * simulated client; the Concordium testnet client drops into the same
 * seam once the owner's wallet exists).
 */
const agent = new AccountableAgent({
  agentId: "agent:research-runner-01",
  ownerRef: "concordium-id:owner-ref-7f3a (verified once, identity not stored)",
  homeChainAddress: "0x0000000000000000000000000000000000000000",
});

agent.recordBadgeChecked({ counterparty: "agent:data-vendor-42", result: "verified" });
agent.recordAttributeProofPresented({
  proofType: "verified-adult + permitted-jurisdiction",
  verifier: "agent:data-vendor-42",
});
agent.recordPaymentReceived({
  amount: "25.00",
  asset: "USDC",
  from: "agent:data-vendor-42",
  rail: "x402",
  sponsored: true,
});
agent.perform("task.completed", {
  task: "summarise-market-report",
  outputRef: "ipfs://example-output",
});
agent.recordPaymentSent({
  amount: "0.40",
  asset: "USDC",
  to: "api:market-data",
  rail: "x402",
  sponsored: true,
});

const verification = agent.log.verify();
console.log(`Audit chain: ${agent.log.length} records, verification ${verification.ok ? "OK" : "FAILED"}`);
console.log(`Root hash:   ${agent.log.rootHash()}`);

const anchorClient = new MockAnchorClient();
const payload = agent.log.anchorPayload();
const receipt = await anchorClient.anchor(payload);
const anchored = await anchorClient.verify(payload, receipt);
console.log(
  `Anchored via ${receipt.clientKind} client on ${receipt.network}: ${receipt.anchorId} (verify: ${anchored})`,
);

console.log("\n--- EU AI Act Article 12-style export (text) ---");
console.log(exportArticle12Text(agent.log));

console.log("--- EU AI Act Article 12-style export (JSON, integrity block) ---");
console.log(JSON.stringify(exportArticle12Json(agent.log).integrity, null, 2));
