import { describe, expect, it } from "vitest";
import { classifySendError } from "@/lib/real/payments/classify-send-error";

/**
 * Pre-2f hardening: `detail` is now always one of two fixed, safe strings —
 * never derived from the thrown error's `.message`/`.shortMessage`. These
 * tests inject secret-bearing messages (as a real viem HttpRequestError
 * would carry) to prove they never leak through, in either classification
 * branch.
 */
describe("classifySendError — fixed, safe messages only", () => {
  it("a recognized bundler rejection classifies as 'failed' with the fixed message, never the injected upstream text", () => {
    const secretBearingMessage = "URL: https://api.pimlico.io/v2/84532/rpc?apikey=SECRET_TEST_KEY";
    const bundlerRejection = Object.assign(new Error(secretBearingMessage), { name: "AccountNotDeployedError", shortMessage: secretBearingMessage });
    const rpcRejection = Object.assign(new Error("rejected"), { name: "RpcRequestError", cause: bundlerRejection });

    const classification = classifySendError(rpcRejection);

    expect(classification.stage).toBe("failed");
    expect(classification.detail).toBe("The bundler rejected this payment before executing it.");
    expect(classification.detail).not.toContain("apikey=");
    expect(classification.detail).not.toContain("SECRET_TEST_KEY");
  });

  it("an unrecognized/transport error classifies as 'unknown' with the fixed message, never the injected upstream text", () => {
    const secretBearingMessage = "HTTP request failed. URL: https://api.pimlico.io/v2/84532/rpc?apikey=SECRET_TEST_KEY";
    const transportError = Object.assign(new Error(secretBearingMessage), { name: "TimeoutError", shortMessage: secretBearingMessage });

    const classification = classifySendError(transportError);

    expect(classification.stage).toBe("unknown");
    expect(classification.detail).not.toContain("apikey=");
    expect(classification.detail).not.toContain("SECRET_TEST_KEY");
  });

  it("a plain, non-Error thrown value still classifies safely", () => {
    const classification = classifySendError("a raw string throw");
    expect(classification.stage).toBe("unknown");
    expect(classification.detail).not.toContain("a raw string throw");
  });
});
