import { describe, expect, it } from "vitest";
import { PIMLICO_ALLOWED_METHODS } from "@/lib/poc/turnkey/constants";
import { assertAllowedPimlicoMethod } from "@/lib/poc/turnkey/server/pimlico";

describe("Pimlico proxy allowlist", () => {
  it("allows bundler and paymaster methods only", () => {
    expect(PIMLICO_ALLOWED_METHODS).toContain("eth_sendUserOperation");
    expect(PIMLICO_ALLOWED_METHODS).toContain("pm_getPaymasterData");
    expect(() => assertAllowedPimlicoMethod("eth_sendUserOperation")).not.toThrow();
    expect(() => assertAllowedPimlicoMethod("eth_sendRawTransaction")).toThrow(/not allowed/);
  });
});
