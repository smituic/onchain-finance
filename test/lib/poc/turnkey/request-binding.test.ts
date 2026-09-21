import { describe, expect, it } from "vitest";
import { canonicalPaymentRequest, describePaymentMutation, paymentRequestsEqual } from "@/lib/poc/turnkey/request-binding";

describe("request identity", () => {
  it("canonicalizes a Base Sepolia Cash transfer", () => {
    const request = canonicalPaymentRequest({
      recipient: "0x0000000000000000000000000000000000000001",
      amountUsdc: "0.10",
    });
    expect(request).toEqual({
      chainId: 84532,
      token: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      recipient: "0x0000000000000000000000000000000000000001",
      amountUnits: "100000",
    });
  });

  it("treats recipient or amount mutation as a different request", () => {
    const authorized = canonicalPaymentRequest({
      recipient: "0x0000000000000000000000000000000000000001",
      amountUsdc: "0.10",
    })!;
    const mutatedRecipient = canonicalPaymentRequest({
      recipient: "0x0000000000000000000000000000000000000002",
      amountUsdc: "0.10",
    })!;
    const mutatedAmount = canonicalPaymentRequest({
      recipient: "0x0000000000000000000000000000000000000001",
      amountUsdc: "0.20",
    })!;
    expect(paymentRequestsEqual(authorized, mutatedRecipient)).toBe(false);
    expect(describePaymentMutation(authorized, mutatedRecipient)).toEqual(["recipient"]);
    expect(describePaymentMutation(authorized, mutatedAmount)).toEqual(["amount"]);
  });
});
