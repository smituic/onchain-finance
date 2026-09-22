import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { signDigestViaTurnkeyRaw } from "@/lib/real/signing/raw-sign";

const OWNER_KEY: Hex = "0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a";
const owner = privateKeyToAccount(OWNER_KEY);
// Mixed case on purpose — Turnkey's resource lookup for signWith is
// case-sensitive, so the exact case the caller passes in must reach the
// request unchanged, not the lowercased form.
const CASE_PRESERVED_OWNER_ADDRESS = `0x${owner.address.slice(2, 6).toUpperCase()}${owner.address.slice(6)}`;

type SignRawPayloadResponse = {
  activity: {
    id: string;
    result: { signRawPayloadResult?: { r: string; s: string; v: string } };
  };
};

let capturedActivity: unknown = null;
const signRawPayloadMock = vi.fn(
  async (activity: unknown): Promise<SignRawPayloadResponse> => {
    capturedActivity = activity;
    const parameters = (activity as { parameters: { payload: Hex } }).parameters;
    const signature = await owner.sign({ hash: parameters.payload });
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
  },
);

vi.mock("@turnkey/http", () => ({
  // Must be a real function (not an arrow function) so `new TurnkeyClient(...)`
  // works — arrow functions can't be used as constructors.
  TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock() {
    return { signRawPayload: signRawPayloadMock };
  }),
}));

describe("signDigestViaTurnkeyRaw", () => {
  afterEach(() => {
    signRawPayloadMock.mockClear();
    capturedActivity = null;
  });

  it("sends exactly the given digest as payload with HASH_FUNCTION_NO_OP + PAYLOAD_ENCODING_HEXADECIMAL", async () => {
    const digest = `0x${"ab".repeat(32)}` as Hex;
    await signDigestViaTurnkeyRaw({
      rpId: "example.com",
      subOrganizationId: "sub-org-1",
      ownerAddress: CASE_PRESERVED_OWNER_ADDRESS,
      digest,
    });

    const activity = capturedActivity as {
      type: string;
      organizationId: string;
      parameters: { signWith: string; payload: Hex; encoding: string; hashFunction: string };
    };
    expect(activity.type).toBe("ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2");
    expect(activity.organizationId).toBe("sub-org-1");
    expect(activity.parameters.payload).toBe(digest);
    expect(activity.parameters.hashFunction).toBe("HASH_FUNCTION_NO_OP");
    expect(activity.parameters.encoding).toBe("PAYLOAD_ENCODING_HEXADECIMAL");
  });

  it("passes signWith through case-preserved, never lowercased", async () => {
    const digest = `0x${"cd".repeat(32)}` as Hex;
    await signDigestViaTurnkeyRaw({
      rpId: "example.com",
      subOrganizationId: "sub-org-1",
      ownerAddress: CASE_PRESERVED_OWNER_ADDRESS,
      digest,
    });

    const activity = capturedActivity as { parameters: { signWith: string } };
    expect(activity.parameters.signWith).toBe(CASE_PRESERVED_OWNER_ADDRESS);
  });

  it("returns a signature that recovers to the signing key over the given digest", async () => {
    const digest = `0x${"11".repeat(32)}` as Hex;
    const { signature } = await signDigestViaTurnkeyRaw({
      rpId: "example.com",
      subOrganizationId: "sub-org-1",
      ownerAddress: owner.address,
      digest,
    });

    const recovered = await recoverAddress({ hash: digest, signature });
    expect(recovered.toLowerCase()).toBe(owner.address.toLowerCase());
  });

  it("throws when Turnkey returns a completed activity without r/s/v", async () => {
    signRawPayloadMock.mockImplementationOnce(async () => ({
      activity: { id: "activity-2", result: { signRawPayloadResult: undefined } },
    }));

    await expect(
      signDigestViaTurnkeyRaw({
        rpId: "example.com",
        subOrganizationId: "sub-org-1",
        ownerAddress: owner.address,
        digest: `0x${"22".repeat(32)}` as Hex,
      }),
    ).rejects.toThrow("without a signature");
  });
});
