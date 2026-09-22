import { describe, expect, it, vi } from "vitest";
import { createRealBalanceStore } from "@/lib/stores/real-balance-store";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("real-balance-store — fetchBalance", () => {
  it("a normal fetch resolves to a ready state with the returned balance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "1000000" })));
    const store = createRealBalanceStore();

    await store.getState().fetchBalance();

    expect(store.getState().status).toBe("ready");
    expect(store.getState().balance?.balanceBaseUnits).toBe("1000000");
    vi.unstubAllGlobals();
  });

  it("a 401 is reported as unauthenticated, never a fabricated balance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "Not authenticated." })));
    const store = createRealBalanceStore();

    await store.getState().fetchBalance();

    expect(store.getState().status).toBe("unauthenticated");
    expect(store.getState().balance).toBeNull();
    vi.unstubAllGlobals();
  });
});

/**
 * Pre-2f hardening: see real-balance-store.ts's `generation` closure
 * variable — a stale fetchBalance() response must never overwrite state a
 * newer reset() (account switch/logout) already cleared, nor a newer
 * fetchBalance() call's own result.
 */
describe("real-balance-store — stale async response race (pre-2f hardening)", () => {
  it("a stale fetchBalance() response arriving after reset() is a no-op, never resurrects a cleared balance", async () => {
    let resolveFetch: (value: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve))));
    const store = createRealBalanceStore();

    const pending = store.getState().fetchBalance();
    expect(store.getState().status).toBe("loading");

    // Simulates an account switch/logout racing ahead of the in-flight fetch.
    store.getState().reset();
    expect(store.getState().status).toBe("idle");
    expect(store.getState().balance).toBeNull();

    resolveFetch(jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }));
    await pending;

    expect(store.getState().status).toBe("idle");
    expect(store.getState().balance).toBeNull();
    vi.unstubAllGlobals();
  });

  it("latest-request-wins: an older fetchBalance() response resolving after a newer one cannot overwrite it", async () => {
    let resolveA: (value: Response) => void = () => {};
    let resolveB: (value: Response) => void = () => {};
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        callCount += 1;
        if (callCount === 1) return new Promise<Response>((resolve) => (resolveA = resolve));
        return new Promise<Response>((resolve) => (resolveB = resolve));
      }),
    );
    const store = createRealBalanceStore();

    const pendingA = store.getState().fetchBalance();
    const pendingB = store.getState().fetchBalance();

    // B — the newer request — resolves first and applies.
    resolveB(jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "5000000" }));
    await pendingB;
    expect(store.getState().balance?.balanceBaseUnits).toBe("5000000");

    // A — the OLDER request — resolves last and must not overwrite B's result.
    resolveA(jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "999999999" }));
    await pendingA;

    expect(store.getState().balance?.balanceBaseUnits).toBe("5000000");
    vi.unstubAllGlobals();
  });
});
