import { describe, expect, it, vi } from "vitest";
import { createRealPaymentHistoryStore } from "@/lib/stores/real-payment-history-store";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("real-payment-history-store — malformed response handling", () => {
  it("a legitimate empty history (200 + { entries: [] }) resolves to a ready, empty state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { entries: [] })));
    const store = createRealPaymentHistoryStore();

    await store.getState().fetchHistory();

    expect(store.getState().status).toBe("ready");
    expect(store.getState().entries).toEqual([]);
    expect(store.getState().error).toBeNull();
    vi.unstubAllGlobals();
  });

  it("200 + {} (missing entries) is a malformed response, never a false empty state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, {})));
    const store = createRealPaymentHistoryStore();

    await store.getState().fetchHistory();

    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("200 + { entries: null } is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { entries: null })));
    const store = createRealPaymentHistoryStore();

    await store.getState().fetchHistory();

    expect(store.getState().status).toBe("error");
    vi.unstubAllGlobals();
  });

  it("200 + { entries: \"x\" } (wrong type, not an array) is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { entries: "x" })));
    const store = createRealPaymentHistoryStore();

    await store.getState().fetchHistory();

    expect(store.getState().status).toBe("error");
    vi.unstubAllGlobals();
  });

  it("a non-2xx response with server-provided error text preserves that text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "database unavailable" })));
    const store = createRealPaymentHistoryStore();

    await store.getState().fetchHistory();

    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toBe("database unavailable");
    vi.unstubAllGlobals();
  });

  it("a non-2xx response with no parseable body falls back to a generic message, not a crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 500 })));
    const store = createRealPaymentHistoryStore();

    await store.getState().fetchHistory();

    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toMatch(/Could not load your recent payments/);
    vi.unstubAllGlobals();
  });

  it("a 401 is reported as unauthenticated, never merged with the malformed-response error path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "Not authenticated." })));
    const store = createRealPaymentHistoryStore();

    await store.getState().fetchHistory();

    expect(store.getState().status).toBe("unauthenticated");
    expect(store.getState().entries).toEqual([]);
    vi.unstubAllGlobals();
  });
});

/**
 * Pre-2f hardening: see real-payment-history-store.ts's `generation` closure
 * variable — a stale fetchHistory() response must never overwrite state a
 * newer reset() (account switch/logout) already cleared.
 */
describe("real-payment-history-store — stale async response race (pre-2f hardening)", () => {
  it("a stale fetchHistory() response arriving after reset() is a no-op, never resurrects cleared entries", async () => {
    let resolveFetch: (value: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve))));
    const store = createRealPaymentHistoryStore();

    const pending = store.getState().fetchHistory();
    store.getState().reset();
    expect(store.getState().entries).toEqual([]);
    expect(store.getState().status).toBe("idle");

    resolveFetch(
      jsonResponse(200, {
        entries: [
          {
            id: "stale-entry",
            recipient: "0x1111111111111111111111111111111111111111",
            amountBaseUnits: "1000000",
            state: "confirmed",
            transactionHash: "0xabc",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    await pending;

    expect(store.getState().entries).toEqual([]);
    expect(store.getState().status).toBe("idle");
    vi.unstubAllGlobals();
  });
});
