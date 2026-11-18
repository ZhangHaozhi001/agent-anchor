import type { AnchorPayload } from "../audit/audit-log.js";

/** Proof that one chain state (one root hash) was anchored. */
export interface AnchorReceipt {
  /** Transaction hash on Concordium; a deterministic local id for the mock client. */
  anchorId: string;
  /** Which AnchorClient implementation produced this receipt. */
  clientKind: string;
  /** Network the anchor lives on, e.g. "concordium-testnet". */
  network: string;
  rootHash: string;
  recordCount: number;
  /** ISO 8601 time the anchor was written. */
  anchoredAt: string;
  /** Block-explorer link for the anchor (CCDExplorer for Concordium), or null for local anchors. */
  explorerUrl: string | null;
}

/**
 * Anchoring seam.
 *
 * The audit-log core only ever produces an {@link AnchorPayload}; how that
 * commitment is written on-chain lives behind this interface. The hackathon
 * build ships a local {@link MockAnchorClient} plus a Concordium testnet
 * client skeleton — swapping one for the other is a one-line change at the
 * composition point and never touches the audit core.
 */
export interface AnchorClient {
  readonly kind: string;
  readonly network: string;
  /** Anchor the payload's root hash and return the receipt. */
  anchor(payload: AnchorPayload): Promise<AnchorReceipt>;
  /** Fetch a previously issued receipt by id, or null if unknown. */
  getReceipt(anchorId: string): Promise<AnchorReceipt | null>;
  /** Check that a receipt genuinely commits to the given payload. */
  verify(payload: AnchorPayload, receipt: AnchorReceipt): Promise<boolean>;
}
