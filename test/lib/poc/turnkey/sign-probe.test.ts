import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashTypedData } from "viem";
import { EIP712_SIGN_PROBE_TYPED_DATA, serializeTurnkeyRawSignature } from "@/lib/poc/turnkey/sign-probe";

describe("EIP712_SIGN_PROBE_TYPED_DATA", () => {
  it("hashes to the same digest on every call (fully deterministic, no relation to any live SafeOp)", () => {
    const first = hashTypedData(EIP712_SIGN_PROBE_TYPED_DATA);
    const second = hashTypedData(EIP712_SIGN_PROBE_TYPED_DATA);
    expect(first).toBe(second);
  });
});

describe("serializeTurnkeyRawSignature re-export", () => {
  it("still exports the raw-signature.ts serializer for callers importing it from sign-probe.ts", () => {
    // The real implementation and its tests now live in raw-signature.ts —
    // this only pins that the re-export stays wired up.
    expect(typeof serializeTurnkeyRawSignature).toBe("function");
  });
});

describe("sign-probe.ts source", () => {
  it("never imports from payment.ts or references the Pimlico proxy URL/bundler submission — probes only ever talk to Turnkey", () => {
    const source = readFileSync(path.resolve(process.cwd(), "lib/poc/turnkey/sign-probe.ts"), "utf8");
    // The word "Pimlico" appears only in explanatory comments saying probes
    // do NOT call it — these checks target the actual structural dependency
    // (no import from payment.ts, no bundler URL, no send/prepare calls).
    expect(source).not.toMatch(/from\s+["']\.\/payment["']/);
    expect(source).not.toContain("/api/dev/turnkey-poc/pimlico");
    expect(source).not.toContain("sendUserOperation");
    expect(source).not.toContain("prepareUserOperation");
    expect(source).not.toContain("createSponsoredSafeClient");
    expect(source).not.toContain("smartAccountClient");
  });

  it("runRawDigestSignProbe delegates digest signing to the shared raw-sign.ts primitive instead of duplicating its own Turnkey client/signRawPayload call", () => {
    const source = readFileSync(path.resolve(process.cwd(), "lib/poc/turnkey/sign-probe.ts"), "utf8");
    expect(source).toContain('from "./raw-sign"');
    const start = source.indexOf("export async function runRawDigestSignProbe");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\nexport ", start + 1);
    const body = source.slice(start, end === -1 ? undefined : end);
    expect(body).toContain("signDigestViaTurnkeyRaw(");
    expect(body).not.toContain("createPasskeyTurnkeyClient(");
    expect(body).not.toContain(".signRawPayload(");
  });
});
