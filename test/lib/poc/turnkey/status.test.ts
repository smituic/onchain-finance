import { describe, expect, it } from "vitest";
import { normalizeOperationStatus, statusAfterTransportUncertainty } from "@/lib/poc/turnkey/status";

describe("operation status", () => {
  it("keeps the diagnostic states distinct", () => {
    expect(normalizeOperationStatus("submitted")).toBe("submitted");
    expect(normalizeOperationStatus("pending")).toBe("pending");
    expect(normalizeOperationStatus("confirmed")).toBe("confirmed");
    expect(normalizeOperationStatus("unknown")).toBe("unknown");
  });

  it("does not treat a timeout as failure", () => {
    expect(statusAfterTransportUncertainty("submitted")).toBe("unknown");
    expect(statusAfterTransportUncertainty("pending")).toBe("unknown");
    expect(statusAfterTransportUncertainty("confirmed")).toBe("confirmed");
    expect(statusAfterTransportUncertainty("failed")).toBe("failed");
    expect(normalizeOperationStatus("timeout")).toBe("unknown");
  });
});
