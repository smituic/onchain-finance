// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEON_TRANSACTION_ISOLATION_LEVEL, createNeonDurableStores, createNeonSqlClient } from "@/lib/real/server/neon-store";
import { createNeonRevocationResolutionStore } from "@/lib/real/server/passkey-revocation-resolution-store";

/**
 * S5 (L4): the account-lock serialization (S1 payment dispatch vs removal,
 * 2g removal dispatch/confirmation, activation, the S3 resolution commit)
 * holds only under READ COMMITTED. These tests drive the REAL
 * @neondatabase/serverless driver through the production factories with
 * fetch intercepted (nothing leaves the process) and assert the isolation
 * the driver actually sends — so removing or changing the pin fails here,
 * whatever the database default happens to be.
 */
const DATABASE_URL = "postgresql://user:pass@ep-isolation-test-000000.us-east-2.aws.neon.tech/neondb";
const UUID = "00000000-0000-4000-8000-000000000000";

type Captured = { isolation: string | null; readOnly: string | null; batch: boolean };
let captured: Captured[] = [];

beforeEach(() => {
  captured = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(init?.body ?? "{}") as { queries?: unknown[] };
    captured.push({ isolation: headers.get("Neon-Batch-Isolation-Level"), readOnly: headers.get("Neon-Batch-Read-Only"), batch: Array.isArray(body.queries) });
    throw new Error("intercepted: no network in this test");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function capture(run: () => Promise<unknown>): Promise<Captured> {
  await expect(run()).rejects.toThrow();
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

describe("S5 L4: Neon transaction isolation is pinned to READ COMMITTED", () => {
  it("the pin is exactly ReadCommitted", () => {
    expect(NEON_TRANSACTION_ISOLATION_LEVEL).toBe("ReadCommitted");
  });

  it("every account-locking transaction in the runtime stores is sent as a ReadCommitted batch", async () => {
    const stores = createNeonDurableStores(DATABASE_URL);
    const lockingTransactions: Array<[string, () => Promise<unknown>]> = [
      ["payments.beginDispatch (S1)", () => stores.payments.beginDispatch({ id: UUID })],
      ["revocations.beginDispatch (2g)", () => stores.revocations.beginDispatch({ id: UUID, patch: {} })],
      ["revocations.confirmDeleted (2g)", () => stores.revocations.confirmDeleted({ id: UUID, turnkeyActivityStatus: "ACTIVITY_STATUS_COMPLETED" })],
      ["backupEnrollments.activate (2g-H)", () => stores.backupEnrollments.activate({ id: UUID, signingProofActivityId: "activity" })],
      ["attempts.finalize (S5 L3)", () => stores.attempts.finalize({ credentialId: "credential", registry: stores.registry, safeAddress: "0x", accountConfigVersion: 1 })],
    ];
    for (const [name, run] of lockingTransactions) {
      captured = [];
      expect(await capture(run), name).toEqual({ isolation: "ReadCommitted", readOnly: null, batch: true });
    }
  });

  it("the S3 resolution commit is a ReadCommitted batch; its snapshot read keeps its own read-only RepeatableRead (shape unchanged)", async () => {
    const store = createNeonRevocationResolutionStore(createNeonSqlClient(DATABASE_URL));
    const commit = await capture(() =>
      store.commitResolution({
        appUserId: "app-user",
        attemptId: UUID,
        targetCredentialId: "credential",
        targetTurnkeyAuthenticatorId: "authenticator",
        expected: { turnkeyActivityId: null, turnkeyActivityStatus: null, failureReason: "no_activity_receipt" },
        receipt: { activityId: "activity", source: "stored_attempt_body", bodyAttemptId: UUID, bodySha256: "0".repeat(64), turnkeyCreatedAt: new Date(0).toISOString() },
        activityLogHeadId: "head",
        absenceFirstObservedAt: new Date(0).toISOString(),
        absenceLastObservedAt: new Date(0).toISOString(),
        survivorAuthenticatorIds: ["survivor"],
        resolverVersion: 1,
      }),
    );
    expect(commit).toEqual({ isolation: "ReadCommitted", readOnly: null, batch: true });

    captured = [];
    const snapshot = await capture(() => store.loadSnapshot({ appUserId: "app-user", attemptId: UUID }));
    expect(snapshot).toEqual({ isolation: "RepeatableRead", readOnly: "true", batch: true });
  });

  it("no production module builds a Neon client except createNeonSqlClient, and the S3 admin runner uses it", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry)) sources.push(full);
      }
    };
    walk("lib");
    walk("app");
    // Code only: doc comments may mention `neon(url, ...)`.
    const code = (file: string) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");
    const constructing = sources.filter((file) => /\bneon\(/.test(code(file)));
    expect(constructing).toEqual([path.join("lib", "real", "server", "neon-store.ts")]);
    expect(code(constructing[0]!).match(/\bneon\([^)]*/g)).toEqual(["neon(databaseUrl, { isolationLevel: NEON_TRANSACTION_ISOLATION_LEVEL }"]);

    const runner = code("test/admin/resolve-passkey-revocation.admin.test.ts");
    expect(runner).toMatch(/createNeonRevocationResolutionStore\(createNeonSqlClient\(/);
    expect(runner).not.toMatch(/\bneon\(/);
  });
});
