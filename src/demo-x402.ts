import { AccountableAgent } from "./agent/accountable-agent.js";
import { MockAnchorClient } from "./anchor/mock-anchor-client.js";
import { exportArticle12Json, exportArticle12Text } from "./audit/export.js";
import { AuditedPaymentClient, recordSettledPaymentReceived } from "./x402/audited-client.js";
import { X402PaymentClient } from "./x402/client.js";
import { MockFacilitatorClient, MockPaymentSigner } from "./x402/mock-facilitator.js";
import { X402PaymentGate } from "./x402/server.js";
import { getHeader, type FetchLike, type PaymentReceipt } from "./x402/types.js";

/**
 * x402 demo — the audited version (wiring step 4 of the go-live checklist).
 *
 * A buyer agent pays for an API brief through the full x402 flow —
 * 402 challenge → EIP-3009 authorization → facilitator settle — via
 * {@link AuditedPaymentClient}, so the payment lands in its hash-chained
 * audit log *with the settlement proof attached* the moment it settles.
 * The seller records the same receipt on its side. The run then
 * cross-checks the `paymentProof` stored in the audit chain against three
 * independent sources — the receipt the client decoded from the
 * PAYMENT-RESPONSE header, the facilitator's own receipt registry, and
 * the Article 12 export — and fails loudly (exit 1) if any disagree.
 *
 * Everything runs in-process against the mock facilitator/signer
 * (deterministic, labelled local-simulated, no chain settlement). The
 * network/asset/payTo values below are demo configuration, injected
 * through config exactly as deployment configuration will inject the real
 * ones; the signer seam additionally accepts the real ViemPaymentSigner.
 */

const NETWORK = "eip155:8453"; // Base — demo configuration
const ASSET = "0x1111111111111111111111111111111111111111"; // demo token address (config placeholder)
const PAY_TO = "0x2222222222222222222222222222222222222222"; // demo receiving address (config placeholder)
const PRICE = "10000"; // 0.01 USDC in atomic units
const RESOURCE = "https://api.example.test/paid/brief";

// --- Seller side: a priced resource behind the x402 gate -------------------
const facilitator = new MockFacilitatorClient();
const gate = new X402PaymentGate({
  network: NETWORK,
  asset: ASSET,
  payTo: PAY_TO,
  facilitator,
  tokenName: "USD Coin",
  tokenVersion: "2",
});
const requirements = gate.requirementsFor({
  resource: RESOURCE,
  amountAtomic: PRICE,
  description: "One paid market brief",
});
const sellerFetch: FetchLike = async (req) => {
  if (req.url !== RESOURCE) return { status: 404, headers: {}, body: "not found" };
  const paymentHeader = getHeader(req.headers, "x-payment");
  if (!paymentHeader) return gate.challenge([requirements]);
  const outcome = await gate.settlePayment(paymentHeader, requirements);
  if (!outcome.ok) return outcome.response;
  return {
    status: 200,
    headers: { "content-type": "application/json", ...gate.settlementHeaders(outcome.receipt) },
    body: JSON.stringify({ brief: "paid content, delivered after settlement" }),
  };
};

const seller = new AccountableAgent({
  agentId: "agent:data-vendor-42",
  ownerRef: "concordium-id:vendor-owner-ref (verified once, identity not stored)",
  homeChainAddress: PAY_TO,
});

// --- Buyer side: the audited payment client --------------------------------
const buyer = new AccountableAgent({
  agentId: "agent:research-runner-01",
  ownerRef: "concordium-id:owner-ref-7f3a (verified once, identity not stored)",
  homeChainAddress: "0x0000000000000000000000000000000000000000",
});
buyer.recordBadgeChecked({ counterparty: "agent:data-vendor-42", result: "verified" });

const signer = new MockPaymentSigner();
const paymentClient = new X402PaymentClient(
  { network: NETWORK, asset: ASSET, signer, maxAmountPerPayment: PRICE },
  sellerFetch,
);
const audited = new AuditedPaymentClient(buyer, paymentClient);

console.log("Buyer pays for the brief over x402 (audited client)…");
const { result, record } = await audited.fetchPaid(RESOURCE);
if (!result.receipt || !record) {
  console.error("Demo failed: the paid call did not settle or was not recorded.");
  process.exit(1);
}
const receipt: PaymentReceipt = result.receipt;
console.log(`Flow states: ${result.states.join(" → ")}`);
console.log(`Settled: tx ${receipt.txHash} via ${receipt.facilitator} at ${receipt.settledAt}`);
console.log(`Audit record: seq ${record.seq} (${record.actionType}) written at settlement time.`);

// Seller records the incoming payment with the same proof attached.
const sellerRecord = recordSettledPaymentReceived(seller, receipt, { resource: RESOURCE });

// --- paymentProof cross-check ----------------------------------------------
console.log("\n--- paymentProof cross-check ---");
const checks: Array<[string, boolean]> = [];
const proof = record.payload["paymentProof"] as
  | { txHash: string; network: string; facilitator: string; settledAt: string }
  | undefined;
checks.push([
  "audit record carries a paymentProof",
  proof !== undefined,
]);
checks.push([
  "audit paymentProof == receipt decoded from PAYMENT-RESPONSE header",
  proof?.txHash === receipt.txHash &&
    proof?.network === receipt.network &&
    proof?.facilitator === receipt.facilitator &&
    proof?.settledAt === receipt.settledAt,
]);
const facilitatorReceipt = await facilitator.getReceipt(receipt.txHash);
checks.push([
  "facilitator registry holds the same receipt (tx/amount/payer/payTo)",
  facilitatorReceipt !== null &&
    facilitatorReceipt.txHash === receipt.txHash &&
    facilitatorReceipt.amount === receipt.amount &&
    facilitatorReceipt.payer === receipt.payer &&
    facilitatorReceipt.payTo === receipt.payTo,
]);
const exported = exportArticle12Json(buyer.log);
const paymentEvent = exported.events.find((e) => e.event === "payment.sent");
checks.push([
  "Article 12 export shows the same paymentProof next to payment.sent",
  paymentEvent?.paymentProof?.["txHash"] === receipt.txHash,
]);
const sellerProof = sellerRecord.payload["paymentProof"] as { txHash: string } | undefined;
checks.push([
  "seller-side payment.received carries the same proof",
  sellerProof?.txHash === receipt.txHash,
]);
checks.push([
  "both audit chains verify",
  buyer.log.verify().ok && seller.log.verify().ok,
]);
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "✔" : "✘"} ${name}`);
  if (!ok) failed += 1;
}
console.log(`paymentProof cross-check: ${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exit(1);

// --- Anchor + export ---------------------------------------------------------
const anchorClient = new MockAnchorClient();
const payload = buyer.log.anchorPayload();
const anchorReceipt = await anchorClient.anchor(payload);
const anchored = await anchorClient.verify(payload, anchorReceipt);
console.log(
  `\nBuyer log anchored via ${anchorReceipt.clientKind} client on ${anchorReceipt.network}: ${anchorReceipt.anchorId} (verify: ${anchored})`,
);
console.log("\n--- EU AI Act Article 12-style export (buyer, text) ---");
console.log(exportArticle12Text(buyer.log));
