import { describe, expect, it } from "vitest";
import { backfillTurnkeyAuthenticatorIds, type BackfillDb, type BackfillRow } from "@/lib/real/server/backfill-turnkey-authenticator-ids";
import type { TurnkeyUserAuthenticator } from "@/lib/real/server/turnkey-discovery";

const CRED = "-_-_AQI"; // base64url
const CRED_STD = "+/+/AQI="; // same bytes, standard padded base64 (as Turnkey may return it)

/** In-memory stand-in honoring the Neon adapter's no-overwrite contract. */
function fakeDb(rows: BackfillRow[], mappings: Record<string, string | null> = {}) {
  const mapping = new Map<string, string | null>(rows.map((r) => [r.credentialId, null]));
  for (const [k, v] of Object.entries(mappings)) mapping.set(k, v);
  const writes: Array<[string, string]> = [];
  const db: BackfillDb = {
    async listUnmapped() {
      return rows.filter((r) => mapping.get(r.credentialId) === null);
    },
    async findCredentialByAuthenticatorId(id) {
      return [...mapping.entries()].find(([, v]) => v === id)?.[0] ?? null;
    },
    async setIfUnmapped(credentialId, authenticatorId) {
      if (mapping.get(credentialId) !== null) return false;
      mapping.set(credentialId, authenticatorId);
      writes.push([credentialId, authenticatorId]);
      return true;
    },
    async readMapping(credentialId) {
      return mapping.get(credentialId) ?? null;
    },
  };
  return { db, mapping, writes };
}

const row: BackfillRow = { credentialId: CRED, subOrganizationId: "sub-org", turnkeyUserId: "user" };
const authenticator = (credentialId: string, authenticatorId: string): TurnkeyUserAuthenticator => ({ authenticatorId, credentialId, publicKey: "pk" });

describe("backfillTurnkeyAuthenticatorIds", () => {
  it("writes exactly one unambiguous match, compared by decoded credential-id BYTES", async () => {
    const { db, writes } = fakeDb([row]);
    const report = await backfillTurnkeyAuthenticatorIds({ db, listAuthenticators: async () => [authenticator(CRED_STD, "auth-1"), authenticator("AAAA", "auth-other")] });
    expect(report).toEqual([{ credential: `${CRED.slice(0, 8)}…`, outcome: "mapped" }]);
    expect(writes).toEqual([[CRED, "auth-1"]]);
  });

  it("zero matches: reports, never writes", async () => {
    const { db, writes } = fakeDb([row]);
    expect((await backfillTurnkeyAuthenticatorIds({ db, listAuthenticators: async () => [authenticator("AAAA", "auth-1")] }))[0]!.outcome).toBe("no_match");
    expect(writes).toEqual([]);
  });

  it("more than one match: reports, never writes", async () => {
    const { db, writes } = fakeDb([row]);
    expect((await backfillTurnkeyAuthenticatorIds({ db, listAuthenticators: async () => [authenticator(CRED, "a1"), authenticator(CRED_STD, "a2")] }))[0]!.outcome).toBe("ambiguous");
    expect(writes).toEqual([]);
  });

  it("a malformed Turnkey credential id never matches (no raw-string fallback)", async () => {
    const { db, writes } = fakeDb([{ ...row, credentialId: "not base64!!" }]);
    expect((await backfillTurnkeyAuthenticatorIds({ db, listAuthenticators: async () => [authenticator("not base64!!", "a1")] }))[0]!.outcome).toBe("no_match");
    expect(writes).toEqual([]);
  });

  it("refuses to overwrite a conflicting non-null mapping that appeared concurrently", async () => {
    const { db, mapping, writes } = fakeDb([row]);
    const original = db.setIfUnmapped.bind(db);
    db.setIfUnmapped = async (c, a) => {
      mapping.set(c, "someone-elses-authenticator"); // raced in between list and write
      return original(c, a);
    };
    expect((await backfillTurnkeyAuthenticatorIds({ db, listAuthenticators: async () => [authenticator(CRED, "auth-1")] }))[0]!.outcome).toBe("conflict_existing_mapping");
    expect(mapping.get(CRED)).toBe("someone-elses-authenticator");
    expect(writes).toEqual([]);
  });

  it("refuses to map an authenticator already mapped to a different passkey", async () => {
    const { db, writes } = fakeDb([row], { "other-credential": "auth-1" });
    expect((await backfillTurnkeyAuthenticatorIds({ db, listAuthenticators: async () => [authenticator(CRED, "auth-1")] }))[0]!.outcome).toBe("conflict_authenticator_already_mapped");
    expect(writes).toEqual([]);
  });

  it("is rerunnable: a second run has nothing left to do", async () => {
    const { db } = fakeDb([row]);
    const list = async () => [authenticator(CRED, "auth-1")];
    await backfillTurnkeyAuthenticatorIds({ db, listAuthenticators: list });
    expect(await backfillTurnkeyAuthenticatorIds({ db, listAuthenticators: list })).toEqual([]);
  });

  it("a Turnkey read failure or missing user is reported, never written, and the report carries no full ids", async () => {
    const { db, writes } = fakeDb([row, { ...row, credentialId: "AAAAAAAAAAAAAAAA" }]);
    let call = 0;
    const report = await backfillTurnkeyAuthenticatorIds({
      db,
      listAuthenticators: async () => {
        call += 1;
        if (call === 1) throw new Error("secret-bearing upstream message");
        return null;
      },
    });
    expect(report.map((r) => r.outcome)).toEqual(["turnkey_read_failed", "turnkey_user_not_found"]);
    expect(JSON.stringify(report)).not.toMatch(/secret|AAAAAAAAAAAAAAAA/);
    expect(writes).toEqual([]);
  });
});
