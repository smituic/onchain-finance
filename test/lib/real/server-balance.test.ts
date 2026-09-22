import { describe, expect, it } from "vitest";
import { createPublicClient, custom, encodeAbiParameters } from "viem";
import { baseSepolia } from "viem/chains";
import { resolveAuthenticatedCashBalance } from "@/lib/real/server/balance";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { REAL_CASH_TOKEN } from "@/lib/real/constants";

const SECRET = "test-session-secret";
const OWNER_ADDRESS = "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF";
const SAFE_ADDRESS = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
const BALANCE_OF_SELECTOR = "0x70a08231";
const DECIMALS_SELECTOR = "0x313ce567";

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

function buildPublicClient(balance: bigint, decimals = 6) {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
        if (method === "eth_call") {
          const call = (params?.[0] ?? {}) as { to?: string; data?: string };
          expect(call.to?.toLowerCase()).toBe(REAL_CASH_TOKEN.address.toLowerCase());
          const selector = call.data?.slice(0, 10);
          if (selector === BALANCE_OF_SELECTOR) {
            // The Safe address, never the Turnkey owner address, must be
            // what's encoded into the balanceOf() call.
            expect(call.data?.toLowerCase()).toContain(SAFE_ADDRESS.slice(2).toLowerCase());
            expect(call.data?.toLowerCase()).not.toContain(OWNER_ADDRESS.slice(2).toLowerCase());
            return encodeAbiParameters([{ type: "uint256" }], [balance]);
          }
          if (selector === DECIMALS_SELECTOR) return encodeAbiParameters([{ type: "uint8" }], [decimals]);
          throw new Error(`Unexpected selector: ${selector}`);
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    }),
  });
}

describe("resolveAuthenticatedCashBalance", () => {
  it("an authenticated session reads the balance for its durable SAFE address, never the Turnkey owner address", async () => {
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), SECRET);
    const publicClient = buildPublicClient(BigInt(20_000_000));

    const result = await resolveAuthenticatedCashBalance({ cookieValue, sessionSecret: SECRET, registry, publicClient });

    expect(result).toEqual({ outcome: "ready", balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" } });
  });

  it("a client-supplied safeAddress has no effect — there is no input parameter for it at all", async () => {
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), SECRET);
    const publicClient = buildPublicClient(BigInt(5_000_000));

    // resolveAuthenticatedCashBalance's input type has no address field to
    // pass — this call only compiles because that's true. The transport
    // mock's own assertions (SAFE_ADDRESS used, OWNER_ADDRESS never used)
    // are the real proof; this test names the property explicitly.
    const result = await resolveAuthenticatedCashBalance({ cookieValue, sessionSecret: SECRET, registry, publicClient });
    expect(result.outcome).toBe("ready");
  });

  it("zero balance resolves to a genuine zero, not an error", async () => {
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), SECRET);
    const publicClient = buildPublicClient(BigInt(0));

    const result = await resolveAuthenticatedCashBalance({ cookieValue, sessionSecret: SECRET, registry, publicClient });
    expect(result).toEqual({ outcome: "ready", balance: { token: "USDC", decimals: 6, balanceBaseUnits: "0" } });
  });

  it("rejects an unauthenticated request (no session cookie) without ever attempting a chain read", async () => {
    const registry = await seedAccount();
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: custom({
        request: async () => {
          throw new Error("must not read the chain for an unauthenticated request");
        },
      }),
    });

    const result = await resolveAuthenticatedCashBalance({ cookieValue: undefined, sessionSecret: SECRET, registry, publicClient });
    expect(result).toEqual({ outcome: "unauthenticated" });
  });

  it("rejects a tampered/invalid session cookie the same as no cookie", async () => {
    const registry = await seedAccount();
    const publicClient = buildPublicClient(BigInt(0));
    const result = await resolveAuthenticatedCashBalance({ cookieValue: "garbage", sessionSecret: SECRET, registry, publicClient });
    expect(result).toEqual({ outcome: "unauthenticated" });
  });

  it("an RPC/network read failure is reported distinctly — never silently reported as a zero balance", async () => {
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), SECRET);
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: custom({
        request: async ({ method }: { method: string }) => {
          if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
          throw new Error("RPC unreachable");
        },
      }),
    });

    const result = await resolveAuthenticatedCashBalance({ cookieValue, sessionSecret: SECRET, registry, publicClient });
    expect(result.outcome).toBe("read_failed");
  });

  it("pre-2f hardening: never returns a raw upstream RPC error — even one carrying the provider URL/API key", async () => {
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), SECRET);
    const secretBearingMessage = "HTTP request failed. URL: https://base-sepolia.g.alchemy.com/v2/SECRET_ALCHEMY_KEY Version: viem@2.0.0";
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: custom({
        request: async ({ method }: { method: string }) => {
          if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
          throw new Error(secretBearingMessage);
        },
      }),
    });

    const result = await resolveAuthenticatedCashBalance({ cookieValue, sessionSecret: SECRET, registry, publicClient });
    expect(result.outcome).toBe("read_failed");
    if (result.outcome !== "read_failed") return;
    for (const forbidden of ["SECRET_ALCHEMY_KEY", "alchemy.com", "viem@"]) {
      expect(result.reason).not.toContain(forbidden);
    }
  });

  it("a wrong-chain RPC is reported as a read failure, never a balance", async () => {
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), SECRET);
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: custom({
        request: async ({ method }: { method: string }) => {
          if (method === "eth_chainId") return "0x1"; // mainnet, not Base Sepolia
          throw new Error("should not reach eth_call after a chain mismatch");
        },
      }),
    });

    const result = await resolveAuthenticatedCashBalance({ cookieValue, sessionSecret: SECRET, registry, publicClient });
    expect(result.outcome).toBe("read_failed");
  });
});
