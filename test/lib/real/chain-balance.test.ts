import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPublicClient, custom, encodeAbiParameters } from "viem";
import { baseSepolia } from "viem/chains";
import { REAL_CASH_TOKEN } from "@/lib/real/constants";
import { readCashBalance } from "@/lib/real/chain/balance";

const SAFE_ADDRESS = "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF";
// Well-known, standard ERC20 selectors (balanceOf(address), decimals()) —
// stable across every ERC20, not something this test derives from
// balance.ts's own ABI, so a typo in balance.ts's ABI would still surface
// as a mismatch here rather than both sides agreeing on a shared mistake.
const BALANCE_OF_SELECTOR = "0x70a08231";
const DECIMALS_SELECTOR = "0x313ce567";

function buildPublicClient(input: { chainId?: number; balance: bigint; decimals: number; expectedTo?: string }) {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_chainId") return `0x${(input.chainId ?? baseSepolia.id).toString(16)}`;
        if (method === "eth_call") {
          const call = (params?.[0] ?? {}) as { to?: string; data?: string };
          if (input.expectedTo) expect(call.to?.toLowerCase()).toBe(input.expectedTo.toLowerCase());
          const selector = call.data?.slice(0, 10);
          if (selector === BALANCE_OF_SELECTOR) {
            // Prove the SAME safeAddress passed to readCashBalance is what
            // actually went on the wire — never a substituted address.
            expect(call.data?.toLowerCase()).toContain(SAFE_ADDRESS.slice(2).toLowerCase());
            return encodeAbiParameters([{ type: "uint256" }], [input.balance]);
          }
          if (selector === DECIMALS_SELECTOR) return encodeAbiParameters([{ type: "uint8" }], [input.decimals]);
          throw new Error(`Unexpected eth_call selector in test: ${selector}`);
        }
        throw new Error(`Unexpected public RPC call in an offline test: ${method}`);
      },
    }),
  });
}

describe("readCashBalance", () => {
  it("reads the durable Safe address's balance from the configured Base Sepolia USDC contract", async () => {
    const publicClient = buildPublicClient({ balance: BigInt(20_000_000), decimals: 6, expectedTo: REAL_CASH_TOKEN.address });
    const result = await readCashBalance({ publicClient, safeAddress: SAFE_ADDRESS });

    expect(result).toEqual({ token: "USDC", decimals: 6, balanceBaseUnits: "20000000" });
  });

  it("zero balance reads and returns exactly '0'", async () => {
    const publicClient = buildPublicClient({ balance: BigInt(0), decimals: 6 });
    const result = await readCashBalance({ publicClient, safeAddress: SAFE_ADDRESS });
    expect(result.balanceBaseUnits).toBe("0");
  });

  it("never reads a different contract address than the configured Circle testnet USDC — REAL_CASH_TOKEN.address is the only address ever dialed", async () => {
    const publicClient = buildPublicClient({ balance: BigInt(1), decimals: 6, expectedTo: REAL_CASH_TOKEN.address });
    await readCashBalance({ publicClient, safeAddress: SAFE_ADDRESS });
    // The expectedTo assertion inside the transport mock already proves
    // this on every eth_call; this test exists to name the property.
  });

  it("throws (never returns a balance) when the RPC reports a chain id other than Base Sepolia", async () => {
    const publicClient = buildPublicClient({ chainId: 11155111, balance: BigInt(1), decimals: 6 });
    await expect(readCashBalance({ publicClient, safeAddress: SAFE_ADDRESS })).rejects.toThrow(/Base Sepolia/);
  });

  it("throws (never returns a balance) when the contract's own decimals() disagrees with the configured 6", async () => {
    const publicClient = buildPublicClient({ balance: BigInt(1), decimals: 18 });
    await expect(readCashBalance({ publicClient, safeAddress: SAFE_ADDRESS })).rejects.toThrow(/decimals/);
  });

  it("propagates an RPC failure as a thrown error rather than any balance value", async () => {
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: custom({
        request: async ({ method }: { method: string }) => {
          if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
          throw new Error("network unreachable");
        },
      }),
    });
    await expect(readCashBalance({ publicClient, safeAddress: SAFE_ADDRESS })).rejects.toThrow(/network unreachable/);
  });
});

describe("balance read source — no signing/Turnkey/Pimlico path", () => {
  it("lib/real/chain/balance.ts and lib/real/server/balance.ts import no Turnkey, Pimlico, or account-abstraction module", () => {
    for (const file of ["lib/real/chain/balance.ts", "lib/real/server/balance.ts", "app/api/real/account/balance/route.ts"]) {
      const source = readFileSync(path.resolve(process.cwd(), file), "utf8");
      // Matches actual import specifiers, not the same words appearing in
      // this file's own explanatory comments about why they're absent — a
      // naive substring/case-insensitive check fails on those comments,
      // same lesson learned elsewhere in this codebase (e.g.
      // login.test.ts's/verified-account.test.ts's equivalent checks).
      expect(source).not.toMatch(/from\s+["']@turnkey\//);
      expect(source).not.toMatch(/from\s+["']permissionless/);
      expect(source).not.toMatch(/from\s+["'][^"']*pimlico[^"']*["']/i);
      expect(source).not.toMatch(/from\s+["']viem\/account-abstraction["']/);
    }
  });
});
