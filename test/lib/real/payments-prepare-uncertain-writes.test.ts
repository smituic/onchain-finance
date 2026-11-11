// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createPublicClient, custom, encodeAbiParameters } from "viem";
import { baseSepolia } from "viem/chains";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { createInMemoryPaymentAttemptStore, type PaymentAttempt, type PaymentAttemptStore } from "@/lib/real/server/payment-attempts";
import { freshRateLimiter } from "./fixtures/rate-limit";

/**
 * L-2 C-1 — a prepare-time database write that THROWS must answer the fixed
 * `prepare_outcome_uncertain` outcome, never "failed" and never a raw error.
 * A thrown write is not proof of rollback: the write may have committed with
 * its response lost. Nothing follows an uncertain write: no second write, no
 * read-back, no new provider call, no cleanup of a possibly-committed state.
 *
 * Everything is local: the in-memory payment store (wrapped to simulate a
 * write that fails before applying, or applies and then loses its response),
 * a faked chain RPC (balance only), a mocked chain-clock reader and a mocked
 * Pimlico module. Nothing leaves the process.
 */

const SECRET = "7f3c9a1e5b2d4f60a8c7e9b1d3f5a7c90e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f";
const OWNER_ADDRESS = "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF";
const SAFE_ADDRESS = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
const OTHER_ADDRESS = "0x3333333333333333333333333333333333333333";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const BALANCE_OF_SELECTOR = "0x70a08231";
const DECIMALS_SELECTOR = "0x313ce567";
const SAFE_PREPARE_FAILED = "Could not prepare this payment right now. Try again in a moment.";
const SAFE_SENDER_MISMATCH = "Could not prepare this payment — your account isn't set up correctly.";
const UNCERTAIN_MESSAGE = "We couldn't confirm this payment's setup. No money was sent by this request. Refresh the app to check its status before trying again.";
const SECRET_ERROR_TEXT = 'connection to "postgres://user:hunter2-password@db.internal/ocf" lost (apikey=PIMLICO_SECRET_KEY)';
const VALID_TIMESTAMP = BigInt(1_900_000_000);
const VALID_NUMBER = BigInt(47_000_000);

const preparedFields = {
  sender: SAFE_ADDRESS,
  nonce: BigInt(0),
  factory: undefined,
  factoryData: undefined,
  callData: "0xcalldata",
  callGasLimit: BigInt(80_000),
  verificationGasLimit: BigInt(150_000),
  preVerificationGas: BigInt(60_000),
  maxFeePerGas: BigInt(2_000_000),
  maxPriorityFeePerGas: BigInt(1_000_000),
  paymaster: undefined,
  paymasterData: undefined,
  paymasterVerificationGasLimit: undefined,
  paymasterPostOpGasLimit: undefined,
} as const;

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  clock: vi.fn(),
  hash: vi.fn(),
}));

vi.mock("@/lib/real/server/pimlico", () => ({
  prepareCashTransferUserOperation: (...args: unknown[]) => mocks.prepare(...args),
  sendPreparedUserOperation: vi.fn(),
  fetchUserOperationReceipt: vi.fn(),
}));

vi.mock("@/lib/real/chain/entry-point", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/real/chain/entry-point")>();
  return { ...original, readLatestBlockClock: (...args: unknown[]) => mocks.clock(...args) };
});

vi.mock("@/lib/real/payments/hash", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/real/payments/hash")>();
  return { ...original, computeExpectedUserOperationHash: (...args: unknown[]) => mocks.hash(...args) };
});

const { resolvePreparePayment } = await import("@/lib/real/server/payments");
type PrepareRecipientSelector = NonNullable<Parameters<typeof resolvePreparePayment>[0]["recipient"]>;

async function seedAccount() {
  const registry = createInMemoryRealAccountRegistry();
  await registry.createAccountWithPasskey({
    account: {
      appUserId: "app-user-1",
      subOrganizationId: "sub-org-1",
      turnkeyUserId: "turnkey-user-1",
      walletId: "wallet-1",
      walletAccountId: "wallet-account-1",
      ownerAddress: OWNER_ADDRESS,
      safeAddress: SAFE_ADDRESS,
      accountConfigVersion: 1,
    },
    passkey: {
      credentialId: "credential-1",
      appUserId: "app-user-1",
      credentialPublicKey: "cose-key",
      userHandle: "user-handle-1",
      counter: 0,
      transports: ["internal"],
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    },
  });
  return registry;
}

/** The chain RPC answers only the balance read: the clock is mocked, so any other call would throw. */
function buildPublicClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
        if (method === "eth_call") {
          const selector = ((params?.[0] ?? {}) as { data?: string }).data?.slice(0, 10);
          if (selector === BALANCE_OF_SELECTOR) return encodeAbiParameters([{ type: "uint256" }], [BigInt(100_000_000)]);
          if (selector === DECIMALS_SELECTOR) return encodeAbiParameters([{ type: "uint8" }], [6]);
        }
        throw new Error(`Unexpected method in an offline test: ${method}`);
      },
    }),
  });
}

type TransitionInput = Parameters<PaymentAttemptStore["transition"]>[0];

type Harness = {
  store: PaymentAttemptStore;
  realTransition: PaymentAttemptStore["transition"];
  realReserve: PaymentAttemptStore["reserve"];
  transition: MockInstance<PaymentAttemptStore["transition"]>;
  reserve: MockInstance<PaymentAttemptStore["reserve"]>;
  run: () => ReturnType<typeof resolvePreparePayment>;
  row: () => Promise<PaymentAttempt | null>;
};

async function harness(): Promise<Harness> {
  const registry = await seedAccount();
  const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
  const store = createInMemoryPaymentAttemptStore();
  const realTransition = store.transition.bind(store);
  const realReserve = store.reserve.bind(store);
  const transition = vi.spyOn(store, "transition");
  const reserve = vi.spyOn(store, "reserve");
  return {
    store,
    realTransition,
    realReserve,
    transition,
    reserve,
    run: () =>
      resolvePreparePayment({
        cookieValue,
        sessionSecret: SECRET,
        registry,
        paymentStore: store,
        rateLimiter: freshRateLimiter(),
        publicClient: buildPublicClient(),
        pimlicoApiKey: "pim_test_key",
        recipient: { kind: "address", value: RECIPIENT } as PrepareRecipientSelector,
        amountBaseUnitsInput: "1000000",
      }),
    row: () => store.findLatestByAppUserId("app-user-1"),
  };
}

beforeEach(() => {
  mocks.prepare.mockReset();
  mocks.clock.mockReset();
  mocks.hash.mockReset();
  mocks.prepare.mockImplementation(async () => ({ ...preparedFields }));
  mocks.clock.mockImplementation(async () => ({ number: VALID_NUMBER, timestamp: VALID_TIMESTAMP }));
  mocks.hash.mockImplementation(() => `0x${"ab".repeat(32)}`);
});

/** Simulates a write that throws BEFORE anything is applied. */
function throwBeforeApplying(h: Harness, matches: (input: TransitionInput) => boolean = () => true) {
  h.transition.mockImplementation(async (input: TransitionInput) => {
    if (matches(input)) throw new Error(SECRET_ERROR_TEXT);
    return h.realTransition(input);
  });
}

/** Simulates a write that COMMITS and then loses its response (throws). */
function applyThenThrow(h: Harness, matches: (input: TransitionInput) => boolean = () => true) {
  h.transition.mockImplementation(async (input: TransitionInput) => {
    const result = await h.realTransition(input);
    if (matches(input)) throw new Error(SECRET_ERROR_TEXT);
    return result;
  });
}

type Path = {
  name: string;
  /** The one write that is made to throw. */
  to: "failed" | "awaiting_authorization";
  setup: (h: Harness) => void;
  providerCalls: number;
  /** State after a throw that never applied / after an apply-then-throw. */
  stateWhenNotApplied: "prepared";
  stateWhenApplied: "failed" | "awaiting_authorization";
};

const PATHS: Path[] = [
  {
    name: "W2a (reserved recipient/amount mismatch)",
    to: "failed",
    setup: (h) => {
      h.reserve.mockImplementation(async (input: Parameters<PaymentAttemptStore["reserve"]>[0]) => {
        const reserved = await h.realReserve(input);
        if (!reserved.ok) return reserved;
        return { ...reserved, attempt: { ...reserved.attempt, amountBaseUnits: "999" } };
      });
    },
    providerCalls: 0,
    stateWhenNotApplied: "prepared",
    stateWhenApplied: "failed",
  },
  {
    name: "W2b (Pimlico preparation / binding / L-1a failure)",
    to: "failed",
    setup: () => {
      mocks.prepare.mockImplementation(async () => {
        throw new Error(`PreparedCallDataMismatchError ${SECRET_ERROR_TEXT}`);
      });
    },
    providerCalls: 1,
    stateWhenNotApplied: "prepared",
    stateWhenApplied: "failed",
  },
  {
    name: "W2c (sender mismatch)",
    to: "failed",
    setup: () => {
      mocks.prepare.mockImplementation(async () => ({ ...preparedFields, sender: OTHER_ADDRESS }));
    },
    providerCalls: 1,
    stateWhenNotApplied: "prepared",
    stateWhenApplied: "failed",
  },
  {
    name: "W2d (L-2 B local-construction cleanup)",
    to: "failed",
    setup: () => {
      mocks.hash.mockImplementation(() => {
        throw new Error("local failure");
      });
    },
    providerCalls: 1,
    stateWhenNotApplied: "prepared",
    stateWhenApplied: "failed",
  },
  {
    name: "W3 (final prepared -> awaiting_authorization)",
    to: "awaiting_authorization",
    setup: () => {},
    providerCalls: 1,
    stateWhenNotApplied: "prepared",
    stateWhenApplied: "awaiting_authorization",
  },
];

function expectFixedUncertain(outcome: unknown) {
  expect(outcome).toEqual({ outcome: "prepare_outcome_uncertain" });
  const text = JSON.stringify(outcome);
  expect(text).not.toMatch(/postgres|hunter2|password|apikey|PIMLICO_SECRET|local failure/i);
}

describe.each(PATHS)("C-1 $name", (path) => {
  const target = (input: TransitionInput) => input.to === path.to;

  it("SCENARIO 1 — the write throws without applying: fixed uncertain outcome, one write, no retry, no further provider call", async () => {
    const h = await harness();
    path.setup(h);
    throwBeforeApplying(h, target);

    const outcome = await h.run();

    expectFixedUncertain(outcome);
    expect(h.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).toHaveBeenCalledTimes(path.providerCalls);
    expect(h.transition).toHaveBeenCalledTimes(1);
    const row = await h.row();
    expect(row).not.toBeNull();
    const [input] = h.transition.mock.calls[0];
    expect(input).toEqual(expect.objectContaining({ id: row!.id, from: "prepared", to: path.to }));
    // Nothing was applied, nothing else was attempted: the row is exactly where it was.
    expect(row!.state).toBe(path.stateWhenNotApplied);
  });

  it("SCENARIO 2 — the write applies, then throws (lost response): fixed uncertain outcome, the applied state stays, no second write", async () => {
    const h = await harness();
    path.setup(h);
    applyThenThrow(h, target);

    const outcome = await h.run();

    expectFixedUncertain(outcome);
    expect(h.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).toHaveBeenCalledTimes(path.providerCalls);
    expect(h.transition).toHaveBeenCalledTimes(1);
    const row = await h.row();
    expect(row).not.toBeNull();
    const [input] = h.transition.mock.calls[0];
    expect(input).toEqual(expect.objectContaining({ id: row!.id, from: "prepared", to: path.to }));
    // The possibly-committed state is never regressed or overwritten.
    expect(row!.state).toBe(path.stateWhenApplied);
  });
});

describe("C-1 — outcomes that are NOT uncertain stay exactly as they were", () => {
  it.each([
    ["W2a", 0, SAFE_PREPARE_FAILED],
    ["W2b", 1, SAFE_PREPARE_FAILED],
    ["W2c", 2, SAFE_SENDER_MISMATCH],
    ["W2d", 3, SAFE_PREPARE_FAILED],
  ] as const)("%s success: the existing prepare_failed reason is unchanged when the failure write succeeds", async (_name, index, reason) => {
    const h = await harness();
    PATHS[index].setup(h);
    expect(await h.run()).toEqual({ outcome: "prepare_failed", reason });
    expect((await h.row())?.state).toBe("failed");
    expect(h.transition).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["W2a", 0, SAFE_PREPARE_FAILED],
    ["W2b", 1, SAFE_PREPARE_FAILED],
    ["W2c", 2, SAFE_SENDER_MISMATCH],
    ["W2d", 3, SAFE_PREPARE_FAILED],
  ] as const)("%s: a null CAS result (a concurrent cancel won) is accepted as-is: ordinary prepare_failed, one write, cancel survives", async (_name, index, reason) => {
    const h = await harness();
    PATHS[index].setup(h);
    h.transition.mockImplementation(async (input: TransitionInput) => {
      if (input.to === "failed") await h.realTransition({ id: input.id, from: "prepared", to: "cancelled" });
      return h.realTransition(input);
    });

    const outcome = await h.run();

    expect(outcome).toEqual({ outcome: "prepare_failed", reason });
    expect((await h.row())?.state).toBe("cancelled");
    expect(h.transition.mock.calls.filter(([input]) => input.to === "failed")).toHaveLength(1);
  });

  it("W3: a null result keeps its existing answer and text unchanged, with no cleanup", async () => {
    const h = await harness();
    h.transition.mockImplementation(async () => null);

    const outcome = await h.run();

    expect(outcome).toEqual({ outcome: "prepare_failed", reason: "Could not persist the prepared payment." });
    expect(h.transition).toHaveBeenCalledTimes(1);
    expect(h.transition.mock.calls.some(([input]) => input.to === "failed")).toBe(false);
  });

  it("success still returns ready, signs and submits nothing, and writes exactly once", async () => {
    const h = await harness();

    const outcome = await h.run();

    expect(outcome.outcome).toBe("ready");
    expect((await h.row())?.state).toBe("awaiting_authorization");
    expect(h.transition).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });
});

describe("C-1 W2d — the L-2 B cleanup helper", () => {
  const breakLocalConstruction = () =>
    mocks.hash.mockImplementation(() => {
      throw new Error("local failure");
    });

  it("cleanup succeeds: the existing safe prepare_failed, row failed", async () => {
    const h = await harness();
    breakLocalConstruction();
    expect(await h.run()).toEqual({ outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED });
    expect((await h.row())?.state).toBe("failed");
    expect(h.transition).toHaveBeenCalledTimes(1);
  });

  it("cleanup returns null: the existing safe prepare_failed, no retry", async () => {
    const h = await harness();
    breakLocalConstruction();
    h.transition.mockImplementation(async () => null);
    expect(await h.run()).toEqual({ outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED });
    expect(h.transition).toHaveBeenCalledTimes(1);
  });

  it("cleanup throws before applying: uncertain, exactly one cleanup attempt, row untouched", async () => {
    const h = await harness();
    breakLocalConstruction();
    throwBeforeApplying(h);
    expectFixedUncertain(await h.run());
    expect(h.transition).toHaveBeenCalledTimes(1);
    expect((await h.row())?.state).toBe("prepared");
  });

  it("cleanup applies then throws: uncertain, exactly one cleanup attempt, no second", async () => {
    const h = await harness();
    breakLocalConstruction();
    applyThenThrow(h);
    expectFixedUncertain(await h.run());
    expect(h.transition).toHaveBeenCalledTimes(1);
    expect((await h.row())?.state).toBe("failed");
  });

  it("only a THROWN cleanup write changes the outcome: the local construction failing alone is still prepare_failed", async () => {
    const h = await harness();
    breakLocalConstruction();
    const outcome = await h.run();
    expect(outcome.outcome).toBe("prepare_failed");
  });
});

describe("C-1 W3 — the final write can never be followed by a cleanup", () => {
  it("behavior: a throwing final write never produces a prepared -> failed transition, in either scenario", async () => {
    for (const simulate of [throwBeforeApplying, applyThenThrow]) {
      const h = await harness();
      simulate(h, (input) => input.to === "awaiting_authorization");
      await h.run();
      expect(h.transition.mock.calls.map(([input]) => input.to)).toEqual(["awaiting_authorization"]);
    }
  });

  it("source guard: the W3 catch returns the uncertain outcome directly and references no cleanup/write helper", () => {
    const source = readFileSync(resolve(process.cwd(), "lib/real/server/payments.ts"), "utf8");
    const start = source.indexOf('to: "awaiting_authorization", patch });\n  } catch {');
    expect(start).toBeGreaterThan(-1);
    const catchBlock = source.slice(start, source.indexOf("}\n", source.indexOf("} catch {", start)));
    expect(catchBlock).toContain("uncertainPrepareOutcome()");
    expect(catchBlock).not.toMatch(/failPrepared|transition\(|to: "failed"/);
  });
});

describe("C-1 — the prepare route", () => {
  const ENV = {
    NEXT_PUBLIC_REAL_MODE_ENABLED: "true",
    TURNKEY_PARENT_ORGANIZATION_ID: "sub-org-1",
    TURNKEY_API_PUBLIC_KEY: "public-key",
    TURNKEY_API_PRIVATE_KEY: "private-key",
    REAL_SESSION_SECRET: SECRET,
    NEXT_PUBLIC_REAL_RP_ID: "localhost",
    NEXT_PUBLIC_REAL_ORIGIN: "http://localhost:3000",
    PIMLICO_API_KEY: "pim_test_key",
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("next/headers");
    vi.doUnmock("@/lib/real/server/runtime");
    vi.doUnmock("@/lib/real/chain/client");
  });

  async function routeHarness(overrides: { paymentStore?: PaymentAttemptStore; rateLimiter?: unknown } = {}) {
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
    vi.resetModules();
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const paymentStore = overrides.paymentStore ?? createInMemoryPaymentAttemptStore();
    const rateLimiter = overrides.rateLimiter ?? freshRateLimiter();
    vi.doMock("@/lib/real/server/runtime", () => ({
      getRealAccountRegistry: () => registry,
      getPaymentAttemptStore: () => paymentStore,
      getRateLimiter: () => rateLimiter,
    }));
    vi.doMock("@/lib/real/chain/client", () => ({ createRealPublicClient: () => buildPublicClient() }));
    const { REAL_SESSION_COOKIE_NAME } = await import("@/lib/real/server/session");
    vi.doMock("next/headers", () => ({
      cookies: async () => ({ get: (name: string) => (name === REAL_SESSION_COOKIE_NAME ? { value: cookieValue } : undefined), set: () => {}, delete: () => {} }),
    }));
    const { POST } = await import("@/app/api/real/payments/prepare/route");
    const post = () =>
      POST(
        new Request("http://localhost/api/real/payments/prepare", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recipient: RECIPIENT, amountBaseUnits: "1000000" }),
        }),
      );
    return { post, paymentStore };
  }

  it("a thrown final write answers exactly HTTP 500, the new code and the fixed message, with no Retry-After and no secrets", async () => {
    const store = createInMemoryPaymentAttemptStore();
    const real = store.transition.bind(store);
    vi.spyOn(store, "transition").mockImplementation(async (input) => {
      await real(input);
      throw new Error(SECRET_ERROR_TEXT);
    });
    const { post } = await routeHarness({ paymentStore: store });

    const response = await post();

    expect(response.status).toBe(500);
    expect(response.headers.get("Retry-After")).toBeNull();
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ error: UNCERTAIN_MESSAGE, code: "prepare_outcome_uncertain" });
    expect(raw).not.toMatch(/postgres|hunter2|password|apikey|PIMLICO_SECRET/i);
  });

  it("a thrown failure-marking write (W2b) answers the same fixed body", async () => {
    mocks.prepare.mockImplementation(async () => {
      throw new Error(SECRET_ERROR_TEXT);
    });
    const store = createInMemoryPaymentAttemptStore();
    vi.spyOn(store, "transition").mockImplementation(async () => {
      throw new Error(SECRET_ERROR_TEXT);
    });
    const { post } = await routeHarness({ paymentStore: store });

    const response = await post();

    expect(response.status).toBe(500);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(await response.json()).toEqual({ error: UNCERTAIN_MESSAGE, code: "prepare_outcome_uncertain" });
  });

  it("a known prepare_failed keeps its existing 502 and body", async () => {
    mocks.prepare.mockImplementation(async () => {
      throw new Error(SECRET_ERROR_TEXT);
    });
    const { post } = await routeHarness();

    const response = await post();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: SAFE_PREPARE_FAILED });
  });

  it("a successful ready response is unchanged", async () => {
    const { post } = await routeHarness();

    const response = await post();

    expect(response.status).toBe(200);
    const body = (await response.json()) as { attempt: { state: string }; authorizingCredentialId: string };
    expect(body.attempt.state).toBe("awaiting_authorization");
    expect(body.authorizingCredentialId).toBe("credential-1");
  });

  it("a reservation throw keeps the generic 500 (no new code)", async () => {
    const store = createInMemoryPaymentAttemptStore();
    vi.spyOn(store, "reserve").mockImplementation(async () => {
      throw new Error(SECRET_ERROR_TEXT);
    });
    const { post } = await routeHarness({ paymentStore: store });

    const response = await post();

    expect(response.status).toBe(500);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ error: "Something went wrong. Please try again." });
    expect(raw).not.toMatch(/postgres|hunter2/i);
  });

  it("a limiter throw keeps the generic 500 (no new code)", async () => {
    const { post } = await routeHarness({
      rateLimiter: {
        consume: async () => {
          throw new Error(SECRET_ERROR_TEXT);
        },
      },
    });

    const response = await post();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Something went wrong. Please try again." });
  });
});
