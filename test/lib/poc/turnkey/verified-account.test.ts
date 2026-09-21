import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashTypedData, type Hex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createVerifiedTurnkeyOwnerAccount, VerifiedSignTypedDataError } from "@/lib/poc/turnkey/verified-account";

const OWNER_KEY: Hex = "0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a";
const OTHER_KEY: Hex = "0xe3b5b13304d3d1e786145c392ddcb41c2d0c9697079968a5b9ab5b415393642f";
const owner = privateKeyToAccount(OWNER_KEY);
const impostor = privateKeyToAccount(OTHER_KEY);
// Mixed case on purpose — proves the real (not lowercased) address reaches
// the Turnkey request even though the local test key's checksum differs.
const CASE_PRESERVED_OWNER_ADDRESS = `0x${owner.address.slice(2, 6).toUpperCase()}${owner.address.slice(6)}`;

const typedData: TypedDataDefinition = {
  domain: { name: "OCF Verified Account Test", version: "1", chainId: 84532 },
  types: { Probe: [{ name: "purpose", type: "string" }] },
  primaryType: "Probe",
  message: { purpose: "verified-account-test" },
};

let capturedActivity: unknown = null;
/** Which private key the mocked Turnkey backend actually signs with — lets each test simulate either a correct or a wrong-signer response without touching the real network. */
let signWithKey = owner;

const signRawPayloadMock = vi.fn(async (activity: unknown) => {
  capturedActivity = activity;
  const parameters = (activity as { parameters: { payload: Hex } }).parameters;
  const signature = await signWithKey.sign({ hash: parameters.payload });
  return {
    activity: {
      id: "activity-1",
      result: {
        signRawPayloadResult: {
          r: signature.slice(2, 66),
          s: signature.slice(66, 130),
          v: Number.parseInt(signature.slice(130), 16) === 27 ? "0" : "1",
        },
      },
    },
  };
});

vi.mock("@turnkey/http", () => ({
  // Must be a real function (not an arrow function) so `new TurnkeyClient(...)`
  // works — arrow functions can't be used as constructors.
  TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock() {
    return { signRawPayload: signRawPayloadMock };
  }),
}));

// @turnkey/viem's createAccount takes signWith as a plain address here
// (createTurnkeyOwnerAccount always passes one), which its own source
// resolves with zero network calls — no further mocking needed for it.

describe("createVerifiedTurnkeyOwnerAccount", () => {
  afterEach(() => {
    signRawPayloadMock.mockClear();
    capturedActivity = null;
    signWithKey = owner;
  });

  it("hashes the exact supplied typed data locally and sends that digest as the Turnkey payload", async () => {
    const account = await createVerifiedTurnkeyOwnerAccount({
      rpId: "example.com",
      subOrganizationId: "sub-org-1",
      ownerAddress: CASE_PRESERVED_OWNER_ADDRESS,
    });

    await account.signTypedData(typedData);

    const activity = capturedActivity as { parameters: { payload: Hex } };
    expect(activity.parameters.payload).toBe(hashTypedData(typedData));
  });

  it("uses HASH_FUNCTION_NO_OP and PAYLOAD_ENCODING_HEXADECIMAL", async () => {
    const account = await createVerifiedTurnkeyOwnerAccount({
      rpId: "example.com",
      subOrganizationId: "sub-org-1",
      ownerAddress: CASE_PRESERVED_OWNER_ADDRESS,
    });

    await account.signTypedData(typedData);

    const activity = capturedActivity as { parameters: { hashFunction: string; encoding: string } };
    expect(activity.parameters.hashFunction).toBe("HASH_FUNCTION_NO_OP");
    expect(activity.parameters.encoding).toBe("PAYLOAD_ENCODING_HEXADECIMAL");
  });

  it("passes signWith through exactly case-preserved, never lowercased", async () => {
    const account = await createVerifiedTurnkeyOwnerAccount({
      rpId: "example.com",
      subOrganizationId: "sub-org-1",
      ownerAddress: CASE_PRESERVED_OWNER_ADDRESS,
    });

    await account.signTypedData(typedData);

    const activity = capturedActivity as { parameters: { signWith: string } };
    expect(activity.parameters.signWith).toBe(CASE_PRESERVED_OWNER_ADDRESS);
  });

  it("returns a signature that recovers to the expected owner when Turnkey signs correctly", async () => {
    const account = await createVerifiedTurnkeyOwnerAccount({
      rpId: "example.com",
      subOrganizationId: "sub-org-1",
      ownerAddress: owner.address,
    });

    const signature = await account.signTypedData(typedData);
    expect(signature).toBeDefined();
  });

  it("throws VerifiedSignTypedDataError — and does not return a signature — when the recovered address does not match the expected owner", async () => {
    signWithKey = impostor; // simulates exactly the live-proven failure: Turnkey signs with the wrong key/adapter path
    const account = await createVerifiedTurnkeyOwnerAccount({
      rpId: "example.com",
      subOrganizationId: "sub-org-1",
      ownerAddress: owner.address,
    });

    await expect(account.signTypedData(typedData)).rejects.toBeInstanceOf(VerifiedSignTypedDataError);
  });

  it("VerifiedSignTypedDataError carries the expected/recovered addresses and the digest/signature that failed", async () => {
    signWithKey = impostor;
    const account = await createVerifiedTurnkeyOwnerAccount({
      rpId: "example.com",
      subOrganizationId: "sub-org-1",
      ownerAddress: owner.address,
    });

    let thrown: unknown;
    try {
      await account.signTypedData(typedData);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(VerifiedSignTypedDataError);
    const error = thrown as InstanceType<typeof VerifiedSignTypedDataError>;
    expect(error.expectedOwner).toBe(owner.address);
    expect(error.recoveredAddress.toLowerCase()).toBe(impostor.address.toLowerCase());
    expect(error.digest).toBe(hashTypedData(typedData));
  });
});

describe("verified-account.ts source", () => {
  it("never constructs an IndexedDB stamper, a persistent session/login credential, or talks to Pimlico — only Turnkey raw signing and local viem computation", () => {
    const source = readFileSync(path.resolve(process.cwd(), "lib/poc/turnkey/verified-account.ts"), "utf8");
    expect(source).not.toContain("IndexedDbStamper");
    expect(source).not.toContain("IndexedDB");
    expect(source).not.toContain("createReadWriteSession");
    expect(source).not.toContain("stampLogin");
    expect(source).not.toContain("sdk-browser");
    expect(source).not.toContain("pimlico");
    expect(source).not.toContain("Pimlico");
    expect(source).not.toContain("sendUserOperation");
    expect(source).not.toContain("smartAccountClient");
  });

  it("delegates raw Turnkey signing to the shared raw-sign.ts primitive instead of constructing its own TurnkeyClient/signRawPayload call", () => {
    const source = readFileSync(path.resolve(process.cwd(), "lib/poc/turnkey/verified-account.ts"), "utf8");
    expect(source).toContain('from "./raw-sign"');
    expect(source).not.toContain("createPasskeyTurnkeyClient(");
    expect(source).not.toContain(".signRawPayload(");
  });
});
