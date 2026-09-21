import { describe, expect, it } from "vitest";
import { isTurnkeyPocEnabled, readPublicTurnkeyPocConfig, readServerTurnkeyPocConfig, isServerTurnkeyPocConfig } from "@/lib/poc/turnkey/config";

describe("Turnkey PoC configuration", () => {
  it("is disabled unless the public flag is the string true", () => {
    expect(isTurnkeyPocEnabled(undefined)).toBe(false);
    expect(isTurnkeyPocEnabled("false")).toBe(false);
    expect(isTurnkeyPocEnabled("TRUE")).toBe(false);
    expect(isTurnkeyPocEnabled("true")).toBe(true);
  });

  it("defaults the RP ID to localhost and does not invent secrets", () => {
    const config = readPublicTurnkeyPocConfig({
      NEXT_PUBLIC_TURNKEY_POC_ENABLED: "true",
    });
    expect(config.enabled).toBe(true);
    expect(config.rpId).toBe("localhost");
    expect(config.rpcUrl).toContain("sepolia");
  });

  it("refuses a server config when secrets are missing", () => {
    const config = readServerTurnkeyPocConfig({
      NEXT_PUBLIC_TURNKEY_POC_ENABLED: "true",
    });
    expect(isServerTurnkeyPocConfig(config)).toBe(false);
    if (!isServerTurnkeyPocConfig(config)) {
      expect(config.error).toMatch(/TURNKEY_PARENT_ORGANIZATION_ID/);
      expect(config.error).toMatch(/PIMLICO_API_KEY/);
    }
  });
});
