import type { AnchorPayload } from "../audit/audit-log.js";
import type { AnchorClient, AnchorReceipt } from "./anchor-client.js";

/**
 * Configuration for the real Concordium testnet anchoring client.
 *
 * Every field maps to something the accountable owner provides in the
 * wallet step: a testnet account created in a Concordium wallet, funded
 * with free test CCD, whose owner has completed identity verification for
 * the "Verified by Concordium" badge. Until that step happens the client
 * refuses to run with {@link AnchorNotConfiguredError} instead of failing
 * obscurely mid-transaction.
 */
export interface ConcordiumAnchorConfig {
  /** Testnet gRPC endpoint, e.g. "https://grpc.testnet.concordium.com:20000". */
  grpcEndpoint?: string;
  /** Testnet account address that signs the anchoring transaction. */
  accountAddress?: string;
  /** Address of the deployed anchoring contract (index,subindex), e.g. "1234,0". */
  contractAddress?: string;
}

export class AnchorNotConfiguredError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      "Concordium anchoring is not configured — missing: " +
        missing.join(", ") +
        ". These come from the owner's Concordium testnet wallet step " +
        "(create testnet wallet, claim free test CCD, complete identity verification). " +
        "Use MockAnchorClient for local runs until then.",
    );
    this.name = "AnchorNotConfiguredError";
    this.missing = missing;
  }
}

/**
 * Concordium testnet implementation of {@link AnchorClient} — skeleton.
 *
 * The interface, configuration and failure behaviour are final; the gRPC
 * transport (submitting the root hash to the anchoring contract via
 * @concordium/web-sdk and reading the transaction back from CCDExplorer)
 * is wired in the milestone right after the owner's wallet + identity
 * step, and lands entirely inside this class. The audit core and the
 * mock client are unaffected by that change.
 */
export class ConcordiumAnchorClient implements AnchorClient {
  readonly kind = "concordium";
  readonly network = "concordium-testnet";
  private readonly config: ConcordiumAnchorConfig;

  constructor(config: ConcordiumAnchorConfig = {}) {
    this.config = config;
  }

  private requireConfig(): Required<ConcordiumAnchorConfig> {
    const missing: string[] = [];
    if (!this.config.grpcEndpoint) missing.push("grpcEndpoint");
    if (!this.config.accountAddress) missing.push("accountAddress (owner's testnet wallet)");
    if (!this.config.contractAddress) missing.push("contractAddress (anchoring contract)");
    if (missing.length > 0) {
      throw new AnchorNotConfiguredError(missing);
    }
    return this.config as Required<ConcordiumAnchorConfig>;
  }

  async anchor(_payload: AnchorPayload): Promise<AnchorReceipt> {
    this.requireConfig();
    throw new Error(
      "Concordium anchoring transport is not wired yet: configuration is complete, " +
        "but submitting to the testnet contract lands in the post-wallet milestone.",
    );
  }

  async getReceipt(_anchorId: string): Promise<AnchorReceipt | null> {
    this.requireConfig();
    throw new Error(
      "Concordium anchoring transport is not wired yet: reading anchors back from " +
        "CCDExplorer lands in the post-wallet milestone.",
    );
  }

  async verify(_payload: AnchorPayload, _receipt: AnchorReceipt): Promise<boolean> {
    this.requireConfig();
    throw new Error(
      "Concordium anchoring transport is not wired yet: on-chain verification lands " +
        "in the post-wallet milestone.",
    );
  }
}
