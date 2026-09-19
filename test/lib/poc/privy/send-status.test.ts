import { describe, expect, it } from "vitest";
import {
  applySendError,
  applySendResult,
  createPendingSendRecord,
  describeRecoveredRecord,
  parsePendingSendRecord,
  reconcileWithReceipt,
  withStatus,
  type PendingSendRecord,
} from "@/lib/poc/privy/send-status";

const FROM = "0x1111111111111111111111111111111111111111" as const;
const TO = "0x000000000000000000000000000000000000dEaD" as const;
const HASH = ("0x" + "cd".repeat(32)) as `0x${string}`;
const BUNDLER = "0x2222222222222222222222222222222222222222";

function fresh(): PendingSendRecord {
  return createPendingSendRecord({
    clientRequestId: "req-1",
    chainId: 84532,
    from: FROM,
    to: TO,
    amountBaseUnits: BigInt(100000),
    nowMs: 1000,
  });
}

describe("send lifecycle", () => {
  it("starts as preparing with no hash and a serialisable amount", () => {
    const r = fresh();
    expect(r.status).toBe("preparing");
    expect(r.transactionHash).toBeNull();
    expect(r.amountBaseUnits).toBe("100000");
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it("moves to submitted when the SDK returns a real hash", () => {
    const r = applySendResult(withStatus(fresh(), "awaiting-user", 1500), HASH, 2000);
    expect(r.status).toBe("submitted");
    expect(r.transactionHash).toBe(HASH);
    expect(r.updatedAtMs).toBe(2000);
  });

  it("treats an empty hash as unknown (transport-uncertain), never failed", () => {
    const r = applySendResult(fresh(), "", 2000);
    expect(r.status).toBe("unknown");
    expect(r.transactionHash).toBeNull();
    expect(r.note).toMatch(/do not resend/i);
  });

  it("treats a malformed identifier as unknown", () => {
    const r = applySendResult(fresh(), "0xdeadbeef", 2000);
    expect(r.status).toBe("unknown");
  });

  it("classifies a rejection before any hash as failed, but after a hash as unknown", () => {
    expect(applySendError(fresh(), "user rejected", 2000).status).toBe("failed");
    const submitted = applySendResult(fresh(), HASH, 2000);
    expect(applySendError(submitted, "network blip", 2500).status).toBe("unknown");
  });
});

describe("reconcileWithReceipt", () => {
  const submitted = () => applySendResult(fresh(), HASH, 2000);

  it("confirms on a successful receipt and records who paid", () => {
    const r = reconcileWithReceipt(submitted(), { kind: "found", status: "success", blockNumber: BigInt(123), from: BUNDLER }, 3000);
    expect(r.status).toBe("confirmed");
    expect(r.receipt).toEqual({ blockNumber: "123", status: "success", from: BUNDLER });
  });

  it("fails on a reverted receipt", () => {
    const r = reconcileWithReceipt(submitted(), { kind: "found", status: "reverted", blockNumber: BigInt(124), from: BUNDLER }, 3000);
    expect(r.status).toBe("failed");
  });

  it("keeps a missing receipt as pending — a timeout is not a failure", () => {
    const r = reconcileWithReceipt(submitted(), { kind: "not-found" }, 3000);
    expect(r.status).toBe("pending");
    const again = reconcileWithReceipt(r, { kind: "not-found" }, 90_000);
    expect(again.status).toBe("pending");
  });

  it("does not turn a read error into a chain outcome", () => {
    const r = reconcileWithReceipt(submitted(), { kind: "error", message: "rpc down" }, 3000);
    expect(r.status).toBe("pending");
    expect(r.note).toMatch(/rpc down/);
    const confirmed = reconcileWithReceipt(submitted(), { kind: "found", status: "success", blockNumber: BigInt(1), from: null }, 3000);
    expect(reconcileWithReceipt(confirmed, { kind: "error", message: "rpc down" }, 4000).status).toBe("confirmed");
  });

  it("cannot resolve a record with no hash and says so", () => {
    const r = reconcileWithReceipt(withStatus(fresh(), "awaiting-user", 1500), { kind: "not-found" }, 3000);
    expect(r.status).toBe("unknown");
    expect(r.note).toMatch(/do not resend/i);
  });
});

describe("recovery after reload", () => {
  it("describes recovered records without inviting a resend", () => {
    expect(describeRecoveredRecord(applySendResult(fresh(), HASH, 2000))).toMatch(/do not resend/i);
    expect(describeRecoveredRecord(withStatus(fresh(), "awaiting-user", 1500))).toMatch(/uncertain/i);
    expect(describeRecoveredRecord(withStatus(fresh(), "confirmed", 1500))).toMatch(/confirmed/i);
  });

  it("parses a persisted record and rejects tampered ones", () => {
    const stored = JSON.parse(JSON.stringify(applySendResult(fresh(), HASH, 2000)));
    expect(parsePendingSendRecord(stored)).toEqual(applySendResult(fresh(), HASH, 2000));
    expect(parsePendingSendRecord(null)).toBeNull();
    expect(parsePendingSendRecord({ ...stored, status: "paid" })).toBeNull();
    expect(parsePendingSendRecord({ ...stored, amountBaseUnits: "1.5" })).toBeNull();
    // A corrupted hash is dropped rather than trusted.
    expect(parsePendingSendRecord({ ...stored, transactionHash: "0x12" })?.transactionHash).toBeNull();
  });
});
