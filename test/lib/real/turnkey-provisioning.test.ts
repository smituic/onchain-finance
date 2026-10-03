// @vitest-environment node
import { ECDH, createECDH, createHash, createPublicKey, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RealServerConfig } from "@/lib/real/server/config";
import {
  CREATE_SUB_ORGANIZATION_ACTIVITY_TYPE,
  PROVISIONING_EVIDENCE_VERSION,
  PROVISIONING_LIMITS,
  buildCreateSubOrganizationBody,
  findWalletAccountId,
  pollParentActivityUntilTerminal,
  readParentActivity,
  resolveParentTurnkeyDeps,
  submitCreateSubOrganization,
  type ParentActivityRead,
} from "@/lib/real/server/turnkey-provisioning";
import { sha256Hex } from "@/lib/real/server/turnkey-signed-request";
import { CREATE_PATH, FakeParentTurnkey, GET_ACTIVITY_PATH, LIST_WALLET_ACCOUNTS_PATH } from "./fixtures/turnkey-parent-fake";

/**
 * Provisioning Evidence Capture — the parent-key transport and the pure body
 * builder. Offline: every request goes to FakeParentTurnkey. The REAL
 * ApiKeyStamper is exercised (with a throwaway key generated here), so the
 * "what is stamped is what is sent" claim is checked cryptographically.
 */
const config: RealServerConfig = {
  turnkeyApiBaseUrl: "https://api.turnkey.com",
  turnkeyParentOrganizationId: "parent-org",
  turnkeyApiPublicKey: "pub",
  turnkeyApiPrivateKey: "priv",
  sessionSecret: "secret",
  rpId: "localhost",
  rpName: "Test",
  expectedOrigins: ["http://localhost:3000"],
  rpcUrl: "https://sepolia.base.org",
  pimlicoApiKey: "pim_test_key",
};

const FIXED_INPUT = {
  organizationId: "parent-org",
  appUserId: "0b5c0c7e-6d9b-4f43-9a2e-1c2d3e4f5a6b",
  timestampMs: 1790204988123,
  challengeBase64Url: "CHALLENGE",
  credentialId: "CRED",
  clientDataJson: "CDJ",
  attestationObject: "ATT",
  transports: ["hybrid", "internal"],
};

/** Evidence version 1, byte for byte. If this string has to change, that is a NEW evidence version — not an edit to this test. */
const GOLDEN_BODY =
  '{"type":"ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8","timestampMs":"1790204988123","organizationId":"parent-org","parameters":{"subOrganizationName":"real-0b5c0c7e-6d9b-4f43-9a2e-1c2d3e4f5a6b-1790204988123","rootQuorumThreshold":1,"rootUsers":[{"userName":"end-user","apiKeys":[],"authenticators":[{"authenticatorName":"user-passkey","challenge":"CHALLENGE","attestation":{"credentialId":"CRED","clientDataJson":"CDJ","attestationObject":"ATT","transports":["AUTHENTICATOR_TRANSPORT_HYBRID","AUTHENTICATOR_TRANSPORT_INTERNAL"]}}],"oauthProviders":[]}],"wallet":{"walletName":"owner","accounts":[{"curve":"CURVE_SECP256K1","pathFormat":"PATH_FORMAT_BIP32","path":"m/44\'/60\'/0\'/0/0","addressFormat":"ADDRESS_FORMAT_ETHEREUM"}]},"disableEmailAuth":true,"disableEmailRecovery":true,"disableSmsAuth":true,"disableOtpEmailAuth":true}}';
const GOLDEN_BODY_SHA256 = "0cb57dfb8c1ba960308e419c9887528de642a88acf7261a08377b091d8beef69";

describe("buildCreateSubOrganizationBody — evidence version 1", () => {
  it("produces the exact golden bytes for a fixed input (key order included)", () => {
    expect(PROVISIONING_EVIDENCE_VERSION).toBe(1);
    expect(buildCreateSubOrganizationBody(FIXED_INPUT)).toBe(GOLDEN_BODY);
  });

  it("is pure: the same input gives the same string, and the digest is the sha256 of its exact UTF-8 bytes", () => {
    const a = buildCreateSubOrganizationBody(FIXED_INPUT);
    const b = buildCreateSubOrganizationBody({ ...FIXED_INPUT });
    expect(a).toBe(b);
    expect(sha256Hex(a)).toBe(GOLDEN_BODY_SHA256);
    expect(createHash("sha256").update(Buffer.from(a, "utf8")).digest("hex")).toBe(GOLDEN_BODY_SHA256);
  });

  it("ONE timestamp feeds both timestampMs and the sub-organization name suffix — and nothing else varies", () => {
    const body = JSON.parse(buildCreateSubOrganizationBody({ ...FIXED_INPUT, timestampMs: 1790000000001 })) as { timestampMs: string; parameters: { subOrganizationName: string } };
    expect(body.timestampMs).toBe("1790000000001");
    expect(body.parameters.subOrganizationName).toBe(`real-${FIXED_INPUT.appUserId}-1790000000001`);
    // No random nonce: the name is fully determined by the app user id and the timestamp.
    expect(buildCreateSubOrganizationBody({ ...FIXED_INPUT, timestampMs: 1790000000001 })).toBe(buildCreateSubOrganizationBody({ ...FIXED_INPUT, timestampMs: 1790000000001 }));
  });

  it("a different timestamp is a different body (and digest); a null transports list means internal", () => {
    const other = buildCreateSubOrganizationBody({ ...FIXED_INPUT, timestampMs: FIXED_INPUT.timestampMs + 1 });
    expect(other).not.toBe(GOLDEN_BODY);
    expect(sha256Hex(other)).not.toBe(GOLDEN_BODY_SHA256);
    const body = JSON.parse(buildCreateSubOrganizationBody({ ...FIXED_INPUT, transports: null })) as { parameters: { rootUsers: Array<{ authenticators: Array<{ attestation: { transports: string[] } }> }> } };
    expect(body.parameters.rootUsers[0]!.authenticators[0]!.attestation.transports).toEqual(["AUTHENTICATOR_TRANSPORT_INTERNAL"]);
  });

  it("the root model is fixed: one root user, one passkey authenticator, threshold 1, no API keys / OAuth, every email/SMS path disabled", () => {
    const { type, parameters } = JSON.parse(GOLDEN_BODY) as { type: string; parameters: Record<string, unknown> & { rootUsers: Array<Record<string, unknown[]>> } };
    expect(type).toBe(CREATE_SUB_ORGANIZATION_ACTIVITY_TYPE);
    expect(parameters.rootQuorumThreshold).toBe(1);
    expect(parameters.rootUsers).toHaveLength(1);
    expect(parameters.rootUsers[0]!.apiKeys).toEqual([]);
    expect(parameters.rootUsers[0]!.oauthProviders).toEqual([]);
    expect(parameters.rootUsers[0]!.authenticators).toHaveLength(1);
    expect([parameters.disableEmailAuth, parameters.disableEmailRecovery, parameters.disableSmsAuth, parameters.disableOtpEmailAuth]).toEqual([true, true, true, true]);
  });

  it("refuses a timestamp that is not a non-negative safe integer", () => {
    for (const timestampMs of [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) expect(() => buildCreateSubOrganizationBody({ ...FIXED_INPUT, timestampMs })).toThrow();
  });
});

describe("submitCreateSubOrganization — stamps and sends EXACTLY the given string", () => {
  it("the REAL parent stamper signs the exact bytes that are sent; the stamp travels only in the X-Stamp header", async () => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const apiPublicKey = ecdh.getPublicKey("hex", "compressed");
    const apiPrivateKey = ecdh.getPrivateKey("hex").padStart(64, "0");
    const turnkey = new FakeParentTurnkey();
    const realKeyConfig = { ...config, turnkeyApiPublicKey: apiPublicKey, turnkeyApiPrivateKey: apiPrivateKey };
    // No `stamp` injected: this is the production stamper.
    const deps = resolveParentTurnkeyDeps(realKeyConfig, { fetchImpl: turnkey.fetchImpl });

    const outcome = await submitCreateSubOrganization({ config: realKeyConfig, body: GOLDEN_BODY, deps });

    expect(outcome.kind).toBe("activity");
    expect(turnkey.requests).toHaveLength(1);
    const sent = turnkey.requests[0]!;
    expect(sent.url).toBe(`https://api.turnkey.com${CREATE_PATH}`);
    expect(sent.body).toBe(GOLDEN_BODY); // byte-identical: never rebuilt or re-serialized
    expect(Object.keys(sent.headers).sort()).toEqual(["Content-Type", "X-Stamp"]);
    expect(sent.cache).toBe("no-store");
    const stamp = JSON.parse(Buffer.from(sent.headers["X-Stamp"]!, "base64url").toString("utf8")) as { publicKey: string; scheme: string; signature: string };
    expect(stamp.publicKey).toBe(apiPublicKey);
    expect(stamp.scheme).toBe("SIGNATURE_SCHEME_TK_API_P256");
    const uncompressed = ECDH.convertKey(apiPublicKey, "prime256v1", "hex", "hex", "uncompressed") as string;
    const publicKey = createPublicKey({
      format: "jwk",
      key: { kty: "EC", crv: "P-256", x: Buffer.from(uncompressed.slice(2, 66), "hex").toString("base64url"), y: Buffer.from(uncompressed.slice(66), "hex").toString("base64url") },
    });
    expect(createVerify("SHA256").update(GOLDEN_BODY, "utf8").verify(publicKey, Buffer.from(stamp.signature, "hex"))).toBe(true);
    // A different string would NOT verify under that stamp.
    expect(createVerify("SHA256").update(`${GOLDEN_BODY} `, "utf8").verify(publicKey, Buffer.from(stamp.signature, "hex"))).toBe(false);
    // Nothing secret is in the body or the outcome.
    expect(JSON.stringify(outcome)).not.toContain(apiPrivateKey);
    expect(sent.body).not.toContain(apiPrivateKey);
  });

  it("classifies every answer without ever calling a failure 'definitive' — and never loses an observable activity id", async () => {
    const run = async (mode: FakeParentTurnkey["submitMode"], limits = {}) => {
      const turnkey = new FakeParentTurnkey();
      turnkey.submitMode = mode;
      const outcome = await submitCreateSubOrganization({ config, body: GOLDEN_BODY, deps: resolveParentTurnkeyDeps(config, turnkey.deps({ limits })) });
      return { outcome, turnkey };
    };

    expect((await run("completed")).outcome).toMatchObject({ kind: "activity", httpOk: true, activity: { id: "activity-1", status: "ACTIVITY_STATUS_COMPLETED" } });
    expect((await run("pending")).outcome).toMatchObject({ kind: "activity", activity: { status: "ACTIVITY_STATUS_PENDING" } });
    expect((await run("failed")).outcome).toMatchObject({ kind: "activity", activity: { status: "ACTIVITY_STATUS_FAILED" } });
    expect((await run("network_error_before_apply")).outcome).toEqual({ kind: "no_activity", reason: "transport" });
    expect((await run("lose_response_after_apply")).outcome).toEqual({ kind: "no_activity", reason: "transport" });
    expect((await run("http_500")).outcome).toEqual({ kind: "no_activity", reason: "http_error" });
    expect((await run("unparseable")).outcome).toEqual({ kind: "no_activity", reason: "unparseable" });
    const hung = await run("hang", { submitTimeoutMs: 15 });
    expect(hung.outcome).toEqual({ kind: "no_activity", reason: "timeout" });
    expect(hung.turnkey.requests[0]!.hasSignal).toBe(true);
    // Exactly one request each: nothing is retried or re-sent.
    for (const mode of ["completed", "network_error_before_apply", "http_500", "unparseable"] as const) expect((await run(mode)).turnkey.requests).toHaveLength(1);
  });

  it("an activity id carried by a NON-2xx answer is still surfaced (httpOk: false), so it can be recorded and read back by id", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ code: 13, message: "x", activity: { id: "activity-9", status: "ACTIVITY_STATUS_COMPLETED", type: CREATE_SUB_ORGANIZATION_ACTIVITY_TYPE, organizationId: "parent-org" } }), { status: 500 })) as unknown as typeof fetch;
    const outcome = await submitCreateSubOrganization({ config, body: GOLDEN_BODY, deps: resolveParentTurnkeyDeps(config, { fetchImpl, stamp: new FakeParentTurnkey().stamp }) });
    expect(outcome).toMatchObject({ kind: "activity", httpOk: false, activity: { id: "activity-9" } });
  });

  it("a stamper failure sends nothing and is reported as unknown, never thrown", async () => {
    const turnkey = new FakeParentTurnkey();
    const deps = resolveParentTurnkeyDeps(config, {
      fetchImpl: turnkey.fetchImpl,
      stamp: async () => {
        throw new Error("bad key");
      },
    });
    expect(await submitCreateSubOrganization({ config, body: GOLDEN_BODY, deps })).toEqual({ kind: "no_activity", reason: "transport" });
    expect(turnkey.requests).toHaveLength(0);
  });
});

describe("readParentActivity — exact organization id + activity id, read-only, bounded", () => {
  async function seeded() {
    const turnkey = new FakeParentTurnkey();
    const deps = resolveParentTurnkeyDeps(config, turnkey.deps());
    await submitCreateSubOrganization({ config, body: GOLDEN_BODY, deps });
    turnkey.requests.length = 0;
    return { turnkey, deps };
  }

  it("sends exactly { organizationId, activityId } to get_activity and returns the activity", async () => {
    const { turnkey, deps } = await seeded();
    const read = await readParentActivity({ config, organizationId: "parent-org", activityId: "activity-1", timeoutMs: 1000, deps });
    expect(read).toMatchObject({ kind: "activity", activity: { id: "activity-1", organizationId: "parent-org" } });
    expect(turnkey.requests).toHaveLength(1);
    expect(turnkey.requests[0]!.path).toBe(GET_ACTIVITY_PATH);
    expect(JSON.parse(turnkey.requests[0]!.body)).toEqual({ organizationId: "parent-org", activityId: "activity-1" });
  });

  it("an unknown id is 'not_found' (HTTP 404 / code 5) — a distinct answer, never an activity and never proof of absence", async () => {
    const { deps } = await seeded();
    expect(await readParentActivity({ config, organizationId: "parent-org", activityId: "00000000-0000-4000-8000-000000000000", timeoutMs: 1000, deps })).toEqual({ kind: "not_found" });
  });

  it("an upstream error, an unreadable answer, and a timeout are all 'error' — one request, no retry", async () => {
    const { turnkey, deps } = await seeded();
    turnkey.getActivityMode = "error";
    expect(await readParentActivity({ config, organizationId: "parent-org", activityId: "activity-1", timeoutMs: 1000, deps })).toEqual({ kind: "error" });
    turnkey.getActivityMode = "hang";
    expect(await readParentActivity({ config, organizationId: "parent-org", activityId: "activity-1", timeoutMs: 15, deps })).toEqual({ kind: "error" });
    expect(turnkey.requests).toHaveLength(2);
  });
});

describe("pollParentActivityUntilTerminal — ONE absolute deadline", () => {
  const limits = { pollBudgetMs: 8000, pollInitialIntervalMs: 500, pollMaxIntervalMs: 2000, activityReadTimeoutMs: 3000 };
  const pending = (id = "activity-1"): ParentActivityRead => ({ kind: "activity", activity: { id, status: "ACTIVITY_STATUS_PENDING", type: CREATE_SUB_ORGANIZATION_ACTIVITY_TYPE, organizationId: "parent-org", raw: {} } });
  const done = (status = "ACTIVITY_STATUS_COMPLETED", id = "activity-1"): ParentActivityRead => ({ kind: "activity", activity: { id, status, type: CREATE_SUB_ORGANIZATION_ACTIVITY_TYPE, organizationId: "parent-org", raw: {} } });

  /** A fake clock: sleeping and reading advance it; nothing waits for real. */
  function world(script: (read: number) => ParentActivityRead, readDurationMs = 0) {
    let t = 1_000_000;
    const sleeps: number[] = [];
    const timeouts: number[] = [];
    const remainingAtRead: number[] = [];
    const start = t;
    const poll = () =>
      pollParentActivityUntilTerminal({
        activityId: "activity-1",
        now: () => t,
        sleep: async (ms) => {
          sleeps.push(ms);
          t += ms;
        },
        read: async (timeoutMs) => {
          timeouts.push(timeoutMs);
          remainingAtRead.push(start + limits.pollBudgetMs - t);
          t += Math.min(readDurationMs, timeoutMs);
          return script(timeouts.length);
        },
        limits,
      });
    return { poll, sleeps, timeouts, remainingAtRead, elapsed: () => t - start };
  }

  it("backs off 500 ms -> 1 s -> 2 s (capped) and stops at the first terminal status", async () => {
    const w = world((n) => (n < 4 ? pending() : done()));
    expect(await w.poll()).toMatchObject({ terminal: true, reads: 4, activity: { status: "ACTIVITY_STATUS_COMPLETED" } });
    expect(w.sleeps).toEqual([500, 1000, 2000, 2000]);
  });

  it("FAILED and REJECTED are terminal too", async () => {
    for (const status of ["ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"]) expect(await world(() => done(status)).poll()).toMatchObject({ terminal: true, reads: 1, activity: { status } });
  });

  it("never-terminal: stops at the deadline — total time is exactly the budget, no sleep runs past it, and the request count is finite", async () => {
    const w = world(() => pending());
    const outcome = await w.poll();
    expect(outcome).toMatchObject({ terminal: false, activity: { status: "ACTIVITY_STATUS_PENDING" } });
    expect(w.sleeps).toEqual([500, 1000, 2000, 2000, 2000, 500]); // the last sleep is clipped to what was left
    expect(w.sleeps.reduce((a, b) => a + b, 0)).toBe(limits.pollBudgetMs);
    expect(w.elapsed()).toBeLessThanOrEqual(limits.pollBudgetMs);
    expect(outcome.reads).toBe(5); // the clipped sleep reached the deadline: no read after it
  });

  it("each read's timeout is min(3 s, time remaining) — never more than what is left of the one deadline", async () => {
    const w = world(() => pending(), 2900);
    const outcome = await w.poll();
    expect(outcome.terminal).toBe(false);
    w.timeouts.forEach((timeout, index) => {
      expect(timeout).toBeLessThanOrEqual(limits.activityReadTimeoutMs);
      expect(timeout).toBeLessThanOrEqual(w.remainingAtRead[index]!);
      expect(timeout).toBeGreaterThan(0);
    });
    // Slow reads consume the same budget: 500 + 2900, 1000 + 2900, then only 700 ms are left.
    expect(w.timeouts).toEqual([3000, 3000]);
    expect(w.elapsed()).toBeLessThanOrEqual(limits.pollBudgetMs);
    // 500 + 1500, 1000 + 1500, 2000 -> 1500 ms left: the third read gets 1500, not 3000.
    const tight = world(() => pending(), 1500);
    await tight.poll();
    expect(tight.timeouts).toEqual([3000, 3000, 1500]);
    expect(tight.elapsed()).toBe(limits.pollBudgetMs);
  });

  it("a clock that never advances still cannot loop forever: the read count has a hard ceiling", async () => {
    let reads = 0;
    const outcome = await pollParentActivityUntilTerminal({
      activityId: "activity-1",
      now: () => 42,
      sleep: async () => {},
      read: async () => {
        reads += 1;
        return pending();
      },
      limits,
    });
    expect(outcome.terminal).toBe(false);
    expect(reads).toBe(Math.ceil(limits.pollBudgetMs / limits.pollInitialIntervalMs) + 1);
  });

  it("a read naming ANOTHER activity id is ignored (even a terminal one); errors and not_found just continue until the deadline", async () => {
    const w = world((n) => (n === 1 ? done("ACTIVITY_STATUS_COMPLETED", "activity-OTHER") : n === 2 ? { kind: "error" } : n === 3 ? { kind: "not_found" } : pending()));
    const outcome = await w.poll();
    expect(outcome.terminal).toBe(false);
    expect(outcome.activity?.id).toBe("activity-1");
    expect(outcome.reads).toBe(5);
  });

  it("a zero budget performs no read at all", async () => {
    let reads = 0;
    const outcome = await pollParentActivityUntilTerminal({
      activityId: "a",
      now: () => 1,
      sleep: async () => {},
      read: async () => {
        reads += 1;
        return pending("a");
      },
      limits: { ...limits, pollBudgetMs: 0 },
    });
    expect(outcome).toEqual({ activity: null, terminal: false, reads: 0 });
    expect(reads).toBe(0);
  });
});

describe("findWalletAccountId — the one bounded follow-up read", () => {
  it("returns the wallet account whose address matches (case-insensitively); null when absent, on an error, or on a timeout", async () => {
    const turnkey = new FakeParentTurnkey();
    const deps = resolveParentTurnkeyDeps(config, turnkey.deps({ limits: { walletReadTimeoutMs: 15 } }));
    const input = { config, subOrganizationId: "sub-org-1", walletId: "wallet-1", ownerAddress: turnkey.ownerAddress.toLowerCase(), deps };

    expect(await findWalletAccountId(input)).toBe("wallet-account-1");
    expect(turnkey.requests[0]!.path).toBe(LIST_WALLET_ACCOUNTS_PATH);
    expect(JSON.parse(turnkey.requests[0]!.body)).toEqual({ organizationId: "sub-org-1", walletId: "wallet-1" });
    turnkey.walletMode = "empty";
    expect(await findWalletAccountId(input)).toBeNull();
    turnkey.walletMode = "error";
    expect(await findWalletAccountId(input)).toBeNull();
    turnkey.walletMode = "hang";
    expect(await findWalletAccountId(input)).toBeNull();
    expect(turnkey.requests).toHaveLength(4);
  });
});

describe("turnkey-provisioning.ts source — bounded, single-purpose transport", () => {
  const source = readFileSync(path.resolve(process.cwd(), "lib/real/server/turnkey-provisioning.ts"), "utf8");

  it("the create path no longer goes through the SDK's unbounded poller or its re-serializing dispatch", () => {
    expect(source).not.toMatch(/\bcreateActivityPoller\b\s*\(/);
    expect(source).not.toMatch(/\.createSubOrganization\s*\(/);
    expect(source).not.toMatch(/from\s+["']@turnkey\/http["'][^;]*createActivityPoller/);
  });

  it("the provisional limits are the documented ones, and every request goes through the one timed transport", () => {
    expect(PROVISIONING_LIMITS).toEqual({ submitTimeoutMs: 10_000, pollBudgetMs: 8_000, pollInitialIntervalMs: 500, pollMaxIntervalMs: 2_000, activityReadTimeoutMs: 3_000, walletReadTimeoutMs: 5_000 });
    // Exactly one fetch call site, inside the timed helper, carrying the abort signal.
    expect(source.match(/\.fetchImpl\s*\(/g)).toHaveLength(1);
    expect(source).toMatch(/signal:\s*controller\.signal/);
    expect(source).not.toMatch(/\bwhile\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/);
  });

  it("the generic stamped POST is module-private: only the three purpose-built functions are exported", () => {
    expect(source).toMatch(/^async function postStampedParentRequest/m);
    expect(source).not.toMatch(/export\s+(async\s+)?function\s+postStampedParentRequest/);
  });
});
