import { describe, expect, it } from "vitest";
import { paymentStatusLabel, type PaymentDisplayState } from "@/lib/real/display/payment-status";

describe("paymentStatusLabel — Batch 2e consumer status language", () => {
  const cases: [PaymentDisplayState, string][] = [
    ["confirmed", "Sent"],
    ["submitted", "Sending"],
    ["submitting", "Sending"],
    ["unknown", "Checking status"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
    ["awaiting_authorization", "Pending approval"],
    ["prepared", "Pending approval"],
    ["signed", "Pending approval"],
  ];

  it.each(cases)("%s -> %s", (state, label) => {
    expect(paymentStatusLabel(state)).toBe(label);
  });

  it("never surfaces internal state-machine/protocol jargon", () => {
    for (const [state] of cases) {
      const label = paymentStatusLabel(state);
      expect(label).not.toMatch(/UserOperation|EntryPoint|Pimlico|Safe|gas|calldata/i);
    }
  });
});
