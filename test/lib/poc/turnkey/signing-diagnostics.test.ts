import { describe, expect, it } from "vitest";
import { hashTypedData, type Hex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { instrumentSignTypedData } from "@/lib/poc/turnkey/signing-diagnostics";

const OWNER_KEY: Hex = "0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a";
const owner = privateKeyToAccount(OWNER_KEY);

const typedData: TypedDataDefinition = {
  domain: { name: "OCF Diagnostics Test", version: "1", chainId: 84532 },
  types: { Probe: [{ name: "purpose", type: "string" }] },
  primaryType: "Probe",
  message: { purpose: "signing-diagnostics-test" },
};

describe("instrumentSignTypedData", () => {
  it("captures a preSignDigest equal to hashTypedData of the EXACT object passed to signTypedData", async () => {
    const diagnostics: Array<Parameters<Parameters<typeof instrumentSignTypedData>[1]>[0]> = [];
    const instrumented = instrumentSignTypedData(owner, (diagnostic) => diagnostics.push(diagnostic));

    await instrumented.signTypedData(typedData);

    expect(diagnostics).toHaveLength(1);
    const diagnostic = diagnostics[0]!;
    // This is the regression this file exists for: the digest must come from
    // hashing the SAME object that was signed, not a separately reconstructed
    // one — otherwise a real match could be reported as a mismatch (or vice
    // versa) purely from divergent reconstruction, not an actual signing bug.
    expect(diagnostic.preSignDigest).toBe(hashTypedData(typedData));
  });

  it("recovers the correct owner for a valid signature and reports matches=true", async () => {
    const diagnostics: Array<Parameters<Parameters<typeof instrumentSignTypedData>[1]>[0]> = [];
    const instrumented = instrumentSignTypedData(owner, (diagnostic) => diagnostics.push(diagnostic));

    const signature = await instrumented.signTypedData(typedData);
    const diagnostic = diagnostics[0]!;

    expect(diagnostic.signature).toBe(signature);
    expect(diagnostic.recoveredAddress.toLowerCase()).toBe(owner.address.toLowerCase());
    expect(diagnostic.matches).toBe(true);
    expect(diagnostic.signatureByteLength).toBe(65);
    expect([27, 28]).toContain(diagnostic.vByte);
  });

  it("detects a wrong-signer case: recovers correctly but does not match a different expected owner", async () => {
    // Simulates instrumenting an account object whose claimed .address does
    // not match the key that actually signed — exactly the shape of "wrong
    // Turnkey wallet/key selection".
    const impostor = { ...owner, address: "0x0000000000000000000000000000000000000099" as const };
    const diagnostics: Array<Parameters<Parameters<typeof instrumentSignTypedData>[1]>[0]> = [];
    const instrumented = instrumentSignTypedData(impostor, (diagnostic) => diagnostics.push(diagnostic));

    await instrumented.signTypedData(typedData);
    const diagnostic = diagnostics[0]!;

    expect(diagnostic.recoveredAddress.toLowerCase()).toBe(owner.address.toLowerCase());
    expect(diagnostic.expectedOwner).toBe(impostor.address);
    expect(diagnostic.matches).toBe(false);
  });
});
