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
| **x402 payments + sponsored transactions** | Payments are logged as `payment.sent` / `payment.received` with `rail: "x402"` and a `sponsored` flag | Action types and demo flow implemented; live x402 settlement is a later milestone |

## Quick start

Requires Node.js ≥ 20. Zero runtime dependencies.

```bash
npm install
npm test        # build + full test suite (25 tests)
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

The export carries the system identity (agent + accountable owner reference), the covered period, an integrity block (algorithm, record count, root hash, and the chain-verification verdict), and one event per record. If the chain has been tampered with, `integrity.chainVerified` is `false` and the text rendering states `Chain verification: FAILED` with the failing sequence number — an export never silently vouches for a broken chain.

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
  agent/      AccountableAgent — semantic action helpers over the log
  demo.ts     end-to-end demo scenario
  index.ts    public API
test/         node:test suites for the chain, exporters, anchor seam, and agent helpers
```

## Status & milestones

- ✅ Hash-chained audit log core + tamper verification + Article 12 exporters — done, tested.
- ✅ Anchoring interface + mock client + Concordium client skeleton — done, tested.
- ⏳ Owner's step: Concordium testnet wallet + identity verification (only the owner can do this).
- ⏳ Wire the Concordium transport (root-hash anchoring contract calls + CCDExplorer read-back).
- ⏳ Agent Registry registration + ERC-8004 Agent Card + badge check against the live registry.
- ⏳ Live x402 payment flow with sponsored transactions.
- Final submission: 2026-12-09 (platform deadline 2026-12-09 23:59 UTC).

---

## 中文说明

**一句话**：AgentAnchor 给任何 AI agent 配一条能过监管关的「担责轨迹」——agent 背后的人只需实名核验一次，agent 的每个动作都写进哈希链审计日志并锚定到 Concordium 测试网，事后任何动作都能追溯到唯一的担责人，日志可导出为欧盟《AI 法案》第 12 条风格的记录。

**核心机制**：

- **哈希链日志**：每条记录都包含上一条记录的哈希（SHA-256，含域名分隔符 `agentanchor/audit/v1`，负载用键排序的规范 JSON 编码）。改、删、调换任何历史记录都会在校验时被发现，并报出出错的序号。
- **链上锚定**：日志的根哈希（链头哈希）通过 `AnchorClient` 接口锚定上链；核心代码不直接碰链，本地模拟客户端与 Concordium 测试网客户端共用同一接缝，替换实现不改核心。
- **担责人只存引用**：日志里只存身份引用（`ownerRef`），不存任何个人数据；零知识属性证明的出示过程本身也作为事件入链（`identity.attribute_proof_presented`）。
- **第 12 条风格导出**：`exportArticle12Json` / `exportArticle12Text` 输出带完整性结论的记录；链被篡改时导出会明确写 FAILED，绝不替坏链背书。

**运行**：`npm install` → `npm test`（构建 + 25 个测试）→ `npm run demo`（五步演示：查徽章 → 出示属性证明 → x402 收款 → 完成任务 → x402 付款，随后校验、锚定、打印导出）。

**等用户本人的接缝点**：Concordium 测试网钱包 + 一次身份核验（拿徽章）是唯一需要项目所有者本人完成的步骤；完成前 `ConcordiumAnchorClient` 会以 `AnchorNotConfiguredError` 明确报出缺哪几项配置，完成之后只需在组合点换上真实客户端，核心代码不动。
