import { describe, expect, it } from "vitest";
import { buildLoginOptions, buildRegistrationOptions, verifyLogin, verifyRegistration } from "@/lib/real/server/webauthn";
import type { RealServerConfig } from "@/lib/real/server/config";
import { buildAuthenticationResponseJSON, buildRegistrationResponseJSON, createFixtureAuthenticator } from "./fixtures/webauthn";

const ORIGIN = "http://localhost:3000";

const config: RealServerConfig = {
  turnkeyApiBaseUrl: "https://api.turnkey.com",
  turnkeyParentOrganizationId: "org-1",
  turnkeyApiPublicKey: "pub",
  turnkeyApiPrivateKey: "priv",
  sessionSecret: "test-secret",
  rpId: "localhost",
  rpName: "Test",
  expectedOrigins: [ORIGIN],
  rpcUrl: "https://sepolia.base.org",
};

describe("webauthn registration verification (real crypto fixtures)", () => {
  it("verifies a genuine registration response", async () => {
    const options = await buildRegistrationOptions({ config, userId: new TextEncoder().encode("user-1"), userName: "user" });
    const authenticator = createFixtureAuthenticator();
    const response = buildRegistrationResponseJSON({ authenticator, challenge: options.challenge, origin: ORIGIN, rpId: config.rpId });

    const result = await verifyRegistration({ config, response, expectedChallenge: options.challenge });

    expect(result.verified).toBe(true);
    expect(result.registrationInfo?.userVerified).toBe(true);
    expect(result.registrationInfo?.credential.id).toBe(authenticator.credentialIdBase64Url);
  });

  it("rejects a response signed for the wrong origin", async () => {
    const options = await buildRegistrationOptions({ config, userId: new TextEncoder().encode("user-2"), userName: "user2" });
    const authenticator = createFixtureAuthenticator();
    const response = buildRegistrationResponseJSON({
      authenticator,
      challenge: options.challenge,
      origin: "http://evil.example",
      rpId: config.rpId,
    });

    await expect(verifyRegistration({ config, response, expectedChallenge: options.challenge })).rejects.toThrow();
  });

  it("rejects a response computed for the wrong RP ID", async () => {
    const options = await buildRegistrationOptions({ config, userId: new TextEncoder().encode("user-3"), userName: "user3" });
    const authenticator = createFixtureAuthenticator();
    const response = buildRegistrationResponseJSON({
      authenticator,
      challenge: options.challenge,
      origin: ORIGIN,
      rpId: "not-localhost",
    });

    await expect(verifyRegistration({ config, response, expectedChallenge: options.challenge })).rejects.toThrow();
  });

  it("rejects a response for the wrong challenge", async () => {
    const options = await buildRegistrationOptions({ config, userId: new TextEncoder().encode("user-4"), userName: "user4" });
    const authenticator = createFixtureAuthenticator();
    const response = buildRegistrationResponseJSON({ authenticator, challenge: options.challenge, origin: ORIGIN, rpId: config.rpId });

    await expect(verifyRegistration({ config, response, expectedChallenge: "some-other-challenge" })).rejects.toThrow();
  });

  it("rejects a response with user verification not performed", async () => {
    const options = await buildRegistrationOptions({ config, userId: new TextEncoder().encode("user-5"), userName: "user5" });
    const authenticator = createFixtureAuthenticator();
    const response = buildRegistrationResponseJSON({
      authenticator,
      challenge: options.challenge,
      origin: ORIGIN,
      rpId: config.rpId,
      userVerified: false,
    });

    // requireUserVerification: true (webauthn.ts) — a UP-only (no UV) response is rejected.
    await expect(verifyRegistration({ config, response, expectedChallenge: options.challenge })).rejects.toThrow();
  });
});

describe("webauthn login verification (real crypto fixtures)", () => {
  it("verifies a genuine login response against the registered credential", async () => {
    const authenticator = createFixtureAuthenticator();
    const options = await buildLoginOptions({ config });
    const response = buildAuthenticationResponseJSON({
      authenticator,
      challenge: options.challenge,
      origin: ORIGIN,
      rpId: config.rpId,
      userHandle: "user-handle-1",
    });

    const result = await verifyLogin({
      config,
      response,
      expectedChallenge: options.challenge,
      credential: {
        id: authenticator.credentialIdBase64Url,
        publicKey: authenticator.publicKeyCose,
        counter: authenticator.counter,
      },
    });

    expect(result.verified).toBe(true);
    expect(result.authenticationInfo.userVerified).toBe(true);
    expect(result.authenticationInfo.newCounter).toBe(authenticator.counter);
  });

  it("rejects (verified: false) an assertion signed by a different key than the registered credential", async () => {
    const registered = createFixtureAuthenticator();
    const impostor = createFixtureAuthenticator({ credentialId: registered.credentialId });
    const options = await buildLoginOptions({ config });
    const response = buildAuthenticationResponseJSON({ authenticator: impostor, challenge: options.challenge, origin: ORIGIN, rpId: config.rpId });

    // A signature/public-key mismatch resolves verified:false rather than
    // throwing (unlike a challenge/origin/RPID mismatch, which throws) —
    // login.ts checks !verified.verified for exactly this reason.
    const result = await verifyLogin({
      config,
      response,
      expectedChallenge: options.challenge,
      credential: { id: registered.credentialIdBase64Url, publicKey: registered.publicKeyCose, counter: 0 },
    });
    expect(result.verified).toBe(false);
  });

  it("accepts a zero counter twice — many platform authenticators never increment", async () => {
    const authenticator = createFixtureAuthenticator({ counter: 0 });
    const options = await buildLoginOptions({ config });
    const response = buildAuthenticationResponseJSON({ authenticator, challenge: options.challenge, origin: ORIGIN, rpId: config.rpId });

    const result = await verifyLogin({
      config,
      response,
      expectedChallenge: options.challenge,
      credential: { id: authenticator.credentialIdBase64Url, publicKey: authenticator.publicKeyCose, counter: 0 },
    });

    expect(result.verified).toBe(true);
    expect(result.authenticationInfo.newCounter).toBe(0);
  });

  it("rejects a counter regression when the stored counter is nonzero", async () => {
    const authenticator = createFixtureAuthenticator({ counter: 3 });
    const options = await buildLoginOptions({ config });
    const response = buildAuthenticationResponseJSON({ authenticator, challenge: options.challenge, origin: ORIGIN, rpId: config.rpId, counterOverride: 2 });

    await expect(
      verifyLogin({
        config,
        response,
        expectedChallenge: options.challenge,
        credential: { id: authenticator.credentialIdBase64Url, publicKey: authenticator.publicKeyCose, counter: 3 },
      }),
    ).rejects.toThrow(/counter/i);
  });
});
