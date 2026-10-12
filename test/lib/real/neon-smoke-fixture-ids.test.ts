import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeCredentialId } from "@/lib/real/credential-id";
import { assertRunSmokeIds, isRunSmokeId, smokeFinalizeCredentialId } from "./fixtures/smoke-run-ids";

/**
 * Offline. The Neon adapter smoke's fixture-ownership contract: its seed
 * helper and its cleanup act only on ids the CURRENT run generated
 * (`smoke-<runId>-...`). The finalize (S5 L3/L2) fixtures once used a
 * `smokeL3A...` credential id that this contract refused, so ten live cases
 * could never pass; their id is now generated inside the contract instead of
 * the contract being widened. Synthetic ids only — nothing here connects.
 */
const RUN = "0a1b2c3d";
const OTHER_RUN = "0a1b2c3e";
// The suffixes neon-smoke.test.ts passes to seedTurnkeyCreated.
const SUFFIXES = ["l3-lost-cas", "l3-blocked", "l3-concurrent", "l3-conflict", "l3-tamper-account", "l3-tamper-passkey", "l2-conflict-suborg", "l2-conflict-owner", "l2-conflict-safe", "l2-stale-owner", "l2-race-a", "l2-race-b"];
/** The id format the finalize fixtures used before this fix. */
const legacyFinalizeId = Buffer.concat([Buffer.from("smokeL3A", "base64url"), Buffer.alloc(32, 7)]).toString("base64url");

describe("Neon adapter smoke: finalize fixture credential ids", () => {
  it.each(SUFFIXES)("%s: the generated id is owned by its run and is a canonical base64url credential id", (suffix) => {
    const id = smokeFinalizeCredentialId(RUN, suffix);
    expect(isRunSmokeId(RUN, id)).toBe(true);
    expect(id.startsWith(`smoke-${RUN}-L3A--`)).toBe(true);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    const bytes = decodeCredentialId(id);
    expect(bytes).not.toBeNull();
    expect(bytes).toHaveLength(15 + 32);
    expect(Buffer.from(bytes!).toString("base64url")).toBe(id);
    expect(() => assertRunSmokeIds(RUN, [id])).not.toThrow();
  });

  it("is deterministic, and distinct per suffix and per run", () => {
    expect(smokeFinalizeCredentialId(RUN, "l3-blocked")).toBe(smokeFinalizeCredentialId(RUN, "l3-blocked"));
    expect(new Set(SUFFIXES.map((suffix) => smokeFinalizeCredentialId(RUN, suffix))).size).toBe(SUFFIXES.length);
    expect(smokeFinalizeCredentialId(OTHER_RUN, "l3-blocked")).not.toBe(smokeFinalizeCredentialId(RUN, "l3-blocked"));
  });

  it("refuses to generate for anything but an 8-lowercase-hex run id", () => {
    for (const runId of ["", "0a1b2c3", "0a1b2c3d4", "0A1B2C3D", "0a1b2c3g", "0a1b-c3d", "%"]) expect(() => smokeFinalizeCredentialId(runId, "l3-blocked"), runId).toThrow(/8 lowercase hex/);
  });
});

describe("Neon adapter smoke: run-scoped ownership", () => {
  it("accepts every id shape the suite generates for its own run", () => {
    for (const id of [`smoke-${RUN}-cred-attempt`, `smoke-${RUN}-user-attempt`, `smoke-${RUN}-challenge-consume`, `smoke-${RUN}-cred-smoke-${RUN}-user-l2-index-first`, smokeFinalizeCredentialId(RUN, "l3-blocked")]) {
      expect(isRunSmokeId(RUN, id), id).toBe(true);
    }
  });

  it.each([
    ["a production-like base64url credential id", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEf"],
    ["a UUID (application account id)", "3f58e923-d3d8-4607-8e53-722f32ae6659"],
    ["the legacy finalize id — no smokeL3A exemption", legacyFinalizeId],
    ["the bare legacy prefix", "smokeL3A"],
    ["a smoke id with no run", "smoke-cred-attempt"],
    ["a smoke id with an empty run", "smoke--cred-attempt"],
    ["another suite's smoke prefix", `smoke2g-${RUN}-cred-1`],
    ["the payment suite's prefix", `smoke-pay-${RUN}-user-quota`],
    ["the run prefix not at the start", `x-smoke-${RUN}-cred-attempt`],
    ["the run prefix without its trailing dash", `smoke-${RUN}`],
    ["the run id in another letter case", `smoke-${RUN.toUpperCase()}-cred-attempt`],
    ["a padded id", ` smoke-${RUN}-cred-attempt`],
    ["the empty string", ""],
  ])("rejects %s", (_name, id) => {
    expect(isRunSmokeId(RUN, id)).toBe(false);
    expect(() => assertRunSmokeIds(RUN, [id])).toThrow("refusing to clean up a non-smoke id");
  });

  it("rejects ANOTHER run's ids, generated or plain, in both directions", () => {
    for (const id of [smokeFinalizeCredentialId(OTHER_RUN, "l3-blocked"), `smoke-${OTHER_RUN}-cred-attempt`, `smoke-${OTHER_RUN}-user-attempt`]) {
      expect(isRunSmokeId(RUN, id), id).toBe(false);
      expect(isRunSmokeId(OTHER_RUN, id), id).toBe(true);
    }
    expect(isRunSmokeId(OTHER_RUN, smokeFinalizeCredentialId(RUN, "l3-blocked"))).toBe(false);
  });

  it("a malformed run id owns nothing — it can never widen the prefix", () => {
    for (const runId of ["", "0a1b", "0A1B2C3D", ".*", "0a1b2c3d-"]) {
      expect(isRunSmokeId(runId, `smoke-${runId}-cred-attempt`), runId).toBe(false);
      expect(isRunSmokeId(runId, "smoke--cred-attempt"), runId).toBe(false);
    }
  });

  it("cleanup is all-or-nothing: one foreign id among this run's refuses the whole set, without echoing it", () => {
    const own = [`smoke-${RUN}-cred-attempt`, smokeFinalizeCredentialId(RUN, "l3-blocked"), `smoke-${RUN}-user-attempt`];
    expect(() => assertRunSmokeIds(RUN, own)).not.toThrow();
    expect(() => assertRunSmokeIds(RUN, [])).not.toThrow();
    for (const foreign of [`smoke-${OTHER_RUN}-cred-attempt`, legacyFinalizeId, "3f58e923-d3d8-4607-8e53-722f32ae6659"]) {
      let message = "";
      try {
        assertRunSmokeIds(RUN, [...own, foreign]);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("refusing to clean up a non-smoke id");
    }
  });
});

describe("Neon adapter smoke: the harness uses the ownership contract (static)", () => {
  const source = readFileSync("test/lib/real/neon-smoke.test.ts", "utf8");
  const start = source.indexOf('describe.skipIf(!enabled)("Neon adapter smoke test (live database)"');
  const block = source.slice(start, source.indexOf("\ndescribe.skipIf(", start + 1));

  it("the seed helper refuses a non-run id BEFORE it builds a client or sends its UPDATE", () => {
    const helper = /async function seedTurnkeyCreatedRow\([\s\S]*?\n  \}/.exec(block)?.[0] ?? "";
    const guard = helper.indexOf('if (!isRunSmokeId(runId, credId)) throw new Error("refusing to seed a non-smoke row");');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(helper.indexOf("createNeonSqlClient("));
    expect(guard).toBeLessThan(helper.indexOf("UPDATE registration_attempts"));
    expect(helper).toContain("WHERE credential_id = ${credId} AND state = 'verified'");
    expect(block.match(/UPDATE registration_attempts\n\s+SET state = 'turnkey_created'/g)).toHaveLength(1);
  });

  it("finalize fixtures take their credential id from the run-scoped generator, and the legacy format is gone", () => {
    expect(block).toContain("const credId = smokeFinalizeCredentialId(runId, suffix);");
    expect(source).not.toContain("smokeL3A");
    expect(block).toContain("const runId = randomUUID().slice(0, 8);");
    expect(block).toContain("const credentialId = (suffix: string) => `smoke-${runId}-cred-${suffix}`;");
    expect(block).toContain("const appUserId = (suffix: string) => `smoke-${runId}-user-${suffix}`;");
    expect(block).toContain("const challenge = (suffix: string) => `smoke-${runId}-challenge-${suffix}`;");
  });

  it("cleanup checks every registered id against the run before its first DELETE, and deletes by exact id only", () => {
    const cleanup = /afterAll\(async \(\) => \{([\s\S]*?)\n  \}\);/.exec(block)?.[1] ?? "";
    const check = cleanup.indexOf("assertRunSmokeIds(runId, [...cleanupCredentialIds, ...cleanupAppUserIds, ...cleanupChallenges]);");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(cleanup.indexOf("createNeonSqlClient("));
    expect(check).toBeLessThan(cleanup.indexOf("DELETE FROM"));
    const deletes = cleanup.match(/DELETE FROM [^`]*/g) ?? [];
    expect(deletes).toEqual([
      "DELETE FROM real_passkeys WHERE credential_id = ${id}",
      "DELETE FROM registration_attempts WHERE credential_id = ${id}",
      "DELETE FROM real_accounts WHERE app_user_id = ${id}",
      "DELETE FROM webauthn_challenges WHERE challenge = ${value}",
    ]);
  });

  it("every id registered for cleanup comes from a run-scoped generator", () => {
    const registered = [...block.matchAll(/cleanup(CredentialIds|AppUserIds|Challenges)\.add\(([^;]*)\);/g)].map((m) => m[2]!);
    expect(registered.length).toBeGreaterThan(15);
    const allowed = new Set(["credId", "userId", "otherUserId", "holderId", "holderCred", "value", "id", "credentialId(id)"]);
    for (const argument of registered) expect(allowed.has(argument), argument).toBe(true);
    // ...and each of those names is bound only to a generator's result.
    for (const [name, value] of [...block.matchAll(/const (credId|userId|otherUserId|holderId|holderCred|value) = ([^;]*);/g)].map((m) => [m[1]!, m[2]!])) {
      expect(value, name).toMatch(/^(credentialId\(|appUserId\(|challenge\(|smokeFinalizeCredentialId\(runId, suffix\)$)/);
    }
    expect(block).toContain('const [first, second] = [appUserId("l2-index-first"), appUserId("l2-index-second")];');
    expect(block).toContain('const [expired, live, trigger] = [challenge("purge-expired"), challenge("purge-live"), challenge("purge-trigger")];');
  });

  it("the ten finalize cases that failed live are still present, by title", () => {
    for (const title of [
      "S5 L3: a LOST CAS writes nothing even when the account/passkey ids are free",
      "S5 L3: a blocked attempt finalizes to null with no rows",
      "S5 L3: five concurrent finalizes over real HTTP -> exactly one valid pair",
      "S5 L3: a conflicting existing row rolls back the WHOLE transaction",
      "S5 L3: an active attempt whose account or passkey no longer matches is NOT resumed by onboarding (fails closed)",
      "S5 L2: another committed account holding this attempt's %s -> finalize blocks the attempt; zero rows for it",
      "S5 L2: a Safe derived for a stale owner -> the CAS loses; zero rows; attempt untouched (turnkey_created)",
      "S5 L2 post-index: two attempts racing to finalize the SAME sub-org over real HTTP -> exactly one account; the other attempt is blocked with zero rows",
    ]) {
      expect(block, title).toContain(title);
    }
  });
});
