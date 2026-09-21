import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPasskey } from "@/lib/poc/turnkey/passkey";
import { bytesToBase64Url } from "@/lib/poc/turnkey/bytes";

describe("registerPasskey challenge encoding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the exact base64url encoding of the bytes handed to navigator.credentials.create", async () => {
    let capturedChallenge: Uint8Array | null = null;

    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredentialStub() {});
    vi.stubGlobal("navigator", {
      credentials: {
        create: vi.fn(async (options: { publicKey: { challenge: Uint8Array } }) => {
          capturedChallenge = new Uint8Array(options.publicKey.challenge);
          return {
            rawId: new Uint8Array([1, 2, 3, 4]).buffer,
            response: {
              clientDataJSON: new Uint8Array([9, 9, 9]).buffer,
              attestationObject: new Uint8Array([8, 8, 8]).buffer,
              getTransports: () => ["internal"],
            },
          };
        }),
      },
    });

    const registration = await registerPasskey();

    // This is the regression check: Turnkey's registration activity rejects
    // the attestation with "ChallengeMismatch" unless the challenge sent to
    // /provision is byte-for-byte the same value the authenticator embedded
    // in clientDataJSON.challenge (base64url, no padding, of the exact bytes
    // passed as `challenge` to navigator.credentials.create).
    expect(capturedChallenge).not.toBeNull();
    expect(registration.challengeBase64Url).toBe(bytesToBase64Url(capturedChallenge!));

    // Guard against regressing to hex: a 32-byte hex string is 64 lowercase
    // hex characters and can never equal the base64url form of those bytes.
    expect(registration.challengeBase64Url).not.toMatch(/^[0-9a-f]{64}$/);
  });
});
