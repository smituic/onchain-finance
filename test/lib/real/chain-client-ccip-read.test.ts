// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseError, createPublicClient, custom, encodeAbiParameters, encodeErrorResult, getAddress, http, toFunctionSelector, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { WebauthnStamper } from "@turnkey/webauthn-stamper";
import { createRealPublicClient } from "@/lib/real/chain/client";
import { readCashBalance } from "@/lib/real/chain/balance";
import { readLatestBlockClock, readUserOperationChainState } from "@/lib/real/chain/entry-point";
import { createReadOnlyOwnerAccount, createRealSafeAccount } from "@/lib/real/account/safe";
import { BASE_SEPOLIA_CHAIN_ID, REAL_CASH_TOKEN, REAL_SAFE } from "@/lib/real/constants";
import { bytesToBase64Url, randomBytes } from "@/lib/real/bytes";
import { PAYMENT_DETAILS_UNVERIFIED, signPreparedPayment } from "@/lib/real/payments/client-sign";
import { resolveAuthenticatedCashBalance } from "@/lib/real/server/balance";
import type { RealServerConfig } from "@/lib/real/server/config";
import { runProvisioningPipeline } from "@/lib/real/server/onboarding";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryRegistrationAttemptStore, type RegistrationAttemptStore } from "@/lib/real/server/registration-attempts";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { openBudget } from "./fixtures/chain-read-budget";
import { rpcBlock } from "./fixtures/chain-block";
import { seedTurnkeyCreatedThroughEvidence } from "./fixtures/provisioning-seed";
import { FakeParentTurnkey } from "./fixtures/turnkey-parent-fake";

/**
 * M3D — CCIP-Read trust-boundary hardening of the shared chain public client
 * (lib/real/chain/client.ts: `ccipRead: false`).
 *
 * Runs the REAL createRealPublicClient and the REAL installed viem 2.56.8 /
 * permissionless 0.3.7 — the factory's own `http(rpcUrl)` transport included,
 * with its default retry and timeout settings. Nothing about the client is
 * mocked. Only the network is faked: global `fetch` is an in-process JSON-RPC
 * responder bound to ONE sentinel URL on the reserved `.invalid` domain; any
 * other destination (a CCIP gateway in particular) is recorded and refused,
 * and the refused list must be empty after every test. Every fixture is inert
 * and local — the "gateway" URL is never contacted.
 *
 * The pre-checkpoint options (HEAD a44e497: chain + http(rpcUrl), no
 * ccipRead) are rebuilt here only as a comparison baseline: honest reads must
 * be identical under both, and the one control case shows the SDK default
 * would follow an OffchainLookup revert to the gateway — which is what the
 * setting stops.
 *
 * Integration coverage: the factory, the chain readers, Safe derivation, the
 * server balance resolver, the onboarding pipeline (production's own factory
 * call — no client injected) and browser Pay signing up to its pre-signing
 * checks. Static verification only: the call-site scan (J). The Pay prepare
 * and payment-status callers' handling of a thrown read is the existing
 * coverage in chain-read-deadline.test.ts and payments-reconcile.test.ts.
 * No live RPC, gateway, provider, Turnkey, database, browser or passkey.
 */

const RPC_URL = "https://rpc.ccip-read-test.invalid/redacted-key";
const GATEWAY_HOST = "https://gateway.ccip-read-test.invalid/";
const GATEWAY_URL = `${GATEWAY_HOST}{sender}/{data}.json`;

const OFFCHAIN_LOOKUP_ABI = [
  {
    type: "error",
    name: "OffchainLookup",
    inputs: [
      { name: "sender", type: "address" },
      { name: "urls", type: "string[]" },
      { name: "callData", type: "bytes" },
      { name: "callbackFunction", type: "bytes4" },
      { name: "extraData", type: "bytes" },
    ],
  },
] as const;
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const SELECTOR = {
  balanceOf: toFunctionSelector("balanceOf(address)"),
  decimals: toFunctionSelector("decimals()"),
  proxyCreationCode: toFunctionSelector("proxyCreationCode()"),
  getNonce: toFunctionSelector("getNonce(address,uint192)"),
} as const;
const PROXY_CREATION_CODE_RETURN = encodeAbiParameters([{ type: "bytes" }], ["0x600a600c600039600a6000f3" as Hex]);
const OWNER = getAddress("0xf6c3fe6de636f0d8f421d5485d1a64ff3628cfaf");
const SAFE_FOR_BALANCE = getAddress("0xd9a4c22fb34dc74317edc8006140d66c8fa03266");
const BALANCE = BigInt(20_000_000);
const NONCE_KEY = BigInt(0x1234);
const NONCE = NONCE_KEY << BigInt(64); // sequence 0
const VALID_UNTIL = 1_900_000_000;

// ---- the in-process network -------------------------------------------------

type RpcCall = { method: string; params: unknown[] };
type Answer = { result: unknown } | { error: { code: number; message: string; data?: Hex } };

const wire: RpcCall[] = [];
const refused: string[] = [];
/** Selectors whose eth_call answers with an OffchainLookup revert (sender = the called contract). */
let lookupAt = new Set<string>();

function offchainLookupRevert(sender: Address): Hex {
  return encodeErrorResult({ abi: OFFCHAIN_LOOKUP_ABI, errorName: "OffchainLookup", args: [sender, [GATEWAY_URL], "0x1234", "0xdeadbeef", "0x"] });
}

function answer({ method, params }: RpcCall): Answer {
  if (method === "eth_chainId") return { result: `0x${BASE_SEPOLIA_CHAIN_ID.toString(16)}` };
  if (method === "eth_getBlockByNumber") {
    return params[0] === "finalized"
      ? { result: rpcBlock({ number: BigInt(47_000_900), timestamp: BigInt(VALID_UNTIL + 100) }) }
      : { result: rpcBlock({ number: BigInt(47_001_000), timestamp: BigInt(VALID_UNTIL + 200) }) };
  }
  if (method === "eth_call") {
    const call = params[0] as { to: Address; data: Hex };
    const selector = call.data.slice(0, 10);
    if (lookupAt.has(selector)) return { error: { code: 3, message: "execution reverted", data: offchainLookupRevert(call.to) } };
    if (selector === SELECTOR.balanceOf) return { result: encodeAbiParameters([{ type: "uint256" }], [BALANCE]) };
    if (selector === SELECTOR.decimals) return { result: encodeAbiParameters([{ type: "uint8" }], [REAL_CASH_TOKEN.decimals]) };
    if (selector === SELECTOR.proxyCreationCode) return { result: PROXY_CREATION_CODE_RETURN };
    if (selector === SELECTOR.getNonce) return { result: encodeAbiParameters([{ type: "uint256" }], [NONCE]) };
  }
  return { error: { code: -32601, message: `offline test: unscripted ${method}` } };
}

const networkGuard = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: unknown }).url);
  if (url !== RPC_URL) {
    refused.push(url);
    throw new Error("Unexpected network destination in an offline test.");
  }
  const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] } | unknown[];
  if (Array.isArray(body)) {
    refused.push("batched JSON-RPC body");
    throw new Error("Unexpected batched request in an offline test.");
  }
  const call = { method: body.method, params: body.params ?? [] };
  wire.push(call);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...answer(call) }), { status: 200, headers: { "Content-Type": "application/json" } });
});

/** The factory's exact pre-checkpoint options (HEAD a44e497) — a comparison baseline only. */
const preCheckpointClient = () => createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
/** The existing tests' derivation style: an in-process `custom` transport, no HTTP at all. */
const customTransportClient = () => createPublicClient({ chain: baseSepolia, transport: custom({ request: async (call: RpcCall) => (answer(call) as { result: unknown }).result }, { retryCount: 0 }) });

const methods = () => wire.map((call) => call.method);
const ethCallSelectors = () => wire.filter((call) => call.method === "eth_call").map((call) => (call.params[0] as { data: Hex }).data.slice(0, 10));
const findInChain = (error: unknown, name: string) => (error instanceof BaseError ? error.walk((cause) => (cause as Error | undefined)?.name === name) : null);

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** An OffchainLookup rejection under the real factory: an ordinary viem call failure, never the CCIP-Read path's own error. */
function expectOrdinaryCallFailure(error: unknown) {
  expect(error).toBeInstanceOf(BaseError);
  expect((error as Error).name).toBe("ContractFunctionExecutionError");
  expect(findInChain(error, "OffchainLookupError")).toBeNull();
  expect(findInChain(error, "CallExecutionError")).not.toBeNull();
}

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  wire.length = 0;
  refused.length = 0;
  lookupAt = new Set();
  networkGuard.mockClear();
  vi.stubGlobal("fetch", networkGuard);
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  // Only so every test can prove no timer (transport timeout or caller deadline) is left armed. The
  // fake clock follows real time, so SDK-internal delays (retry backoff, batch scheduling) still elapse.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
});

afterEach(async () => {
  const timersLeft = vi.getTimerCount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);
  expect(timersLeft).toBe(0);
  expect(unhandled).toEqual([]);
  expect(refused).toEqual([]);
});

// ---------------------------------------------------------------------------
// A / B — the configuration the factory actually returns
// ---------------------------------------------------------------------------

describe("A/B: the shared factory's actual configuration", () => {
  it("A: the client createRealPublicClient returns has CCIP-Read disabled", () => {
    expect(createRealPublicClient(RPC_URL).ccipRead).toBe(false);
    expect(createRealPublicClient("https://another.ccip-read-test.invalid/").ccipRead).toBe(false);
    expect(preCheckpointClient().ccipRead).toBeUndefined(); // the SDK default — follows OffchainLookup
    expect(networkGuard).not.toHaveBeenCalled();
  });

  it("B: chain, transport (URL, retries, timeout) and every other setting equal the pre-checkpoint factory's; only ccipRead differs", () => {
    const real = createRealPublicClient(RPC_URL);
    const before = preCheckpointClient();
    expect(real.chain).toBe(baseSepolia);
    expect(real.chain.id).toBe(BASE_SEPOLIA_CHAIN_ID);
    expect(real.transport).toMatchObject({ type: "http", url: RPC_URL, retryCount: 3, retryDelay: 150, timeout: 10_000 });
    expect(real.batch).toBeUndefined(); // no multicall batching: one eth_call per read, as before

    // Settings only: not actions, not per-client namespaces of bound actions (e.g. `token`), not the per-instance uid.
    const isActions = (value: unknown) => typeof value === "function" || (typeof value === "object" && value !== null && Object.values(value).length > 0 && Object.values(value).every((entry) => typeof entry === "function"));
    const settings = (client: object) => Object.fromEntries(Object.entries(client).filter(([key, value]) => !isActions(value) && key !== "uid" && key !== "transport"));
    const transportSettings = (client: { transport: object }) => Object.fromEntries(Object.entries(client.transport).filter(([, value]) => typeof value !== "function"));
    const { ccipRead: realCcipRead, ...realRest } = settings(real);
    const { ccipRead: beforeCcipRead, ...beforeRest } = settings(before);
    expect(realRest).toEqual(beforeRest);
    expect(realRest).toMatchObject({ key: "public", name: "Public Client", type: "publicClient" });
    expect(realCcipRead).toBe(false);
    expect(beforeCcipRead).toBeUndefined();
    expect(transportSettings(real)).toEqual(transportSettings(before));
    expect(Object.keys(real).sort()).toEqual(Object.keys(before).sort()); // same exported client surface
    expect(networkGuard).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// C / D / E — honest reads: the same values from the same requests
// ---------------------------------------------------------------------------

describe("C/D/E: honest reads are unchanged — same values, same requests, in the same order", () => {
  it("C/E: the Cash balance read returns the same balance from the same three requests", async () => {
    const results = [];
    const logs = [];
    for (const client of [createRealPublicClient(RPC_URL), preCheckpointClient()]) {
      wire.length = 0;
      results.push(await readCashBalance({ publicClient: client, safeAddress: SAFE_FOR_BALANCE }));
      logs.push([...wire]);
    }
    expect(results[0]).toEqual({ token: "USDC", decimals: 6, balanceBaseUnits: "20000000" });
    expect(results[1]).toEqual(results[0]);
    expect(logs[0]!.map((call) => call.method)).toEqual(["eth_chainId", "eth_call", "eth_call"]);
    expect(logs[1]).toEqual(logs[0]);
  });

  it("C/E: the chain clock and the EntryPoint proof return the same answers from the same requests", async () => {
    const input = { sender: SAFE_FOR_BALANCE, nonce: NONCE, userOperationHash: `0x${"ef".repeat(32)}` as Hex, prepareBlockNumber: BigInt(47_000_000), validUntil: VALID_UNTIL };
    const results = [];
    const logs = [];
    for (const client of [createRealPublicClient(RPC_URL), preCheckpointClient()]) {
      wire.length = 0;
      results.push({ clock: await readLatestBlockClock(client), proof: await readUserOperationChainState(client, input) });
      logs.push([...wire]);
    }
    expect(results[0]).toEqual({ clock: { number: BigInt(47_001_000), timestamp: BigInt(VALID_UNTIL + 200) }, proof: { kind: "expired_unincluded" } });
    expect(results[1]).toEqual(results[0]);
    expect(logs[0]!.map((call) => call.method)).toEqual(["eth_getBlockByNumber", "eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_getBlockByNumber", "eth_call"]);
    expect(logs[1]).toEqual(logs[0]);
  });

  it("D/E: the Safe derived through the factory is the same Safe as the existing derivation, from one proxyCreationCode eth_call", async () => {
    const owner = createReadOnlyOwnerAccount(OWNER);
    const existing = (await createRealSafeAccount({ owner, publicClient: customTransportClient() })).address;
    expect(wire).toEqual([]); // the custom-transport derivation never touches fetch

    const derived = [];
    const logs = [];
    for (const client of [createRealPublicClient(RPC_URL), preCheckpointClient()]) {
      wire.length = 0;
      derived.push((await createRealSafeAccount({ owner, publicClient: client })).address);
      logs.push([...wire]);
    }
    expect(derived).toEqual([existing, existing]);
    expect(existing).not.toBe(OWNER); // the Safe is the account, never the Turnkey owner
    expect(logs[0]).toHaveLength(1);
    expect(logs[0]![0]!.method).toBe("eth_call");
    expect((logs[0]![0]!.params[0] as { to: string; data: string }).to.toLowerCase()).toBe(REAL_SAFE.proxyFactoryAddress.toLowerCase());
    expect((logs[0]![0]!.params[0] as { data: string }).data).toBe(SELECTOR.proxyCreationCode);
    expect(logs[1]).toEqual(logs[0]);
  });
});

// ---------------------------------------------------------------------------
// F / G — an OffchainLookup revert rejects; no gateway, no callback eth_call
// ---------------------------------------------------------------------------

describe("F/G: an OffchainLookup revert rejects conservatively, with no follow-up lookup", () => {
  it("the fixture is a genuine OffchainLookup revert (EIP-3668 selector 0x556f1830)", () => {
    expect(offchainLookupRevert(REAL_CASH_TOKEN.address).slice(0, 10)).toBe("0x556f1830");
    expect(toFunctionSelector("OffchainLookup(address,string[],bytes,bytes4,bytes)")).toBe("0x556f1830");
  });

  it("control: under the pre-checkpoint options the same revert makes the SDK try the named gateway (refused here, in process)", async () => {
    lookupAt = new Set([SELECTOR.balanceOf]);
    const error = await rejectionOf(preCheckpointClient().readContract({ address: REAL_CASH_TOKEN.address, abi: ERC20_ABI, functionName: "balanceOf", args: [SAFE_FOR_BALANCE] }));
    expect(findInChain(error, "OffchainLookupError")).not.toBeNull();
    expect(refused).toHaveLength(1);
    expect(refused[0]!.startsWith(GATEWAY_HOST)).toBe(true);
    refused.length = 0; // the expected, refused attempt — the afterEach check is for everything else
  });

  it("a direct contract read through the factory rejects as an ordinary failed call: one request, no gateway, no callback eth_call", async () => {
    lookupAt = new Set([SELECTOR.balanceOf]);
    const error = await rejectionOf(createRealPublicClient(RPC_URL).readContract({ address: REAL_CASH_TOKEN.address, abi: ERC20_ABI, functionName: "balanceOf", args: [SAFE_FOR_BALANCE] }));
    expectOrdinaryCallFailure(error);
    expect(methods()).toEqual(["eth_call"]);
    expect(networkGuard).toHaveBeenCalledTimes(1);
  });

  it("Safe derivation: no address is produced — not the owner, not a fallback — from one request", async () => {
    lookupAt = new Set([SELECTOR.proxyCreationCode]);
    const error = await rejectionOf(createRealSafeAccount({ owner: createReadOnlyOwnerAccount(OWNER), publicClient: createRealPublicClient(RPC_URL) }));
    expectOrdinaryCallFailure(error);
    expect(ethCallSelectors()).toEqual([SELECTOR.proxyCreationCode]);
    expect(networkGuard).toHaveBeenCalledTimes(1);
  });

  it("Cash balance read: rejects with the ordinary error — never a balance, never zero — and its caller deadline is cleared, not fired", async () => {
    lookupAt = new Set([SELECTOR.balanceOf]);
    const error = await rejectionOf(readCashBalance({ publicClient: createRealPublicClient(RPC_URL), safeAddress: SAFE_FOR_BALANCE }));
    expectOrdinaryCallFailure(error);
    expect((error as Error).name).not.toBe("CashBalanceReadDeadlineError");
    expect(methods()).toEqual(["eth_chainId", "eth_call", "eth_call"]);
    expect(ethCallSelectors().sort()).toEqual([SELECTOR.balanceOf, SELECTOR.decimals].sort());
  });

  it("EntryPoint proof: a nonce read that demands a lookup rejects — never unresolved, included or expired_unincluded — and starts no later stage", async () => {
    lookupAt = new Set([SELECTOR.getNonce]);
    const client = createRealPublicClient(RPC_URL);
    const error = await rejectionOf(
      readUserOperationChainState(client, { sender: SAFE_FOR_BALANCE, nonce: NONCE, userOperationHash: `0x${"ef".repeat(32)}` as Hex, prepareBlockNumber: BigInt(47_000_000), validUntil: VALID_UNTIL }),
    );
    expectOrdinaryCallFailure(error);
    expect((error as Error).name).not.toBe("ChainReadDeadlineError");
    expect(methods()).toEqual(["eth_chainId", "eth_getBlockByNumber", "eth_call"]);
  });
});

// ---------------------------------------------------------------------------
// H / I / J / K — existing callers through the real factory
// ---------------------------------------------------------------------------

const SECRET = "test-session-secret";

async function seedActiveAccount() {
  const registry = createInMemoryRealAccountRegistry();
  await registry.createAccountWithPasskey({
    account: { appUserId: "app-user-1", subOrganizationId: "sub-org-1", turnkeyUserId: "turnkey-user-1", walletId: "wallet-1", walletAccountId: "wallet-account-1", ownerAddress: OWNER, safeAddress: SAFE_FOR_BALANCE, accountConfigVersion: 1 },
    passkey: { credentialId: "credential-1", appUserId: "app-user-1", credentialPublicKey: "cose-key", userHandle: "user-handle-1", counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
  });
  return registry;
}

const config: RealServerConfig = {
  turnkeyApiBaseUrl: "https://api.turnkey.com",
  turnkeyParentOrganizationId: "parent-org",
  turnkeyApiPublicKey: "pub",
  turnkeyApiPrivateKey: "priv",
  sessionSecret: "4be1c0d27a9f3e8d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605",
  rpId: "localhost",
  rpName: "Test",
  expectedOrigins: ["http://localhost:3000"],
  rpcUrl: RPC_URL,
  pimlicoApiKey: "pim_test_key",
};

let seq = 0;
async function seedTurnkeyCreated(attempts: RegistrationAttemptStore) {
  seq += 1;
  const credentialId = bytesToBase64Url(randomBytes(16));
  await attempts.createVerified({
    credentialId,
    appUserId: `app-user-${seq}`,
    userHandle: `handle-${seq}`,
    credentialPublicKey: `cose-${seq}`,
    counter: 0,
    transports: ["internal"],
    credentialDeviceType: "singleDevice",
    credentialBackedUp: false,
    registrationChallenge: `challenge-${seq}`,
    rawClientDataJson: "client-data",
    rawAttestationObject: "attestation",
  });
  return seedTurnkeyCreatedThroughEvidence(attempts, credentialId, {
    subOrganizationId: `sub-org-${seq}`,
    turnkeyUserId: `turnkey-user-${seq}`,
    walletId: `wallet-${seq}`,
    walletAccountId: `wallet-account-${seq}`,
    ownerAddress: OWNER,
  });
}

describe("H/I/J/K: existing callers keep their classifications through the real factory", () => {
  it("account balance (server): a lookup is the existing fixed read_failed outcome — never a balance; the honest read is ready", async () => {
    const registry = await seedActiveAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const resolve = () => resolveAuthenticatedCashBalance({ cookieValue, sessionSecret: SECRET, registry, publicClient: createRealPublicClient(RPC_URL), providerBudgetLimiter: openBudget() });

    expect(await resolve()).toEqual({ outcome: "ready", balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" } });
    wire.length = 0;
    lookupAt = new Set([SELECTOR.balanceOf]);
    expect(await resolve()).toEqual({ outcome: "read_failed", reason: "Could not read your balance right now. Try again in a moment." });
    expect(methods()).toEqual(["eth_chainId", "eth_call", "eth_call"]);
  });

  it("onboarding (server, production's own factory call): honest derivation finalizes once with the same Safe; a lookup rejects with no finalize, account, session, Turnkey request or attempt write", async () => {
    const turnkey = new FakeParentTurnkey();
    const registry = createInMemoryRealAccountRegistry();
    const attempts = createInMemoryRegistrationAttemptStore();
    const finalize = vi.spyOn(attempts, "finalize");
    const expectedSafe = (await createRealSafeAccount({ owner: createReadOnlyOwnerAccount(OWNER), publicClient: customTransportClient() })).address;

    // Honest: no client injected, so runProvisioningPipeline calls createRealPublicClient(config.rpcUrl) itself.
    const honest = await seedTurnkeyCreated(attempts);
    const outcome = await runProvisioningPipeline({ config, registry, attempts, attempt: honest, provisioningDeps: turnkey.deps() });
    expect(outcome.outcome).toBe("verified");
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize.mock.calls[0]![0]).toMatchObject({ safeAddress: expectedSafe, safeOwnerAddress: OWNER });
    expect(ethCallSelectors()).toEqual([SELECTOR.proxyCreationCode]);

    // A lookup on the same derivation read.
    wire.length = 0;
    finalize.mockClear();
    lookupAt = new Set([SELECTOR.proxyCreationCode]);
    const pending = await seedTurnkeyCreated(attempts);
    const snapshot = structuredClone(await attempts.findByCredentialId(pending.credentialId));
    const error = await rejectionOf(runProvisioningPipeline({ config, registry, attempts, attempt: pending, provisioningDeps: turnkey.deps() }));
    expectOrdinaryCallFailure(error); // passed through the derivation deadline unchanged
    expect((error as Error).name).not.toBe("OnboardingSafeDerivationDeadlineError");
    expect(finalize).not.toHaveBeenCalled();
    expect(await attempts.findByCredentialId(pending.credentialId)).toEqual(snapshot);
    expect(await registry.findAccountByAppUserId(pending.appUserId)).toBeNull();
    expect(await registry.findPasskeyByCredentialId(pending.credentialId)).toBeNull();
    expect(turnkey.requests).toEqual([]);
    expect(ethCallSelectors()).toEqual([SELECTOR.proxyCreationCode]);
  });

  it("Pay signing (browser path): the factory's client derives the held Safe and reaches the local calldata check; a lookup rejects before any passkey prompt or signature", async () => {
    const stamp = vi.spyOn(WebauthnStamper.prototype, "stamp");
    const safe = (await createRealSafeAccount({ owner: createReadOnlyOwnerAccount(OWNER), publicClient: customTransportClient() })).address;
    const sign = () =>
      signPreparedPayment({
        fields: {
          sender: safe,
          nonce: "0",
          factory: null,
          factoryData: null,
          callData: "0x", // deliberately not the held transfer: the flow must stop at L-1b's local check
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
        },
        rpId: "localhost",
        subOrganizationId: "sub-org-1",
        ownerAddress: OWNER,
        rpcUrl: RPC_URL,
        authorizingCredentialId: "credential-1",
        nowSeconds: VALID_UNTIL - 600,
        expected: { recipient: "0x3333333333333333333333333333333333333333", amountBaseUnits: "1000000" },
      });

    // Honest: the derived Safe matches the held sender, so the flow reaches the calldata comparison.
    expect(((await rejectionOf(sign())) as Error).message).toBe(PAYMENT_DETAILS_UNVERIFIED);
    expect(ethCallSelectors()).toEqual([SELECTOR.proxyCreationCode]);

    wire.length = 0;
    lookupAt = new Set([SELECTOR.proxyCreationCode]);
    expectOrdinaryCallFailure(await rejectionOf(sign()));
    expect(ethCallSelectors()).toEqual([SELECTOR.proxyCreationCode]);
    expect(stamp).not.toHaveBeenCalled();
  });

  it("J (static source scan, not integration): every production chain public client is built by this one factory, at the five known call sites", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path.relative(root, full));
      }
    };
    for (const dir of ["lib", "app", "components"]) walk(path.join(root, dir));
    const containing = (needle: string) => files.filter((file) => readFileSync(path.join(root, file), "utf8").includes(needle)).sort();

    expect(containing("createPublicClient(")).toEqual(["lib/real/chain/client.ts"]);
    expect(containing("ccipRead")).toEqual(["lib/real/chain/client.ts"]);
    expect(containing("createRealPublicClient(")).toEqual(
      [
        "app/api/real/account/balance/route.ts",
        "app/api/real/payments/[id]/status/route.ts",
        "app/api/real/payments/prepare/route.ts",
        "lib/real/chain/client.ts",
        "lib/real/payments/client-sign.ts",
        "lib/real/server/onboarding.ts",
      ].sort(),
    );
  });
});
