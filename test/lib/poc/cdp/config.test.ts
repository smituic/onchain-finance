import { describe, expect, it } from "vitest";
import { readCdpPocConfig } from "@/lib/poc/cdp/config";

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("readCdpPocConfig", () => {
  it("is disabled and problem-free about the flag when nothing is set", () => {
    const cfg = readCdpPocConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.projectId).toBeNull();
    expect(cfg.rpcUrl).toBeNull();
    expect(cfg.problems).toHaveLength(1);
    expect(cfg.problems[0]).toMatch(/NEXT_PUBLIC_CDP_PROJECT_ID is not set/);
  });

  it("enables only on the exact string 'true'", () => {
    expect(readCdpPocConfig({ NEXT_PUBLIC_CDP_POC_ENABLED: "true" }).enabled).toBe(true);
    expect(readCdpPocConfig({ NEXT_PUBLIC_CDP_POC_ENABLED: "TRUE" }).enabled).toBe(false);
    expect(readCdpPocConfig({ NEXT_PUBLIC_CDP_POC_ENABLED: "1" }).enabled).toBe(false);
  });

  it("accepts a UUID project id and trims whitespace", () => {
    const cfg = readCdpPocConfig({ NEXT_PUBLIC_CDP_POC_ENABLED: "true", NEXT_PUBLIC_CDP_PROJECT_ID: `  ${PROJECT_ID} ` });
    expect(cfg.projectId).toBe(PROJECT_ID);
    expect(cfg.problems).toEqual([]);
  });

  it("rejects something that is not a project id (e.g. an API key pasted by mistake)", () => {
    const cfg = readCdpPocConfig({ NEXT_PUBLIC_CDP_PROJECT_ID: "organizations/abc/apiKeys/def" });
    expect(cfg.projectId).toBeNull();
    expect(cfg.problems[0]).toMatch(/does not look like a CDP Project ID/);
  });

  it("requires https for the RPC override and otherwise leaves it null", () => {
    expect(readCdpPocConfig({ NEXT_PUBLIC_CDP_PROJECT_ID: PROJECT_ID, NEXT_PUBLIC_CDP_POC_RPC_URL: "https://rpc.example/x" }).rpcUrl).toBe(
      "https://rpc.example/x",
    );
    const bad = readCdpPocConfig({ NEXT_PUBLIC_CDP_PROJECT_ID: PROJECT_ID, NEXT_PUBLIC_CDP_POC_RPC_URL: "http://rpc.example" });
    expect(bad.rpcUrl).toBeNull();
    expect(bad.problems.some((p) => /https/.test(p))).toBe(true);
    expect(readCdpPocConfig({ NEXT_PUBLIC_CDP_PROJECT_ID: PROJECT_ID, NEXT_PUBLIC_CDP_POC_RPC_URL: "   " }).rpcUrl).toBeNull();
  });
});
