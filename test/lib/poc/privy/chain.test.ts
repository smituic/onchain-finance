import { describe, expect, it } from "vitest";
import { encodeUsdcTransfer } from "@/lib/poc/privy/chain";
import { BASE_SEPOLIA_USDC_ADDRESS } from "@/lib/poc/privy/config";
import { parseUsdcAmount } from "@/lib/poc/privy/usdc-amount";

describe("encodeUsdcTransfer", () => {
  it("ABI-encodes transfer(to, amount) without going through floats", () => {
    const parsed = parseUsdcAmount("0.10");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const data = encodeUsdcTransfer("0x000000000000000000000000000000000000dEaD", parsed.baseUnits);
    // ERC-20 transfer selector.
    expect(data.startsWith("0xa9059cbb")).toBe(true);
    expect(data.toLowerCase()).toContain("000000000000000000000000000000000000dead");
    expect(data.toLowerCase()).toContain("186a0"); // 100000 in hex
    expect(BASE_SEPOLIA_USDC_ADDRESS).toMatch(/^0x/);
  });
});
