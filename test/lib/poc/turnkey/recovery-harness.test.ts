import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findSourceForSimulatedRecovery, simulateUnresolvedKnownHash } from "@/lib/poc/turnkey/recovery-harness";
import type { PendingOperation } from "@/lib/poc/turnkey/public-state";

function op(partial: Partial<PendingOperation>): PendingOperation {
  return {
    id: "op-base",
    status: "confirmed",
    recipient: "0x0000000000000000000000000000000000000003",
    amountUsdc: "0.10",
    userOperationHash: "0x" + "ab".repeat(32),
    transactionHash: "0x" + "cd".repeat(32),
    receiptStatus: "success",
    submittedAt: "2026-01-01T00:00:00.000Z",
    lastError: null,
    autoResend: false,
    simulatedRecoveryOf: null,
    ...partial,
  };
}

describe("findSourceForSimulatedRecovery", () => {
  it("prefers the active pending pointer when it is itself confirmed with a known hash", () => {
    const confirmedPending = op({ id: "op-active" });
    const historyEntry = op({ id: "op-history" });
    expect(findSourceForSimulatedRecovery(confirmedPending, [historyEntry])).toBe(confirmedPending);
  });

  it("cannot overwrite a real unresolved payment even when confirmed history exists", () => {
    const unresolvedPending = op({ id: "op-active", status: "unknown", userOperationHash: null });
    const confirmedHistoryEntry = op({ id: "op-history" });
    expect(findSourceForSimulatedRecovery(unresolvedPending, [confirmedHistoryEntry])).toBeNull();
  });

  it("falls back to history when there is no active pending operation at all", () => {
    const confirmedHistoryEntry = op({ id: "op-history" });
    expect(findSourceForSimulatedRecovery(null, [confirmedHistoryEntry])).toBe(confirmedHistoryEntry);
  });

  it("skips a confirmed history entry with no userOperationHash", () => {
    const confirmedButNoHash = op({ id: "op-no-hash", userOperationHash: null });
    expect(findSourceForSimulatedRecovery(null, [confirmedButNoHash])).toBeNull();
  });

  it("returns null when nothing confirmed-with-hash exists anywhere", () => {
    expect(findSourceForSimulatedRecovery(null, [])).toBeNull();
    expect(findSourceForSimulatedRecovery(op({ status: "unknown", userOperationHash: null }), [])).toBeNull();
  });
});

describe("simulateUnresolvedKnownHash", () => {
  it("creates an unknown-status record that preserves the known hash, recipient, and amount", () => {
    const source = op({ id: "op-confirmed-1", userOperationHash: "0x" + "11".repeat(32) });
    const simulated = simulateUnresolvedKnownHash(source);

    expect(simulated.status).toBe("unknown");
    expect(simulated.userOperationHash).toBe(source.userOperationHash);
    expect(simulated.recipient).toBe(source.recipient);
    expect(simulated.amountUsdc).toBe(source.amountUsdc);
  });

  it("clears transactionHash and receiptStatus from the active simulated copy", () => {
    const source = op({ transactionHash: "0x" + "22".repeat(32), receiptStatus: "success" });
    const simulated = simulateUnresolvedKnownHash(source);

    expect(simulated.transactionHash).toBeNull();
    expect(simulated.receiptStatus).toBeNull();
  });

  it("always sets autoResend: false", () => {
    expect(simulateUnresolvedKnownHash(op({})).autoResend).toBe(false);
  });

  it("uses a brand-new id, never the source's own id, and records the relationship via simulatedRecoveryOf", () => {
    const source = op({ id: "op-confirmed-1" });
    const simulated = simulateUnresolvedKnownHash(source);

    expect(simulated.id).not.toBe(source.id);
    expect(simulated.simulatedRecoveryOf).toBe(source.id);
  });

  it("throws instead of producing a record with no hash to reconcile", () => {
    const source = op({ userOperationHash: null });
    expect(() => simulateUnresolvedKnownHash(source)).toThrow(/userOperationHash/);
  });
});

describe("recovery-harness.ts source", () => {
  it("imports nothing capable of signing, prompting WebAuthn, or submitting a transaction — this module is architecturally incapable of it, not just unexercised", () => {
    const source = readFileSync(path.resolve(process.cwd(), "lib/poc/turnkey/recovery-harness.ts"), "utf8");
    for (const forbidden of [
      'from "./account"',
      'from "./payment"',
      'from "./sign-probe"',
      'from "./verified-account"',
      'from "./raw-sign"',
      'from "permissionless"',
      'from "@turnkey/http"',
      'from "@turnkey/viem"',
      'from "@turnkey/webauthn-stamper"',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("await ");
    expect(source).not.toContain("async ");
  });
});
