import type { SecurityGateResult } from "./security-gate";

/**
 * Both the constructed-stamper marker and the harmless-sign probe reset
 * with a fresh runtime. Neither missing marker proves an authority failure.
 */
const EPHEMERAL_RESET_REASONS = new Set([
  "Signing path did not use the WebAuthn stamper.",
  "Harmless passkey-bound signing probe did not produce a signature.",
]);

/**
 * Presentation-only wording for Gate 1's top-level banner. Never changes
 * evaluateSecurityGate's actual pass/fail evidence (security-gate.ts is
 * unchanged) — only how "not passed" is worded when the sole reason is that
 * this runtime's ephemeral probes haven't been rerun yet, as opposed to a
 * real authority or configuration violation. A real violation — alone or
 * mixed in with the ephemeral reason — always still reads FAIL.
 */
export function describeGate1Banner(input: {
  gate1: SecurityGateResult;
  hasPersistedIdentity: boolean;
  probesRerunThisRuntime: boolean;
}): string {
  if (input.gate1.passed) return "PASS (local evidence)";

  const onlyEphemeralReason = input.gate1.reasons.length > 0 && input.gate1.reasons.every((reason) => EPHEMERAL_RESET_REASONS.has(reason));
  if (input.hasPersistedIdentity && !input.probesRerunThisRuntime && onlyEphemeralReason) {
    return "Runtime evidence not re-run after reload — persisted identity exists; rerun the passkey probes to re-establish live proof this runtime.";
  }

  return `INCOMPLETE / FAIL: ${input.gate1.reasons[0] ?? "pending"}`;
}
