import { describe, expect, it } from "vitest";
import { classifyStorageArtifact, evaluateStorageSnapshots } from "@/lib/poc/turnkey/storage";

describe("storage classification", () => {
  it("allows public account identifiers and Practice UI prefs", () => {
    expect(classifyStorageArtifact("localStorage", "onchain-finance:turnkey-poc:public-account").verdict).toBe(
      "acceptable",
    );
    expect(classifyStorageArtifact("localStorage", "onchain-finance:mode").verdict).toBe("acceptable");
    expect(classifyStorageArtifact("cookie", "ocf_turnkey_poc_session").verdict).toBe("acceptable");
  });

  it("fails a JS-visible session cookie or IndexedDB stamper-like name", () => {
    expect(classifyStorageArtifact("localStorage", "ocf_turnkey_poc_session").verdict).toBe("unacceptable");
    expect(classifyStorageArtifact("indexedDB", "TurnkeyIndexedDbStamper").verdict).toBe("unacceptable");
    expect(classifyStorageArtifact("cookie", "ocf_turnkey_poc_session", { httpOnly: false }).verdict).toBe(
      "unacceptable",
    );
  });

  it("fails Gate 1 storage evaluation when a signing artifact appears", () => {
    const result = evaluateStorageSnapshots([
      {
        at: "after-signing",
        localStorage: ["onchain-finance:turnkey-poc:public-account"],
        sessionStorage: [],
        indexedDB: ["TurnkeySessionKey"],
        cookies: [],
      },
    ]);
    expect(result.failed).toBe(true);
  });
});
