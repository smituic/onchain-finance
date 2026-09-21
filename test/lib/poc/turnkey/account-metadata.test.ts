import { describe, expect, it } from "vitest";
import { SAFE_POC } from "@/lib/poc/turnkey/constants";
import { parsePublicAccountState, parsePendingOperation } from "@/lib/poc/turnkey/public-state";

describe("Safe / account metadata", () => {
  it("locks the researched Safe 1.4.1 + 4337 module 0.3.0 + EntryPoint 0.7 configuration", () => {
    expect(SAFE_POC.version).toBe("1.4.1");
    expect(SAFE_POC.threshold).toBe(1);
    expect(SAFE_POC.saltNonce).toBe("0");
    expect(SAFE_POC.entryPoint.version).toBe("0.7");
    expect(SAFE_POC.module.version).toBe("0.3.0");
    expect(SAFE_POC.module.address).toBe("0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226");
    expect(SAFE_POC.useMultiSendForSetup).toBe(true);
  });

  it("persists only public pending-operation metadata and forbids auto-resend", () => {
    const parsed = parsePendingOperation({
      id: "op-1",
      status: "submitted",
      recipient: "0x0000000000000000000000000000000000000001",
      amountUsdc: "0.10",
      userOperationHash: "0x" + "ab".repeat(32),
      transactionHash: null,
      receiptStatus: null,
      submittedAt: "2026-01-01T00:00:00.000Z",
      lastError: null,
      autoResend: false,
    });
    expect(parsed?.userOperationHash).toMatch(/^0xab/);
    expect(parsed?.autoResend).toBe(false);

    expect(
      parsePendingOperation({
        id: "op-1",
        status: "submitted",
        recipient: "0x0000000000000000000000000000000000000001",
        amountUsdc: "0.10",
        autoResend: true,
      }),
    ).toBeNull();
  });

  it("rejects account snapshots that are not public identifiers", () => {
    expect(parsePublicAccountState({ ownerAddress: "not-an-address" })).toBeNull();
  });
});
