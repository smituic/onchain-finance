import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { encodeCBOR, type CBORType } from "@levischuck/tiny-cbor";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { base64UrlToBytes, bytesToBase64Url } from "@/lib/real/bytes";

/**
 * A REAL (not mocked) WebAuthn ceremony fixture generator: a genuine P-256
 * keypair, genuine CBOR-encoded attestationObject ("none" format, matching
 * what generateRegistrationOptions requests) and COSE public key, genuine
 * authenticatorData byte layout, and a genuine ES256 (DER) signature over
 * authenticatorData || SHA-256(clientDataJSON). Tests that exercise
 * wrong-origin/RP-ID/challenge/UV/signature rejection go through
 * @simplewebauthn/server's actual verification, not a stub of it — a bug in
 * our verification wiring would fail these tests the same way a real
 * attacker's forged response would.
 */

const UP_FLAG = 0x01;
const UV_FLAG = 0x04;
const BE_FLAG = 0x08;
const BS_FLAG = 0x10;
const AT_FLAG = 0x40;

export type FixtureAuthenticator = {
  credentialId: Uint8Array;
  credentialIdBase64Url: string;
  privateKey: KeyObject;
  publicKeyCose: Uint8Array<ArrayBuffer>;
  counter: number;
};

export function createFixtureAuthenticator(input: { credentialId?: Uint8Array; counter?: number } = {}): FixtureAuthenticator {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x = base64UrlToBytes(jwk.x);
  const y = base64UrlToBytes(jwk.y);

  // COSE_Key (RFC 9053) EC2 key: kty=2 (EC2), alg=-7 (ES256), crv=1 (P-256).
  const publicKeyCose = encodeCBOR(
    new Map<number, CBORType>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  ) as Uint8Array<ArrayBuffer>;

  const credentialId = input.credentialId ?? crypto.getRandomValues(new Uint8Array(32));
  return {
    credentialId,
    credentialIdBase64Url: bytesToBase64Url(credentialId),
    privateKey,
    publicKeyCose,
    counter: input.counter ?? 0,
  };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function buildAuthenticatorData(input: {
  rpId: string;
  counter: number;
  userVerified: boolean;
  backupEligible?: boolean;
  backedUp?: boolean;
  attestedCredential?: { credentialId: Uint8Array; publicKeyCose: Uint8Array };
}): Uint8Array {
  const rpIdHash = new Uint8Array(createHash("sha256").update(input.rpId).digest());

  let flags = UP_FLAG;
  if (input.userVerified) flags |= UV_FLAG;
  if (input.attestedCredential) flags |= AT_FLAG;
  if (input.backupEligible) flags |= BE_FLAG;
  if (input.backedUp) flags |= BS_FLAG;

  const counterBytes = new Uint8Array(4);
  new DataView(counterBytes.buffer).setUint32(0, input.counter, false);

  const parts: Uint8Array[] = [rpIdHash, new Uint8Array([flags]), counterBytes];

  if (input.attestedCredential) {
    const aaguid = new Uint8Array(16);
    const credIdLen = new Uint8Array(2);
    new DataView(credIdLen.buffer).setUint16(0, input.attestedCredential.credentialId.length, false);
    parts.push(aaguid, credIdLen, input.attestedCredential.credentialId, input.attestedCredential.publicKeyCose);
  }

  return concatBytes(parts);
}

function buildClientDataJSONBase64Url(input: { type: "webauthn.create" | "webauthn.get"; challenge: string; origin: string }): string {
  const json = JSON.stringify({ type: input.type, challenge: input.challenge, origin: input.origin, crossOrigin: false });
  return bytesToBase64Url(new TextEncoder().encode(json));
}

export function buildRegistrationResponseJSON(input: {
  authenticator: FixtureAuthenticator;
  challenge: string;
  origin: string;
  rpId: string;
  userVerified?: boolean;
  transports?: string[];
}): RegistrationResponseJSON {
  const clientDataJSON = buildClientDataJSONBase64Url({ type: "webauthn.create", challenge: input.challenge, origin: input.origin });
  const authenticatorData = buildAuthenticatorData({
    rpId: input.rpId,
    counter: input.authenticator.counter,
    userVerified: input.userVerified ?? true,
    attestedCredential: { credentialId: input.authenticator.credentialId, publicKeyCose: input.authenticator.publicKeyCose },
  });

  const attestationObject = bytesToBase64Url(
    encodeCBOR(
      new Map<string, CBORType>([
        ["fmt", "none"],
        ["attStmt", new Map<string, CBORType>()],
        ["authData", authenticatorData],
      ]),
    ),
  );

  return {
    id: input.authenticator.credentialIdBase64Url,
    rawId: input.authenticator.credentialIdBase64Url,
    response: {
      clientDataJSON,
      attestationObject,
      transports: input.transports ?? ["internal"],
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}

export function buildAuthenticationResponseJSON(input: {
  authenticator: FixtureAuthenticator;
  challenge: string;
  origin: string;
  rpId: string;
  userVerified?: boolean;
  userHandle?: string;
  counterOverride?: number;
}): AuthenticationResponseJSON {
  const clientDataJSON = buildClientDataJSONBase64Url({ type: "webauthn.get", challenge: input.challenge, origin: input.origin });
  const authenticatorData = buildAuthenticatorData({
    rpId: input.rpId,
    counter: input.counterOverride ?? input.authenticator.counter,
    userVerified: input.userVerified ?? true,
  });

  const clientDataHash = new Uint8Array(createHash("sha256").update(base64UrlToBytes(clientDataJSON)).digest());
  const signedData = concatBytes([authenticatorData, clientDataHash]);
  const signature = cryptoSign("sha256", signedData, input.authenticator.privateKey);

  return {
    id: input.authenticator.credentialIdBase64Url,
    rawId: input.authenticator.credentialIdBase64Url,
    response: {
      clientDataJSON,
      authenticatorData: bytesToBase64Url(authenticatorData),
      signature: bytesToBase64Url(new Uint8Array(signature)),
      userHandle: input.userHandle,
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}
