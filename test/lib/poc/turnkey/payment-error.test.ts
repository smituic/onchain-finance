import { describe, expect, it } from "vitest";
import { classifyPaymentError } from "@/lib/poc/turnkey/payment-error";

/** Builds an error carrying viem-shaped fields, chained via the standard `cause` option. */
function viemError(name: string, extra: Record<string, unknown> = {}, cause?: unknown): Error {
  const error = new Error(`${name} message`, cause !== undefined ? { cause } : undefined);
  return Object.assign(error, { name, ...extra });
}

describe("classifyPaymentError", () => {
  it("classifies a cancelled WebAuthn ceremony as cancelled (nothing signed or sent)", () => {
    expect(classifyPaymentError({ name: "NotAllowedError" }).stage).toBe("cancelled");
    expect(classifyPaymentError({ name: "AbortError" }).stage).toBe("cancelled");
  });

  it("classifies a plain Turnkey-side error as signing-failed", () => {
    // Turnkey's client never throws viem's transport/RPC error classes, so
    // any other error shape means it happened talking to Turnkey, before a
    // signature existed.
    const result = classifyPaymentError(new Error("Turnkey activity rejected"));
    expect(result.stage).toBe("signing-failed");
    expect(result.phase).toBe("turnkey-signing");
    expect(result.detail).toContain("Turnkey signing did not complete");
  });

  it("classifies an UNWRAPPED bundler transport error as a pre-signing prepare failure, not a post-signing rejection", () => {
    // prepareUserOperation's own paymaster/gas-estimation calls throw viem
    // transport errors directly, with no UserOperationExecutionError
    // wrapper — that wrapper only exists around the final
    // eth_sendUserOperation call. Seeing a bare RpcRequestError/
    // HttpRequestError with no wrapper means the passkey prompt would never
    // have appeared for this specific failure.
    const result = classifyPaymentError(viemError("RpcRequestError", { code: -32602, shortMessage: "invalid paymaster context" }));
    expect(result.stage).toBe("signing-failed");
    expect(result.phase).toBe("unknown");
    expect(result.detail).toContain("before a passkey prompt could appear");
  });

  it("REGRESSION: classifies a UserOperationExecutionError-wrapped paymaster rejection as rejected, not signing-failed", () => {
    // This is the exact bug from the live incident: sendUserOperation only
    // wraps an error as UserOperationExecutionError when it comes from the
    // final eth_sendUserOperation call, which in viem's own source only runs
    // after account.signUserOperation() has already returned a signature.
    // The previous classifier only checked the top-level error name, never
    // saw this wrapper, and misclassified every post-signing bundler
    // rejection as "signing-failed" — hiding that signing had, in fact,
    // already succeeded.
    const rpcError = viemError("RpcRequestError", { code: -32521, shortMessage: "paymaster deposit too low" });
    const bundlerError = viemError("PaymasterDepositTooLowError", {}, rpcError);
    const wrapped = viemError("UserOperationExecutionError", {}, bundlerError);

    const result = classifyPaymentError(wrapped);
    expect(result.stage).toBe("rejected");
    expect(result.phase).toBe("paymaster");
    expect(result.rpc).toEqual({ method: "eth_sendUserOperation", code: -32521, message: "paymaster deposit too low" });
    expect(result.detail).toContain("Signing succeeded");
    expect(result.detail).toContain("paymaster");
  });

  it("classifies a UserOperationExecutionError-wrapped execution revert as rejected, phase submission", () => {
    const rpcError = viemError("RpcRequestError", { code: -32000, shortMessage: "execution reverted" });
    const bundlerError = viemError("ExecutionRevertedError", {}, rpcError);
    const wrapped = viemError("UserOperationExecutionError", {}, bundlerError);

    const result = classifyPaymentError(wrapped);
    expect(result.stage).toBe("rejected");
    expect(result.phase).toBe("submission");
  });

  it("keeps an HTTP-only error uncertain even when a status is available", () => {
    const httpError = viemError("HttpRequestError", { status: 400, shortMessage: "Bad Request" });
    const bundlerError = viemError("UnknownBundlerError", {}, httpError);
    const wrapped = viemError("UserOperationExecutionError", {}, bundlerError);

    const result = classifyPaymentError(wrapped);
    expect(result.stage).toBe("uncertain");
    expect(result.rpc?.method).toBe("eth_sendUserOperation");
  });

  it("classifies a UserOperationExecutionError with no HTTP response at all as uncertain, not rejected", () => {
    // Signing succeeded (we reached the submission call), but nothing came
    // back — the operation may already have reached the bundler.
    const httpError = viemError("HttpRequestError", { shortMessage: "fetch failed" }); // no status: no response received
    const bundlerError = viemError("UnknownBundlerError", {}, httpError);
    const wrapped = viemError("UserOperationExecutionError", {}, bundlerError);

    const result = classifyPaymentError(wrapped);
    expect(result.stage).toBe("uncertain");
    expect(result.detail).toContain("may already have been submitted");
  });

  it("classifies a bundler timeout as uncertain, not a confirmed failure", () => {
    const timeoutError = viemError("TimeoutError", { shortMessage: "timed out" });
    const wrapped = viemError("UserOperationExecutionError", {}, viemError("UnknownBundlerError", {}, timeoutError));
    expect(classifyPaymentError(wrapped).stage).toBe("uncertain");
  });

  it.each([400, 500, 502, 504])("does not treat HTTP %s as proof the operation was rejected", (status) => {
    const wrapped = viemError("UserOperationExecutionError", {},
      viemError("HttpRequestError", { status, shortMessage: "Proxy failed" }));
    expect(classifyPaymentError(wrapped).stage).toBe("uncertain");
  });

  it("does not persist a viem request dump in uncertainty diagnostics", () => {
    const wrapped = viemError("UserOperationExecutionError", { message: "Request Arguments: signature: 0xSIGNED_PAYLOAD" },
      viemError("TimeoutError", { shortMessage: "Request timed out" }));
    const result = classifyPaymentError(wrapped);
    expect(result.detail).not.toContain("SIGNED_PAYLOAD");
    expect(result.detail).toContain("Request timed out");
  });

  it("keeps a local error after an acknowledged submission unresolved", () => {
    expect(classifyPaymentError(new Error("Storage quota exceeded"), { submissionAcknowledged: true }).stage).toBe("uncertain");
  });
});
