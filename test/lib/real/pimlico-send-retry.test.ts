import { createClient, custom } from "viem";
import { sendUserOperation } from "viem/account-abstraction";
import { describe, expect, it } from "vitest";

/**
 * Regression test for Part H.4 of the S2 security closeout: our own dispatch
 * path (lib/real/server/pimlico.ts's sendPreparedUserOperation) never sets
 * retryCount itself — it relies entirely on `client.sendUserOperation` being
 * viem's own `sendUserOperation` bundler action (reached via permissionless's
 * createPimlicoClient(...).extend(bundlerActions), see
 * node_modules/permissionless/clients/pimlico/index.ts), which pins
 * `retryCount: 0` as a PER-CALL override to client.request (see viem's
 * account-abstraction/actions/bundler/sendUserOperation.js) — this wins over
 * the transport's own default retry count (viem's buildRequest.ts merges
 * `{ ...transportOptions, ...overrideOptions }` before retrying).
 *
 * This test does not touch our own code at all: it pins the THIRD-PARTY
 * behavior our correctness (never silently double-dispatching a signed
 * UserOperation on a transient network blip) depends on, so a future
 * viem/permissionless upgrade that drops this per-call override fails this
 * test instead of silently reintroducing multi-attempt dispatch.
 */
describe("viem's sendUserOperation pins retryCount: 0 (third-party guarantee our dispatch path relies on)", () => {
  it("never retries eth_sendUserOperation even against a transport whose own default retry count is > 0", async () => {
    let callCount = 0;
    const client = createClient({
      transport: custom(
        {
          request: async ({ method }: { method: string }) => {
            if (method === "eth_sendUserOperation") {
              callCount++;
              // A transient-looking failure that viem's retryer WOULD retry
              // if retryCount weren't pinned to 0 for this specific call.
              throw new Error("HTTP request failed (simulated transient network error)");
            }
            throw new Error(`unexpected method: ${method}`);
          },
        },
        { retryCount: 5, retryDelay: 1 },
      ),
    });

    await expect(
      sendUserOperation(client, {
        sender: "0x1111111111111111111111111111111111111111",
        nonce: BigInt(0),
        callData: "0x",
        callGasLimit: BigInt(100_000),
        verificationGasLimit: BigInt(100_000),
        preVerificationGas: BigInt(50_000),
        maxFeePerGas: BigInt(1),
        maxPriorityFeePerGas: BigInt(1),
        signature: "0xaa",
        entryPointAddress: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
      } as Parameters<typeof sendUserOperation>[1]),
    ).rejects.toThrow();

    expect(callCount).toBe(1);
  });
});
