import { verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import {
  X402NotConfiguredError,
  X402PaymentError,
  type PaymentRequirements,
  type PaymentSigner,
  type TransferAuthorization,
} from "./types.js";

/**
 * The real {@link PaymentSigner}: viem + the payer's EVM account, signing
 * genuine EIP-3009 `transferWithAuthorization` typed data (EIP-712).
 *
 * This is wiring step 1 of the x402 go-live checklist — the protocol layer
 * above it (state machine, spend cap, server gate, audit bridge) does not
 * change. The key never lives in this layer's code or in the repository:
 * deployment code injects it (environment / secret store) through
 * {@link ViemPaymentSignerConfig}; the signer only holds the derived viem
 * {@link Account} in memory.
 *
 * What is verified locally (and covered by tests): address derivation and
 * the produced signature — it is a real ECDSA signature over the token's
 * EIP-712 domain, checkable offline with {@link verifyTransferAuthorization}
 * and by any EIP-3009 facilitator / token contract.
 *
 * What is NOT verified here (needs the funded wallet step, see the
 * go-live checklist in BUILD-REPORT.md): an actual settlement against a
 * production facilitator and the token contract on a live network.
 */

/** EIP-3009 typed-data structure, as defined by the token contracts (e.g. USDC). */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface ViemPaymentSignerConfig {
  /**
   * 0x-prefixed private key of the payer wallet, supplied by deployment
   * configuration (environment variable / secret store). Never commit one.
   */
  privateKey?: string;
  /**
   * Alternative to `privateKey`: a pre-built viem account (e.g. derived
   * from a mnemonic or a remote signer inside deployment code). Takes
   * precedence when both are given.
   */
  account?: LocalAccount;
}

/** Parse the numeric chain id out of a CAIP-2 `eip155:<chainId>` network id. */
export function chainIdFromNetwork(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) {
    throw new X402PaymentError(
      "invalid-challenge",
      `viem payment signer needs an EVM network id (eip155:<chainId>), got "${network}"`,
    );
  }
  return Number(match[1]);
}

/**
 * The EIP-712 domain an EIP-3009 signature is bound to: the token's own
 * domain (name/version travel in the 402 challenge's `extra`), the chain,
 * and the token contract as verifying contract.
 */
export function eip712DomainFor(requirements: PaymentRequirements): {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
} {
  const name = requirements.extra?.name;
  const version = requirements.extra?.version;
  if (!name || !version) {
    throw new X402NotConfiguredError("viem payment signer", [
      "token EIP-712 domain (requirements.extra.name/version, expected in the 402 challenge)",
    ]);
  }
  return {
    name,
    version,
    chainId: chainIdFromNetwork(requirements.network),
    verifyingContract: requirements.asset as Address,
  };
}

function authorizationMessage(authorization: TransferAuthorization) {
  return {
    from: authorization.from as Address,
    to: authorization.to as Address,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce as Hex,
  };
}

/**
 * Verify an EIP-3009 authorization signature offline (recovers the signer
 * and compares it to `authorization.from`). The same check a facilitator
 * performs before settling; exported so the wiring step — and tests — can
 * validate signatures without a live network.
 */
export async function verifyTransferAuthorization(input: {
  requirements: PaymentRequirements;
  authorization: TransferAuthorization;
  signature: string;
}): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: input.authorization.from as Address,
      domain: eip712DomainFor(input.requirements),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: authorizationMessage(input.authorization),
      signature: input.signature as Hex,
    });
  } catch {
    return false;
  }
}

export class ViemPaymentSigner implements PaymentSigner {
  private readonly account: LocalAccount;

  constructor(config: ViemPaymentSignerConfig) {
    if (config.account) {
      this.account = config.account;
    } else if (config.privateKey) {
      this.account = privateKeyToAccount(config.privateKey as Hex);
    } else {
      throw new X402NotConfiguredError("viem payment signer", [
        "privateKey (payer wallet key, from deployment configuration)",
      ]);
    }
  }

  /** The payer address authorizations are signed for (derived from the key/account). */
  get address(): string {
    return this.account.address;
  }

  async signAuthorization(input: {
    requirements: PaymentRequirements;
    validAfter: string;
    validBefore: string;
    nonce: string;
  }): Promise<{ authorization: TransferAuthorization; signature: string }> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.nonce)) {
      throw new X402PaymentError(
        "invalid-challenge",
        `EIP-3009 nonce must be a 32-byte 0x-prefixed hex string, got "${input.nonce}"`,
      );
    }
    const domain = eip712DomainFor(input.requirements);
    const authorization: TransferAuthorization = {
      from: this.account.address,
      to: input.requirements.payTo,
      value: input.requirements.maxAmountRequired,
      validAfter: input.validAfter,
      validBefore: input.validBefore,
      nonce: input.nonce,
    };
    const signature = await this.account.signTypedData({
      domain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: authorizationMessage(authorization),
    });
    return { authorization, signature };
  }
}
