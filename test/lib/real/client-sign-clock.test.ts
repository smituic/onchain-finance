import { afterEach, describe, expect, it, vi } from "vitest";
import type { WirePreparedFields } from "@/lib/real/payments/prepared-operation";

/**
 * Part E (S2): signPreparedPayment's pre-signing validity gate must be
 * judged against the caller-supplied, server-adjusted `nowSeconds` — never
 * raw local Date.now() — so a skewed browser clock can neither (a) falsely
 * refuse a payment that's actually still well inside its window, nor
 * (b) accept one that's actually already past it. The server remains
 * independently authoritative at /submit regardless (unchanged by this
 * slice); this test only pins the CLIENT gate's own behavior.
 *
 * createRealPublicClient is mocked to throw a recognizable marker
 * immediately after the validity gate — real signing/account construction is
 * out of scope here (see signing-chain.test.ts for that end-to-end proof).
 * Reaching the marker proves the gate did NOT reject the call; seeing
 * PAYMENT_EXPIRED_BEFORE_APPROVAL instead proves it did.
 */
const REACHED_PAST_GATE = new Error("marker: reached past the validity gate");

vi.mock("@/lib/real/chain/client", () => ({
  createRealPublicClient: () => {
    throw REACHED_PAST_GATE;
  },
}));

const { signPreparedPayment, PAYMENT_EXPIRED_BEFORE_APPROVAL } = await import("@/lib/real/payments/client-sign");

const VALID_UNTIL = 1_900_000_600;

const fields: WirePreparedFields = {
  sender: "0x1111111111111111111111111111111111111111",
  nonce: "0",
  factory: null,
  factoryData: null,
  callData: "0x",
  callGasLimit: "100000",
  verificationGasLimit: "100000",
  preVerificationGas: "50000",
  maxFeePerGas: "1",
  maxPriorityFeePerGas: "1",
  paymaster: null,
  paymasterData: null,
  paymasterVerificationGasLimit: null,
  paymasterPostOpGasLimit: null,
  validUntil: VALID_UNTIL,
};

function sign(nowSeconds?: number) {
  return signPreparedPayment({
    fields,
    rpId: "localhost",
    subOrganizationId: "sub-org-1",
    ownerAddress: "0x2222222222222222222222222222222222222222",
    rpcUrl: "http://localhost",
    authorizingCredentialId: "credential-1",
    nowSeconds,
  });
}

describe("signPreparedPayment's validity gate uses the caller-supplied nowSeconds, not raw local time", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a local clock running far AHEAD does not falsely refuse a payment the server-adjusted time says is still valid", async () => {
    vi.useFakeTimers();
    // Raw local Date.now() is skewed far past validUntil...
    vi.setSystemTime((VALID_UNTIL + 10_000) * 1000);
    // ...but the server-adjusted now (passed explicitly) says there's still
    // well over the 60s dispatch margin left.
    await expect(sign(VALID_UNTIL - 500)).rejects.toBe(REACHED_PAST_GATE);
  });

  it("without an explicit nowSeconds, a skewed-ahead local clock still refuses (no silent change to the existing default behavior)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime((VALID_UNTIL + 10_000) * 1000);
    await expect(sign(undefined)).rejects.toThrow(PAYMENT_EXPIRED_BEFORE_APPROVAL);
  });

  it("a local clock running far BEHIND cannot extend validity past what the server-adjusted time says", async () => {
    vi.useFakeTimers();
    // Raw local Date.now() thinks there's tons of time left...
    vi.setSystemTime((VALID_UNTIL - 10_000) * 1000);
    // ...but the server-adjusted now (passed explicitly) says it's already expired.
    await expect(sign(VALID_UNTIL + 100)).rejects.toThrow(PAYMENT_EXPIRED_BEFORE_APPROVAL);
  });
});
