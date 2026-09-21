import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSimulationStore } from "@/lib/stores/simulation-store";
import { createInitialState, toMicroUnits, type SimulationState } from "@/simulation";

vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: vi.fn(async () => ({ id: "cred-1", rawId: "cred-1", response: {}, clientExtensionResults: {}, type: "public-key" })),
  startAuthentication: vi.fn(async () => ({ id: "cred-1", rawId: "cred-1", response: {}, clientExtensionResults: {}, type: "public-key" })),
}));

const { useRealAccountStore } = await import("@/lib/stores/real-account-store");

/** A deliberately non-default Practice portfolio, matching the pattern already established for Explore's isolation tests (experiment-isolation.test.tsx). */
function buildNonDefaultMainState(): SimulationState {
  const base = createInitialState(1_700_000_000_000);
  return {
    ...base,
    balances: { ...base.balances, USDC: toMicroUnits(500), ETH: toMicroUnits(3) },
    savings: { balance: toMicroUnits(2_000), interestEarnedTotal: toMicroUnits(50), lastAccruedAt: 1_700_000_000_000 },
  };
}

describe("Real account store — Practice invariance", () => {
  beforeEach(() => {
    localStorage.clear();
    useRealAccountStore.setState({ account: null, status: "idle", error: null, hasHydrated: true });
  });

  it("register, login, checkSession, and logout never touch the Practice simulation store, even by reference", async () => {
    const mainState = buildNonDefaultMainState();
    useSimulationStore.setState({ state: mainState, hasHydrated: true });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
        if (url.endsWith("/api/real/account/register/options")) return ok({ optionsJSON: {} });
        if (url.endsWith("/api/real/account/register/verify")) return ok({ appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" });
        if (url.endsWith("/api/real/account/login/options")) return ok({ optionsJSON: {} });
        if (url.endsWith("/api/real/account/login/verify")) return ok({ appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" });
        if (url.endsWith("/api/real/session")) return ok({ authenticated: false });
        throw new Error(`Unexpected network call to ${url}`);
      }),
    );

    await useRealAccountStore.getState().register();
    await useRealAccountStore.getState().login();
    await useRealAccountStore.getState().checkSession();
    await useRealAccountStore.getState().logout();

    // Reference equality: if this holds, useSimulationStore's set() was
    // never called at all by anything Real-account-related — the strongest
    // possible proof of isolation, matching the pattern already proven for
    // Explore's sandbox (see experiment-isolation.test.tsx).
    expect(useSimulationStore.getState().state).toBe(mainState);
    expect(useSimulationStore.getState().state).toEqual(mainState);

    vi.unstubAllGlobals();
  });
});
