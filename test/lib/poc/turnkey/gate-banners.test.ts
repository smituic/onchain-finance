import { describe, expect, it } from "vitest";
import { describeGate1Banner } from "@/lib/poc/turnkey/gate-banners";
import type { SecurityGateResult } from "@/lib/poc/turnkey/security-gate";

describe("describeGate1Banner", () => {
  it("recognizes both markers that reset in a fresh browser runtime", () => {
    const gate1 = { passed: false, reasons: [
      "Signing path did not use the WebAuthn stamper.",
      "Harmless passkey-bound signing probe did not produce a signature.",
    ] };
    expect(describeGate1Banner({ gate1, hasPersistedIdentity: true, probesRerunThisRuntime: false })).toContain("Runtime evidence not re-run after reload");
    gate1.reasons.push("Backend/parent API key is present on the child user.");
    expect(describeGate1Banner({ gate1, hasPersistedIdentity: true, probesRerunThisRuntime: false })).toContain("FAIL");
  });
  it("reads PASS when the gate passed, regardless of the other flags", () => {
    const passed: SecurityGateResult = { passed: true, reasons: [] };
    expect(describeGate1Banner({ gate1: passed, hasPersistedIdentity: false, probesRerunThisRuntime: false })).toBe(
      "PASS (local evidence)",
    );
  });

  it("softens the wording to 'runtime evidence not re-run' when the only failure reason is the ephemeral probe reset, identity is persisted, and probes weren't rerun this runtime", () => {
    const notPassed: SecurityGateResult = {
      passed: false,
      reasons: ["Harmless passkey-bound signing probe did not produce a signature."],
    };
    const banner = describeGate1Banner({ gate1: notPassed, hasPersistedIdentity: true, probesRerunThisRuntime: false });
    expect(banner).toContain("Runtime evidence not re-run after reload");
    expect(banner).not.toContain("FAIL");
  });

  it("still shows FAIL when a real authority violation is the reason, even with persisted identity and no rerun", () => {
    const notPassed: SecurityGateResult = {
      passed: false,
      reasons: ["Child org has extra root users beyond the end user."],
    };
    const banner = describeGate1Banner({ gate1: notPassed, hasPersistedIdentity: true, probesRerunThisRuntime: false });
    expect(banner).toContain("INCOMPLETE / FAIL");
    expect(banner).toContain("extra root users");
  });

  it("still shows FAIL when the ephemeral reason is mixed with a real violation — never masks a genuine failure", () => {
    const notPassed: SecurityGateResult = {
      passed: false,
      reasons: [
        "Child org has extra root users beyond the end user.",
        "Harmless passkey-bound signing probe did not produce a signature.",
      ],
    };
    const banner = describeGate1Banner({ gate1: notPassed, hasPersistedIdentity: true, probesRerunThisRuntime: false });
    expect(banner).toContain("INCOMPLETE / FAIL");
  });

  it("shows FAIL (not the softened wording) when there is no persisted identity, even with only the ephemeral reason", () => {
    const notPassed: SecurityGateResult = {
      passed: false,
      reasons: ["Harmless passkey-bound signing probe did not produce a signature."],
    };
    const banner = describeGate1Banner({ gate1: notPassed, hasPersistedIdentity: false, probesRerunThisRuntime: false });
    expect(banner).toContain("INCOMPLETE / FAIL");
  });

  it("shows FAIL (not the softened wording) once probes have been rerun this runtime and still failed", () => {
    const notPassed: SecurityGateResult = {
      passed: false,
      reasons: ["Harmless passkey-bound signing probe did not produce a signature."],
    };
    const banner = describeGate1Banner({ gate1: notPassed, hasPersistedIdentity: true, probesRerunThisRuntime: true });
    expect(banner).toContain("INCOMPLETE / FAIL");
  });
});
