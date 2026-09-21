import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingOperation,
  loadOperationHistory,
  loadPendingOperation,
  rememberOperation,
  savePendingOperation,
  savePublicAccount,
  loadPublicAccount,
  parsePublicAccountState,
  type PendingOperation,
} from "@/lib/poc/turnkey/public-state";
import { SAFE_POC } from "@/lib/poc/turnkey/constants";

describe("public pending-operation persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips public account + pending hashes without a signing token", () => {
    const account = parsePublicAccountState({
      appUserId: "app-user",
      subOrganizationId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      walletId: "33333333-3333-4333-8333-333333333333",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      safeAddress: "0x0000000000000000000000000000000000000002",
      authenticators: [],
    });
    expect(account).not.toBeNull();
    savePublicAccount(account!);
    expect(loadPublicAccount()?.safe.moduleVersion).toBe(SAFE_POC.module.version);

    savePendingOperation({
      id: "op-1",
      status: "submitted",
      recipient: "0x0000000000000000000000000000000000000003",
      amountUsdc: "0.10",
      userOperationHash: "0x" + "cd".repeat(32),
      transactionHash: null,
      receiptStatus: null,
      submittedAt: "2026-01-01T00:00:00.000Z",
      lastError: null,
      autoResend: false,
      simulatedRecoveryOf: null,
    });

    const pending = loadPendingOperation();
    expect(pending?.userOperationHash).toBe("0x" + "cd".repeat(32));
    expect(pending?.transactionHash).toBeNull();
    expect(pending?.autoResend).toBe(false);
    expect(pending?.simulatedRecoveryOf).toBeNull();
    expect(JSON.stringify(pending)).not.toMatch(/private|seed|sessionKey|stamper/i);
  });

  it("round-trips an explicit simulatedRecoveryOf marker through save/load", () => {
    savePendingOperation({
      id: "sim-recovery-op-1-1234",
      status: "unknown",
      recipient: "0x0000000000000000000000000000000000000003",
      amountUsdc: "0.10",
      userOperationHash: "0x" + "ef".repeat(32),
      transactionHash: null,
      receiptStatus: null,
      submittedAt: "2026-01-01T00:00:00.000Z",
      lastError: null,
      autoResend: false,
      simulatedRecoveryOf: "op-1",
    });

    expect(loadPendingOperation()?.simulatedRecoveryOf).toBe("op-1");
  });

  it("preserves the owner address casing Turnkey returned, but still normalizes plain EVM addresses", () => {
    // Turnkey's signRawPayload resource lookup is case-sensitive. Lowercasing
    // ownerAddress here (as this once did) makes Turnkey unable to find the
    // wallet ("Could not find any resource to sign with"). safeAddress is a
    // plain EVM contract address — lowercasing it is fine and expected.
    const mixedCaseOwner = "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF";
    const mixedCaseSafe = "0x1234567890ABCDEF1234567890abcdef12345678";
    const account = parsePublicAccountState({
      appUserId: "app-user",
      subOrganizationId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      walletId: "33333333-3333-4333-8333-333333333333",
      ownerAddress: mixedCaseOwner,
      safeAddress: mixedCaseSafe,
      authenticators: [],
    });
    expect(account?.ownerAddress).toBe(mixedCaseOwner);
    expect(account?.safeAddress).toBe(mixedCaseSafe.toLowerCase());
  });

  it("clears only the active pending pointer, keeping history and account intact", () => {
    const account = parsePublicAccountState({
      appUserId: "app-user",
      subOrganizationId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      walletId: "33333333-3333-4333-8333-333333333333",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      safeAddress: "0x0000000000000000000000000000000000000002",
      authenticators: [],
    })!;
    savePublicAccount(account);

    const stuck: PendingOperation = {
      id: "op-stuck",
      status: "unknown",
      recipient: "0x0000000000000000000000000000000000000003",
      amountUsdc: "0.10",
      userOperationHash: null,
      transactionHash: null,
      receiptStatus: null,
      submittedAt: "2026-01-01T00:00:00.000Z",
      lastError: "bundler response lost",
      autoResend: false,
      simulatedRecoveryOf: null,
    };
    savePendingOperation(stuck);
    rememberOperation(stuck);
    expect(loadPendingOperation()).not.toBeNull();

    clearPendingOperation();

    // Clearing must not be a resend and must not touch the account or the
    // historical record — it only stops treating this operation as active.
    expect(loadPendingOperation()).toBeNull();
    expect(loadPublicAccount()?.subOrganizationId).toBe(account.subOrganizationId);
    expect(loadOperationHistory().map((item) => item.id)).toContain("op-stuck");
  });
});
