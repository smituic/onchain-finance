import { describe, expect, it } from "vitest";
import { GENERIC_SERVER_ERROR_MESSAGE, jsonError, jsonInternalError, readJsonBody } from "@/lib/real/server/http";

describe("jsonInternalError — pre-2f hardening's generic 500", () => {
  it("always returns the same fixed message and status, regardless of what triggered it", async () => {
    const response = jsonInternalError();
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(GENERIC_SERVER_ERROR_MESSAGE);
  });
});

describe("readJsonBody — malformed JSON becomes null, never a thrown exception", () => {
  it("parses a well-formed JSON body", async () => {
    const request = new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(await readJsonBody(request)).toEqual({ a: 1 });
  });

  it("returns null for malformed JSON instead of throwing", async () => {
    const request = new Request("http://localhost/x", { method: "POST", body: "{not valid json" });
    await expect(readJsonBody(request)).resolves.toBeNull();
  });

  it("returns null for an empty body", async () => {
    const request = new Request("http://localhost/x", { method: "POST", body: "" });
    await expect(readJsonBody(request)).resolves.toBeNull();
  });
});

describe("jsonError", () => {
  it("sets the exact message and status requested", async () => {
    const response = jsonError("custom message", 409);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("custom message");
  });
});
