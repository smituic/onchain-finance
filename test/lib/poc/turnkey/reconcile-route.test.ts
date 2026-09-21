import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/dev/turnkey-poc/reconcile/route";

vi.mock("@/lib/poc/turnkey/server/session", () => ({ readPocSession: vi.fn(async () => ({ appUserId: "test" })) }));
vi.mock("@/lib/poc/turnkey/server/http", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/poc/turnkey/server/http")>(),
  requireServerTurnkeyPocConfig: () => ({ sessionSecret: "offline-test", pimlicoApiKey: "offline-test" }),
}));

const hash = `0x${"ab".repeat(32)}`;
const tx = `0x${"cd".repeat(32)}`;
const receipt = { userOpHash: hash, success: true, receipt: { transactionHash: tx, status: "0x1" } };
const request = () => new Request("http://localhost/api/dev/turnkey-poc/reconcile", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userOperationHash: hash }),
});

describe("real reconciliation route with an offline bundler", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_TURNKEY_POC_ENABLED", "true");
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ jsonrpc: "2.0", id: 1, method: "eth_getUserOperationReceipt", params: [hash] });
      return Response.json({ result: receipt });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("returns the same confirmed receipt repeatedly using only receipt lookups", async () => {
    const first = await (await POST(request())).json();
    const second = await (await POST(request())).json();
    expect(first).toEqual({ status: "confirmed", userOperationHash: hash, transactionHash: tx, receiptStatus: "success", autoResend: false });
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    {},
    { ...receipt, success: undefined },
    { ...receipt, userOpHash: tx },
    { ...receipt, receipt: { status: "0x1" } },
    { ...receipt, receipt: { transactionHash: tx } },
  ])("does not confirm incomplete or mismatched evidence: %j", async (result) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ result }));
    expect((await (await POST(request())).json()).status).toBe("unknown");
  });

  it("keeps null receipts pending and HTTP failures unknown", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ result: null }));
    expect((await (await POST(request())).json()).status).toBe("pending");
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ result: receipt }, { status: 502 }));
    expect((await (await POST(request())).json()).status).toBe("unknown");
  });

  it("classifies user-operation failure even inside a successful transaction", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ result: { ...receipt, success: false } }));
    expect((await (await POST(request())).json()).status).toBe("failed");
  });

  it("returns 404 with no network calls when the PoC flag is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNKEY_POC_ENABLED", "false");
    expect((await POST(request())).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
