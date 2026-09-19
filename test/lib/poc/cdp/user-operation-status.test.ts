import { describe, expect, it } from "vitest";
import {
  CDP_USER_OPERATION_STATUSES,
  isTerminalPhase,
  normalizeUserOperation,
  phaseForStatus,
} from "@/lib/poc/cdp/user-operation-status";

const USER_OP_HASH = `0x${"a".repeat(64)}`;
const TX_HASH = `0x${"b".repeat(64)}`;

describe("phaseForStatus", () => {
  it("maps every status the installed SDK declares to a phase", () => {
    for (const status of CDP_USER_OPERATION_STATUSES) {
      expect(phaseForStatus(status, null)).not.toBe("unknown");
    }
  });

  it("treats pending/signed/broadcast as in-flight", () => {
    expect(phaseForStatus("pending", null)).toBe("in-flight");
    expect(phaseForStatus("signed", null)).toBe("in-flight");
    expect(phaseForStatus("broadcast", null)).toBe("in-flight");
  });

  it("distinguishes a completed op that reverted from one that succeeded", () => {
    expect(phaseForStatus("complete", null)).toBe("confirmed");
    expect(phaseForStatus("complete", "ERC20: transfer amount exceeds balance")).toBe("reverted");
  });

  it("flags statuses the installed types do not declare", () => {
    expect(phaseForStatus("finalized", null)).toBe("unknown");
  });
});

describe("normalizeUserOperation", () => {
  it("keeps the user-op hash separate from the transaction hash and never invents one", () => {
    const n = normalizeUserOperation({ userOpHash: USER_OP_HASH, status: "broadcast" });
    expect(n.userOperationHash).toBe(USER_OP_HASH);
    expect(n.transactionHash).toBeNull();
    expect(n.receipt).toBeNull();
    expect(n.hashesAgree).toBeNull();
    expect(n.phase).toBe("in-flight");
    expect(n.isKnownStatus).toBe(true);
  });

  it("treats an empty-string transactionHash (allowed by the API schema) as absent", () => {
    const n = normalizeUserOperation({ userOpHash: USER_OP_HASH, status: "signed", transactionHash: "" });
    expect(n.transactionHash).toBeNull();
  });

  it("surfaces receipt evidence and checks the two hashes agree", () => {
    const n = normalizeUserOperation({
      userOpHash: USER_OP_HASH,
      status: "complete",
      transactionHash: TX_HASH,
      receipts: [{ transactionHash: TX_HASH.toUpperCase().replace("0X", "0x"), blockNumber: 123, gasUsed: "45678" }],
    });
    expect(n.phase).toBe("confirmed");
    expect(n.transactionHash).toBe(TX_HASH);
    expect(n.receipt).toEqual({ blockNumber: 123, gasUsed: "45678", revertMessage: null });
    expect(n.hashesAgree).toBe(true);
  });

  it("falls back to the receipt's hash when the top-level one is missing", () => {
    const n = normalizeUserOperation({ userOpHash: USER_OP_HASH, status: "complete", receipts: [{ transactionHash: TX_HASH }] });
    expect(n.transactionHash).toBe(TX_HASH);
    expect(n.hashesAgree).toBeNull();
  });

  it("reports a revert as its own phase with the decoded message", () => {
    const n = normalizeUserOperation({
      userOpHash: USER_OP_HASH,
      status: "complete",
      transactionHash: TX_HASH,
      receipts: [{ transactionHash: TX_HASH, revert: { data: "0x08c379a0", message: "insufficient balance" } }],
    });
    expect(n.phase).toBe("reverted");
    expect(n.receipt?.revertMessage).toBe("insufficient balance");
  });

  it("marks an undeclared status as unknown but preserves the raw value", () => {
    const n = normalizeUserOperation({ userOpHash: USER_OP_HASH, status: "mystery" });
    expect(n.sdkStatus).toBe("mystery");
    expect(n.isKnownStatus).toBe(false);
    expect(n.phase).toBe("unknown");
  });
});

describe("isTerminalPhase", () => {
  it("stops polling only on terminal outcomes", () => {
    expect(isTerminalPhase("in-flight")).toBe(false);
    expect(isTerminalPhase("unknown")).toBe(false);
    expect(isTerminalPhase("confirmed")).toBe(true);
    expect(isTerminalPhase("reverted")).toBe(true);
    expect(isTerminalPhase("dropped")).toBe(true);
    expect(isTerminalPhase("failed")).toBe(true);
  });
});
