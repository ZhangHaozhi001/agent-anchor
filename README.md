# AgentAnchor

**AgentAnchor anchors every action of an AI agent to one verified, accountable human — and turns its history into an EU AI Act-ready audit trail.**

AgentAnchor 把 AI agent 的每一个动作锚定到一个已实名担责的人身上，并把它的行为记录变成符合欧盟《AI 法案》要求的审计轨迹。

Built for the Encode Club × Concordium **Trusted Agents Hackathon** (final submission due 2026-12-09 23:59 UTC).

---

## What it does

An agent wrapped with AgentAnchor writes every action it takes — checking a counterparty's badge, presenting an attribute proof, sending or receiving an x402 payment, completing a task — into a **hash-chained audit log** at the moment it happens. Each record commits to the hash of the record before it, so editing, reordering, inserting or deleting history breaks the chain and is detected on verification. The chain's head hash (the *root hash*) is anchored on **Concordium testnet**, which additionally makes silent truncation of the log detectable by anyone holding a copy. The full log exports as an **EU AI Act Article 12-style record** that a compliance team can actually file.

The accountable human behind the agent verifies **once** with a Concordium identity provider. The log stores only an identity *reference* (`ownerRef`) — never personal data — and counterparties can ask for zero-knowledge attribute proofs (verified adult, permitted jurisdiction) without learning who the owner is.

## Concordium components

| Component | How AgentAnchor uses it | Status in this repo |
|---|---|---|
| **On-chain anchoring (testnet)** | The audit chain's root hash is anchored via an `AnchorClient`, making the trail tamper-evident and CCDExplorer-verifiable | Interface + local mock client implemented and tested; `ConcordiumAnchorClient` skeleton is config-gated — its gRPC transport lands in the milestone right after the owner's wallet step (see *The anchoring seam*) |
| **Concordium ID + Verify and Access** | The owner verifies once; the agent logs `identity.attribute_proof_presented` events (proof type + verifier, never identity data) | Modelled in the core (`ownerRef`, action type, demo flow); the live ZK proof flow wires in with the owner's identity-verification step |
| **Agent Registry + ERC-8004 Agent Card + "Verified by Concordium" badge** | The agent's identity (`AgentIdentity`) carries its home-chain address for the Agent Card link; counterparty badge checks are logged as `registry.badge_checked` | Modelled in the core; live registry registration is a later milestone (needs the owner's testnet wallet) |
| **x402 payments + sponsored transactions** | Payments are logged as `payment.sent` / `payment.received` with `rail: "x402"` and a `sponsored` flag | Payment flow implemented and tested locally: explicit challenge → sign → retry state machine, server gate with amount/expiry/replay checks, mock + HTTP facilitator clients, and an audited client that writes every settled payment into the hash chain **with its settlement proof** (`paymentProof`), which the Article 12 export surfaces. Live settlement needs deployment config (network/asset/signer) — every component refuses to run unconfigured and lists what is missing; no placeholder addresses anywhere |

## Quick start

Requires Node.js ≥ 20. One runtime dependency: `viem` (used only by the real EIP-3009 payment signer); the audit core and the rest of the payment layer are dependency-free.

```bash
npm install
npm test        # build + full test suite (46 tests)
npm run demo    # build + run the demo scenario end to end
```

The demo runs an agent through five recorded actions (badge check → attribute proof → x402 payment received → task completed → x402 payment sent), verifies the chain, anchors the root hash through the mock client, and prints the Article 12-style export in text and JSON form.

## How the audit log works

- **Record** — `{ seq, timestamp, agentId, ownerRef, actionType, actor, payload, prevHash, hash }`.
- **Hash** — SHA-256 over the domain separator `agentanchor/audit/v1` plus the canonical JSON (recursively key-sorted) of every field except `hash` itself. Payload key order therefore never affects the hash.
- **Genesis** — the first record's `prevHash` is 64 zero hex characters (`GENESIS_HASH`).
- **Verification** — `AuditLog.verifyRecords()` re-checks sequence continuity, `prevHash` linkage, a single agent/owner identity across the chain, and every record's hash. It reports the first failing `seq` and why. Editing any historical payload, rewriting a stored hash, or reordering records is caught.
- **Anchoring commitment** — `log.anchorPayload()` returns `{ rootHash, recordCount, fromSeq, toSeq, periodStart, periodEnd }`: everything an anchor receipt commits to, and everything a third party needs to re-check a log against an anchor.

## Article 12-style export

```ts
import { exportArticle12Json, exportArticle12Text } from "agent-anchor";

const json = exportArticle12Json(agent.log); // structured, fileable record
const text = exportArticle12Text(agent.log); // human-readable rendering
```

The export carries the system identity (agent + accountable owner reference), the covered period, an integrity block (algorithm, record count, root hash, and the chain-verification verdict), and one event per record. Payment events additionally carry a `paymentProof` field — the settlement evidence (transaction hash, network, facilitator, settlement time) recorded with the payment — and the text rendering prints it as a `proof tx=…` suffix, so the filed record shows *proof* of payment, not just a claim. If the chain has been tampered with, `integrity.chainVerified` is `false` and the text rendering states `Chain verification: FAILED` with the failing sequence number — an export never silently vouches for a broken chain.

## The x402 payment layer

`src/x402/` implements the payment flow this project already exercised live against a production x402 API (Blockchain IQ on Base): an unpaid request is answered **402** with payment requirements; the payer signs an **EIP-3009** `transferWithAuthorization` for exactly the required amount — gasless for the payer, a **facilitator** submits and pays the gas — retries with the signed payload in the `X-PAYMENT` header, and the server verifies + settles through the facilitator, returning the settlement proof in the `PAYMENT-RESPONSE` header.

- **`X402PaymentClient`** — the flow as an explicit state machine (`idle → challenge-received → authorization-signed → retrying → settled | failed`, with the trace returned per call). Enforces a `maxAmountPerPayment` spend cap before signing; signing is delegated to an injected `PaymentSigner` — this layer never holds a private key.
- **`X402PaymentGate`** — the server side: issues challenges and settles incoming payments, checking (in order) header well-formedness, requirement match, exact amount, authorization window, and nonce replay before the facilitator is ever called.
- **Facilitators** — `MockFacilitatorClient` (deterministic, in-memory, labelled local-simulated) and `HttpFacilitatorClient` (POST /verify + /settle against a real facilitator service, transport injected).
- **`ViemPaymentSigner`** — the real `PaymentSigner`: viem + the payer's account (key injected via deployment configuration, never committed), signing genuine EIP-3009 typed data against the token's EIP-712 domain. Its signatures verify offline (`verifyTransferAuthorization`, covered by tests, including a full paid call settled through the gate against a signature-verifying facilitator).
- **`AuditedPaymentClient`** — the accountability bridge: every settled outgoing payment is appended to the agent's hash chain as `payment.sent` with its `paymentProof`; `recordSettledPaymentReceived` does the same for incoming settlements. `npm run demo:x402` runs this version end to end and cross-checks the stored proof against the facilitator registry and the Article 12 export (6/6 checks).

Configuration is contract-enforced, like the anchoring seam: network, asset, recipient and signer all come from deployment configuration, and any missing piece throws `X402NotConfiguredError` listing exactly what is missing. Nothing defaults to a placeholder address. Wiring live settlement after the owner's wallet step is now only configuration: inject the payer key into `ViemPaymentSigner`, point the client at the target network/asset, and give the gate an `HttpFacilitatorClient` — the flow code does not change.

## The anchoring seam

The audit core never talks to a chain. It produces an `AnchorPayload`; an `AnchorClient` writes it down:

```ts
import { AnchorClient, MockAnchorClient } from "agent-anchor";

// Local runs today:
const anchorClient: AnchorClient = new MockAnchorClient();

// After the owner's wallet step — same seam, core untouched:
// const anchorClient = new ConcordiumAnchorClient({
//   grpcEndpoint: "https://grpc.testnet.concordium.com:20000",
//   accountAddress: "<owner testnet account>",
//   contractAddress: "<anchoring contract index,subindex>",
// });

const receipt = await anchorClient.anchor(agent.log.anchorPayload());
const ok = await anchorClient.verify(agent.log.anchorPayload(), receipt);
```

`ConcordiumAnchorClient` today enforces its configuration contract: without a `grpcEndpoint`, an owner `accountAddress`, and a `contractAddress` it throws `AnchorNotConfiguredError` listing exactly what is missing. Those values exist only after the **owner's step** — creating a Concordium testnet wallet, claiming free test CCD, and completing identity verification for the badge. Mock receipts are explicitly labelled `network: "local-simulated"` and are **not** on any chain.

## Repository layout

```
src/
  audit/      hash chain core (hash.ts, audit-log.ts) + Article 12 exporters (export.ts)
  anchor/     AnchorClient interface, MockAnchorClient, ConcordiumAnchorClient skeleton
  x402/       payment layer: types, client state machine, server gate, facilitators, viem signer, audited bridge
  agent/      AccountableAgent — semantic action helpers over the log
  demo.ts     end-to-end demo scenario
  demo-x402.ts  audited x402 payment demo with paymentProof cross-check
  index.ts    public API
test/         node:test suites for the chain, exporters, anchor seam, agent helpers, x402 flow + audit bridge
```

## Status & milestones

- ✅ Hash-chained audit log core + tamper verification + Article 12 exporters — done, tested.
- ✅ Anchoring interface + mock client + Concordium client skeleton — done, tested.
- ✅ x402 payment layer (client state machine, server gate, mock + HTTP facilitators, audited bridge with settlement proofs in the chain and the export) — done, tested locally; live settlement awaits deployment config from the owner's wallet step.
- ⏳ Owner's step: Concordium testnet wallet + identity verification (only the owner can do this).
- ⏳ Wire the Concordium transport (root-hash anchoring contract calls + CCDExplorer read-back).
- ⏳ Agent Registry registration + ERC-8004 Agent Card + badge check against the live registry.
- ✅ Real EIP-3009 `PaymentSigner` over viem — done, tested (offline signature verification + full-flow settlement against a verifying facilitator).
- ⏳ Live x402 settlement run: funded payer wallet + production facilitator config (the owner's wallet step).
- Final submission: 2026-12-09 (platform deadline 2026-12-09 23:59 UTC).

---

## 中文说明

**一句话**：AgentAnchor 给任何 AI agent 配一条能过监管关的「担责轨迹」——agent 背后的人只需实名核验一次，agent 的每个动作都写进哈希链审计日志并锚定到 Concordium 测试网，事后任何动作都能追溯到唯一的担责人，日志可导出为欧盟《AI 法案》第 12 条风格的记录。

**核心机制**：

- **哈希链日志**：每条记录都包含上一条记录的哈希（SHA-256，含域名分隔符 `agentanchor/audit/v1`，负载用键排序的规范 JSON 编码）。改、删、调换任何历史记录都会在校验时被发现，并报出出错的序号。
- **链上锚定**：日志的根哈希（链头哈希）通过 `AnchorClient` 接口锚定上链；核心代码不直接碰链，本地模拟客户端与 Concordium 测试网客户端共用同一接缝，替换实现不改核心。
- **担责人只存引用**：日志里只存身份引用（`ownerRef`），不存任何个人数据；零知识属性证明的出示过程本身也作为事件入链（`identity.attribute_proof_presented`）。
- **第 12 条风格导出**：`exportArticle12Json` / `exportArticle12Text` 输出带完整性结论的记录；链被篡改时导出会明确写 FAILED，绝不替坏链背书。

**运行**：`npm install` → `npm test`（构建 + 46 个测试）→ `npm run demo`（五步演示：查徽章 → 出示属性证明 → x402 收款 → 完成任务 → x402 付款，随后校验、锚定、打印导出）→ `npm run demo:x402`（审计版付款演示：真实流程跑通后把链中 paymentProof 与 facilitator 登记、导出文件交叉核对，6/6）。

**x402 支付层（已预建）**：`src/x402/` 实现了完整的付费调用状态机（402 挑战 → EIP-3009 签名授权 → 带付款重试 → facilitator 结算，付款方零 gas，与本项目此前在 Blockchain IQ 上的真实 x402 实证同一套模式）、服务端闸门（金额/过期/重放三查在调 facilitator 之前先行拦截）、mock 与 HTTP 两种 facilitator 客户端，以及审计桥 `AuditedPaymentClient`——每笔结算成功的付款都会带结算凭证（交易哈希等）落进哈希链，第 12 条导出会把凭证打印在对应事件旁。网络/代币/收款地址/签名器全部走配置，缺配置时抛 `X402NotConfiguredError` 逐项列缺，不写死任何占位地址；本地全流程由 mock facilitator + mock signer 跑通并有测试覆盖。真实签名器 `ViemPaymentSigner` 已实现（viem + 部署配置注入的钱包密钥，签真正的 EIP-3009/EIP-712 授权，签名可离线验真、已过全流程结算测试）——钱包注资后只剩把客户端指向生产 facilitator 跑一笔真实小额付款。

**等用户本人的接缝点**：Concordium 测试网钱包 + 一次身份核验（拿徽章）是唯一需要项目所有者本人完成的步骤；完成前 `ConcordiumAnchorClient` 会以 `AnchorNotConfiguredError` 明确报出缺哪几项配置，完成之后只需在组合点换上真实客户端，核心代码不动。
