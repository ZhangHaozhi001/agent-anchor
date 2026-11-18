import { sha256Hex } from "../audit/hash.js";
import type { AnchorPayload, Clock } from "../audit/audit-log.js";
import type { AnchorClient, AnchorReceipt } from "./anchor-client.js";

/**
 * Local, in-memory AnchorClient that simulates on-chain anchoring so the
 * full flow — log → anchor → verify — runs end to end before the owner's
 * Concordium testnet wallet exists. Receipts issued here are NOT on any
 * chain; the receipt's network field says so plainly.
 */
export class MockAnchorClient implements AnchorClient {
  readonly kind = "mock";
  readonly network = "local-simulated";
  private readonly clock: Clock;
  private readonly receipts = new Map<string, AnchorReceipt>();

  constructor(clock: Clock = () => new Date()) {
    this.clock = clock;
  }

  async anchor(payload: AnchorPayload): Promise<AnchorReceipt> {
    const anchorId =
      "mock-" +
      sha256Hex(
        `agentanchor/anchor/v1\n${payload.agentId}\n${payload.rootHash}\n${payload.recordCount}`,
      ).slice(0, 32);
    const receipt: AnchorReceipt = {
      anchorId,
      clientKind: this.kind,
      network: this.network,
      rootHash: payload.rootHash,
      recordCount: payload.recordCount,
      anchoredAt: this.clock().toISOString(),
      explorerUrl: null,
    };
    this.receipts.set(anchorId, receipt);
    return { ...receipt };
  }

  async getReceipt(anchorId: string): Promise<AnchorReceipt | null> {
    const receipt = this.receipts.get(anchorId);
    return receipt ? { ...receipt } : null;
  }

  async verify(payload: AnchorPayload, receipt: AnchorReceipt): Promise<boolean> {
    if (receipt.rootHash !== payload.rootHash || receipt.recordCount !== payload.recordCount) {
      return false;
    }
    const stored = await this.getReceipt(receipt.anchorId);
    return stored !== null && stored.rootHash === receipt.rootHash && stored.network === this.network;
  }
}
