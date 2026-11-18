import {
  MockFacilitatorClient,
  X402PaymentGate,
  getHeader,
  type FetchLike,
  type HttpResponse,
  type PaymentRequirements,
} from "../src/index.js";

/** Test fixtures — passed in through configuration, exactly as deployment config would be. */
export const TEST_NETWORK = "eip155:8453";
export const TEST_ASSET = "0x1111111111111111111111111111111111111111";
export const TEST_PAYTO = "0x2222222222222222222222222222222222222222";
export const TEST_PRICE = "10000"; // 0.01 USDC in atomic units
export const RESOURCE_URL = "https://api.example.test/paid/brief";
export const RESOURCE_BODY = JSON.stringify({ brief: "paid content" });

export interface FakeServer {
  fetchFn: FetchLike;
  gate: X402PaymentGate;
  facilitator: MockFacilitatorClient;
  requirements: PaymentRequirements;
}

/**
 * An in-process paid-resource server: unpaid requests get the gate's 402
 * challenge; requests carrying X-PAYMENT go through the gate's full
 * verify + settle path against the mock facilitator.
 */
export function makeFakeServer(clock: () => Date): FakeServer {
  const facilitator = new MockFacilitatorClient(clock);
  const gate = new X402PaymentGate(
    {
      network: TEST_NETWORK,
      asset: TEST_ASSET,
      payTo: TEST_PAYTO,
      facilitator,
      tokenName: "USD Coin",
      tokenVersion: "2",
    },
    clock,
  );
  const requirements = gate.requirementsFor({
    resource: RESOURCE_URL,
    amountAtomic: TEST_PRICE,
    description: "One paid brief",
  });
  const fetchFn: FetchLike = async (req): Promise<HttpResponse> => {
    if (req.url !== RESOURCE_URL) {
      return { status: 404, headers: {}, body: "not found" };
    }
    const paymentHeader = getHeader(req.headers, "x-payment");
    if (!paymentHeader) {
      return gate.challenge([requirements]);
    }
    const outcome = await gate.settlePayment(paymentHeader, requirements);
    if (!outcome.ok) {
      return outcome.response;
    }
    return {
      status: 200,
      headers: { "content-type": "application/json", ...gate.settlementHeaders(outcome.receipt) },
      body: RESOURCE_BODY,
    };
  };
  return { fetchFn, gate, facilitator, requirements };
}

/** A clock pinned at a fixed instant, advanceable in tests. */
export function makeClock(startIso = "2026-11-19T00:00:00.000Z") {
  let nowMs = Date.parse(startIso);
  return {
    clock: () => new Date(nowMs),
    advanceSeconds: (s: number) => {
      nowMs += s * 1000;
    },
  };
}
