import { describe, expect, it } from "vitest";
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC_ADDRESS,
  DEFAULT_BASE_SEPOLIA_RPC_URL,
  USDC_DECIMALS,
  isPocEnabled,
  validatePrivyPocConfig,
} from "@/lib/poc/privy/config";

// Privy app IDs are exactly 25 characters; the SDK throws at mount otherwise.
const VALID_APP_ID = "cm1abcdefghijklmnopqrstuv";

describe("privy poc config", () => {
  it("pins the decided network and asset", () => {
    expect(BASE_SEPOLIA_CHAIN_ID).toBe(84532);
    expect(BASE_SEPOLIA_USDC_ADDRESS).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(USDC_DECIMALS).toBe(6);
  });

  it("is disabled unless the flag is exactly 'true'", () => {
    expect(isPocEnabled({})).toBe(false);
    expect(isPocEnabled({ NEXT_PUBLIC_PRIVY_POC_ENABLED: "1" })).toBe(false);
    expect(isPocEnabled({ NEXT_PUBLIC_PRIVY_POC_ENABLED: "TRUE" })).toBe(false);
    expect(isPocEnabled({ NEXT_PUBLIC_PRIVY_POC_ENABLED: "true" })).toBe(true);
  });

  it("requires an app id", () => {
    const result = validatePrivyPocConfig({ NEXT_PUBLIC_PRIVY_POC_ENABLED: "true" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.enabled).toBe(true);
      expect(result.errors).toEqual(["NEXT_PUBLIC_PRIVY_APP_ID is not set."]);
    }
  });

  it("rejects an app id that does not look like one (SDK requires exactly 25 chars)", () => {
    expect(VALID_APP_ID).toHaveLength(25);
    for (const bad of ["not an id!", "cm0000000000000000000poc", VALID_APP_ID + "x"]) {
      const result = validatePrivyPocConfig({ NEXT_PUBLIC_PRIVY_APP_ID: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]).toMatch(/does not look like/);
    }
  });

  it("defaults the read RPC and leaves client id undefined when blank", () => {
    const result = validatePrivyPocConfig({
      NEXT_PUBLIC_PRIVY_POC_ENABLED: "true",
      NEXT_PUBLIC_PRIVY_APP_ID: VALID_APP_ID,
      NEXT_PUBLIC_PRIVY_CLIENT_ID: "  ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toEqual({
        enabled: true,
        appId: VALID_APP_ID,
        clientId: undefined,
        rpcUrl: DEFAULT_BASE_SEPOLIA_RPC_URL,
      });
    }
  });

  it("refuses a non-https read RPC", () => {
    const result = validatePrivyPocConfig({
      NEXT_PUBLIC_PRIVY_APP_ID: VALID_APP_ID,
      NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL: "http://localhost:8545",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(["NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL must be an https:// URL."]);
  });
});
