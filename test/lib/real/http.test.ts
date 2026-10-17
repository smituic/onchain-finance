import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_BODY_MAX_BYTES, GENERIC_SERVER_ERROR_MESSAGE, REQUEST_TOO_LARGE_MESSAGE, jsonError, jsonInternalError, readBoundedJsonBody, readJsonBody, requestTooLargeResponse } from "@/lib/real/server/http";

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

// ---------------------------------------------------------------------------
// Milestone 3B, Slice 3B-1: the bounded JSON reader and the 413 response.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const LIMIT = CONTROL_BODY_MAX_BYTES;

/** A JSON object whose serialized form is exactly `bytes` ASCII bytes. */
const jsonOfBytes = (bytes: number) => `{"a":"${"x".repeat(bytes - 8)}"}`;

type StreamSpy = { stream: ReadableStream<Uint8Array>; pulls: () => number; cancels: () => unknown[] };

/** A body stream that hands out `chunks` one per pull, counting pulls and recording cancellation. */
function chunkedStream(chunks: Array<Uint8Array | string>, after?: "error" | "hang", error: Error = new Error("socket reset")): StreamSpy {
  let index = 0;
  let pulls = 0;
  const cancels: unknown[] = [];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (index < chunks.length) {
        const chunk = chunks[index++]!;
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        return;
      }
      if (after === "error") controller.error(error);
      else if (after === "hang") return new Promise<void>(() => undefined);
      else controller.close();
    },
    cancel(reason) {
      cancels.push(reason);
    },
  });
  return { stream, pulls: () => pulls, cancels: () => cancels };
}

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/x", { method: "POST", headers, body });
}

function streamed(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/x", { method: "POST", headers, body: stream, duplex: "half" } as RequestInit & { duplex: "half" });
}

describe("requestTooLargeResponse — the one 413", () => {
  it("is HTTP 413 with exactly { error, code } — not retryable, no Retry-After, nothing from the request", async () => {
    const response = requestTooLargeResponse();
    expect(response.status).toBe(413);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(await response.json()).toEqual({ error: "This request is too large.", code: "request_too_large" });
    expect(REQUEST_TOO_LARGE_MESSAGE).toBe("This request is too large.");
  });

  it("the control budget is 4 KiB", () => {
    expect(CONTROL_BODY_MAX_BYTES).toBe(4096);
  });
});

describe("readBoundedJsonBody — the size limit", () => {
  it("accepts a body of exactly 4096 bytes and rejects 4097, with and without a declared length", async () => {
    const exact = jsonOfBytes(LIMIT);
    expect(encoder.encode(exact).byteLength).toBe(LIMIT);
    expect(await readBoundedJsonBody(post(exact), LIMIT)).toEqual({ kind: "ok", value: { a: "x".repeat(LIMIT - 8) } });
    expect(await readBoundedJsonBody(post(exact, { "content-length": String(LIMIT) }), LIMIT)).toMatchObject({ kind: "ok" });

    const over = jsonOfBytes(LIMIT + 1);
    expect(await readBoundedJsonBody(post(over), LIMIT)).toEqual({ kind: "too_large" });
    expect(await readBoundedJsonBody(post(over, { "content-length": String(LIMIT + 1) }), LIMIT)).toEqual({ kind: "too_large" });
  });

  it("counts BYTES, not characters, at the boundary: 2-byte characters fill exactly 4096; one more byte of whitespace is too large", async () => {
    const twoByte = `{"a":"${"\u00e9".repeat((LIMIT - 8) / 2)}"}`;
    expect(encoder.encode(twoByte).byteLength).toBe(LIMIT);
    expect(twoByte.length).toBeLessThan(LIMIT);
    expect(await readBoundedJsonBody(post(twoByte), LIMIT)).toMatchObject({ kind: "ok" });
    expect(await readBoundedJsonBody(post(`${twoByte} `), LIMIT)).toEqual({ kind: "too_large" });
  });

  it("a declared length above the limit is too_large immediately — the body is cancelled, not read", async () => {
    const spy = chunkedStream(['{"a":1}']);
    const result = await readBoundedJsonBody(streamed(spy.stream, { "content-length": String(LIMIT + 1) }), LIMIT);
    expect(result).toEqual({ kind: "too_large" });
    expect(spy.pulls()).toBeLessThanOrEqual(1); // at most the stream's initial fill, never a read by us
    await Promise.resolve();
    expect(spy.cancels()).toHaveLength(1);
  });

  it("a declared length above the limit is too_large even if the actual body is short", async () => {
    expect(await readBoundedJsonBody(post("{}", { "content-length": "9999" }), LIMIT)).toEqual({ kind: "too_large" });
    expect(await readBoundedJsonBody(post(null, { "content-length": String(Number.MAX_SAFE_INTEGER) }), LIMIT)).toEqual({ kind: "too_large" });
  });

  it("actual bytes above the limit are too_large with no Content-Length (chunked), and the stream is cancelled", async () => {
    const spy = chunkedStream([jsonOfBytes(3000), "x".repeat(1200), "never read", "never read either"]);
    const result = await readBoundedJsonBody(streamed(spy.stream), LIMIT);
    expect(result).toEqual({ kind: "too_large" });
    expect(Object.keys(result)).toEqual(["kind"]); // nothing from the oversized body is carried out
    await Promise.resolve();
    expect(spy.cancels()).toHaveLength(1);
    expect(spy.pulls()).toBeLessThanOrEqual(4); // the chunks after the overflow are never requested
  });

  it("a small declared length cannot hide an oversized body: actual bytes decide", async () => {
    expect(await readBoundedJsonBody(post(jsonOfBytes(LIMIT + 50), { "content-length": "10" }), LIMIT)).toEqual({ kind: "too_large" });
  });

  it("stops reading at the first chunk that would cross the limit and never asks for more", async () => {
    const spy = chunkedStream([jsonOfBytes(LIMIT - 10), "y".repeat(11), "z", "z", "z"]);
    expect(await readBoundedJsonBody(streamed(spy.stream), LIMIT)).toEqual({ kind: "too_large" });
    await Promise.resolve();
    // Two chunks were read (the second one crossed the line); the stream's own look-ahead is at most one more.
    expect(spy.pulls()).toBeLessThanOrEqual(3);
    expect(spy.cancels()).toHaveLength(1);
  });

  it("an in-limit streamed body in many chunks is accepted, with or without a declared length", async () => {
    const text = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => `value-${i}`) });
    const pieces = text.match(/.{1,37}/g)!;
    expect(encoder.encode(text).byteLength).toBeLessThanOrEqual(LIMIT);
    expect(await readBoundedJsonBody(streamed(chunkedStream(pieces).stream), LIMIT)).toEqual({ kind: "ok", value: JSON.parse(text) });
    expect(await readBoundedJsonBody(streamed(chunkedStream(pieces).stream, { "content-length": String(encoder.encode(text).byteLength) }), LIMIT)).toEqual({ kind: "ok", value: JSON.parse(text) });
  });

  it("is generic in maxBytes: a smaller explicit limit applies", async () => {
    expect(await readBoundedJsonBody(post('{"a":1}'), 7)).toEqual({ kind: "ok", value: { a: 1 } });
    expect(await readBoundedJsonBody(post('{"a":12}'), 7)).toEqual({ kind: "too_large" });
  });

  it("requires an explicit positive safe-integer limit — there is no unlimited default", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, undefined, null, "4096"]) {
      await expect(readBoundedJsonBody(post("{}"), bad as unknown as number), String(bad)).rejects.toThrow(TypeError);
    }
    await expect((readBoundedJsonBody as unknown as (request: Request) => Promise<unknown>)(post("{}"))).rejects.toThrow(TypeError);
  });
});

describe("readBoundedJsonBody — Content-Length", () => {
  it("accepts a missing header", async () => {
    expect(await readBoundedJsonBody(post('{"a":1}'), LIMIT)).toEqual({ kind: "ok", value: { a: 1 } });
  });

  it("accepts a matching declared length", async () => {
    expect(await readBoundedJsonBody(post('{"a":1}', { "content-length": "7" }), LIMIT)).toEqual({ kind: "ok", value: { a: 1 } });
  });

  it("a declared length SHORTER than the body (and within the limit) is invalid, not too_large", async () => {
    expect(await readBoundedJsonBody(post('{"a":"long enough"}', { "content-length": "5" }), LIMIT)).toEqual({ kind: "invalid" });
  });

  it("a declared length LONGER than the body (and within the limit) is invalid, not too_large", async () => {
    expect(await readBoundedJsonBody(post('{"a":1}', { "content-length": "100" }), LIMIT)).toEqual({ kind: "invalid" });
  });

  it("a malformed length is invalid: not decimal digits only", async () => {
    for (const bad of ["abc", "-1", "+5", "1e3", "5.0", " 5", "5 ", "0x10", "", "5,5", "5, 5", "\u00b2"]) {
      expect(await readBoundedJsonBody(post('{"a":1}', { "content-length": bad }), LIMIT), JSON.stringify(bad)).toEqual({ kind: "invalid" });
    }
  });

  it("a duplicated Content-Length header is invalid, even when both copies agree", async () => {
    const headers = new Headers();
    headers.append("content-length", "7");
    headers.append("content-length", "7");
    expect(await readBoundedJsonBody(new Request("http://localhost/x", { method: "POST", headers, body: '{"a":1}' }), LIMIT)).toEqual({ kind: "invalid" });
  });

  it("an unsafe-integer length is invalid; a huge-but-safe length is too_large", async () => {
    for (const unsafe of ["9007199254740992", "9007199254740993", "99999999999999999999", "1".repeat(400)]) {
      expect(await readBoundedJsonBody(post("{}", { "content-length": unsafe }), LIMIT), unsafe).toEqual({ kind: "invalid" });
    }
    expect(await readBoundedJsonBody(post("{}", { "content-length": "9007199254740991" }), LIMIT)).toEqual({ kind: "too_large" });
  });

  it("a declared length of 0 with no body is invalid (empty), not too_large", async () => {
    expect(await readBoundedJsonBody(post(null, { "content-length": "0" }), LIMIT)).toEqual({ kind: "invalid" });
  });
});

describe("readBoundedJsonBody — UTF-8 and JSON", () => {
  const bytesRequest = (bytes: number[]) => post(new Uint8Array(bytes));
  const ascii = (text: string) => Array.from(encoder.encode(text));

  it("a multi-byte character split across chunks decodes correctly (2-, 3- and 4-byte sequences, split at every byte)", async () => {
    for (const character of ["\u00e9", "\u20ac", "\u{1F600}"]) {
      const bytes = Array.from(encoder.encode(`{"a":"${character}"}`));
      for (let cut = 1; cut < bytes.length; cut += 1) {
        const pieces = [new Uint8Array(bytes.slice(0, cut)), new Uint8Array(bytes.slice(cut))];
        expect(await readBoundedJsonBody(streamed(chunkedStream(pieces).stream), LIMIT), `${character} @${cut}`).toEqual({ kind: "ok", value: { a: character } });
      }
      // One byte per chunk.
      const single = bytes.map((b) => new Uint8Array([b]));
      expect(await readBoundedJsonBody(streamed(chunkedStream(single).stream), LIMIT)).toEqual({ kind: "ok", value: { a: character } });
    }
  });

  it("invalid UTF-8 is invalid — never decoded with replacement characters", async () => {
    expect(await readBoundedJsonBody(bytesRequest([...ascii('{"a":"'), 0xff, ...ascii('"}')]), LIMIT)).toEqual({ kind: "invalid" });
    expect(await readBoundedJsonBody(bytesRequest([...ascii('{"a":"'), 0xc3, ...ascii('"}')]), LIMIT)).toEqual({ kind: "invalid" }); // truncated 2-byte sequence
    expect(await readBoundedJsonBody(bytesRequest([...ascii('{"a":"'), 0x80, ...ascii('"}')]), LIMIT)).toEqual({ kind: "invalid" }); // stray continuation byte
    // The same bytes through request.json() would have been silently repaired to U+FFFD:
    expect(await post(new Uint8Array([...ascii('{"a":"'), 0xff, ...ascii('"}')])).json()).toEqual({ a: "\uFFFD" });
  });

  it("an overlong encoding is invalid (C0 AF = overlong '/', E0 80 AF = overlong '/')", async () => {
    expect(await readBoundedJsonBody(bytesRequest([...ascii('{"a":"'), 0xc0, 0xaf, ...ascii('"}')]), LIMIT)).toEqual({ kind: "invalid" });
    expect(await readBoundedJsonBody(bytesRequest([...ascii('{"a":"'), 0xe0, 0x80, 0xaf, ...ascii('"}')]), LIMIT)).toEqual({ kind: "invalid" });
  });

  it("a UTF-8-encoded surrogate (ED A0 80 = U+D800) is invalid", async () => {
    expect(await readBoundedJsonBody(bytesRequest([...ascii('{"a":"'), 0xed, 0xa0, 0x80, ...ascii('"}')]), LIMIT)).toEqual({ kind: "invalid" });
  });

  it("a single leading BOM is dropped, exactly as request.json() does", async () => {
    const withBom = [0xef, 0xbb, 0xbf, ...ascii('{"a":1}')];
    expect(await readBoundedJsonBody(bytesRequest(withBom), LIMIT)).toEqual({ kind: "ok", value: { a: 1 } });
    expect(await post(new Uint8Array(withBom)).json()).toEqual({ a: 1 });
  });

  it("a double BOM is invalid", async () => {
    const twice = [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...ascii('{"a":1}')];
    expect(await readBoundedJsonBody(bytesRequest(twice), LIMIT)).toEqual({ kind: "invalid" });
  });

  it("a BOM in the middle of a string is data, not stripped", async () => {
    expect(await readBoundedJsonBody(post('{"a":"x\uFEFFy"}'), LIMIT)).toEqual({ kind: "ok", value: { a: "x\uFEFFy" } });
  });

  it("malformed JSON is invalid", async () => {
    for (const bad of ["{not json", '{"a":1', '{"a":1}}', "{'a':1}", '{"a":1,}', "undefined", "NaN", "{a:1}", '{"a":1} trailing']) {
      expect(await readBoundedJsonBody(post(bad), LIMIT), bad).toEqual({ kind: "invalid" });
    }
  });

  it("an empty, whitespace-only, or missing body is invalid", async () => {
    expect(await readBoundedJsonBody(post(""), LIMIT)).toEqual({ kind: "invalid" });
    expect(await readBoundedJsonBody(post("  \n\t "), LIMIT)).toEqual({ kind: "invalid" });
    expect(await readBoundedJsonBody(new Request("http://localhost/x", { method: "POST" }), LIMIT)).toEqual({ kind: "invalid" });
  });

  it("JSON null (and the other valid scalars and arrays) are ok — each route keeps its own validation", async () => {
    expect(await readBoundedJsonBody(post("null"), LIMIT)).toEqual({ kind: "ok", value: null });
    expect(await readBoundedJsonBody(post("false"), LIMIT)).toEqual({ kind: "ok", value: false });
    expect(await readBoundedJsonBody(post("0"), LIMIT)).toEqual({ kind: "ok", value: 0 });
    expect(await readBoundedJsonBody(post('"text"'), LIMIT)).toEqual({ kind: "ok", value: "text" });
    expect(await readBoundedJsonBody(post("[1,2]"), LIMIT)).toEqual({ kind: "ok", value: [1, 2] });
  });

  it("does not trim, normalize, or reserialize: strings come back exactly as sent", async () => {
    const result = await readBoundedJsonBody(post('{"a":"  padded  ","b":"e\u0301","c":"\u00e9"}'), LIMIT);
    expect(result).toEqual({ kind: "ok", value: { a: "  padded  ", b: "e\u0301", c: "\u00e9" } });
    expect((result as { value: { b: string; c: string } }).value.b).not.toBe((result as { value: { b: string; c: string } }).value.c);
  });

  it("applies no reviver: a __proto__ key stays an own data property and nothing is transformed", async () => {
    const result = (await readBoundedJsonBody(post('{"__proto__":{"polluted":true},"n":1}'), LIMIT)) as { kind: "ok"; value: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(result.value, "__proto__")).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("readBoundedJsonBody — failing, aborted, and reused streams", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a stream that errors before any data is invalid", async () => {
    expect(await readBoundedJsonBody(streamed(chunkedStream([], "error").stream), LIMIT)).toEqual({ kind: "invalid" });
  });

  it("a stream that is aborted mid-body is invalid — a valid-looking prefix is never parsed", async () => {
    const spy = chunkedStream(['{"a":1}'], "error", new Error("aborted"));
    expect(await readBoundedJsonBody(streamed(spy.stream), LIMIT)).toEqual({ kind: "invalid" });
  });

  it("a reader failure (pull throws) is invalid, never an exception", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("boom");
      },
    });
    await expect(readBoundedJsonBody(streamed(stream), LIMIT)).resolves.toEqual({ kind: "invalid" });
  });

  it("a stream that yields something other than bytes is invalid", async () => {
    const stream = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue("not bytes");
        controller.close();
      },
    }) as ReadableStream<Uint8Array>;
    expect(await readBoundedJsonBody(streamed(stream), LIMIT)).toEqual({ kind: "invalid" });
  });

  it("cancelling an oversized stream never produces an unhandled rejection, even if cancel itself fails", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("x".repeat(LIMIT + 10)));
        },
        cancel() {
          throw new Error("cancel failed");
        },
      });
      expect(await readBoundedJsonBody(streamed(stream), LIMIT)).toEqual({ kind: "too_large" });
      const declared = new ReadableStream<Uint8Array>({
        cancel() {
          return Promise.reject(new Error("cancel rejected"));
        },
      });
      expect(await readBoundedJsonBody(streamed(declared, { "content-length": String(LIMIT + 1) }), LIMIT)).toEqual({ kind: "too_large" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("a body that was already read is invalid, not an exception", async () => {
    const request = post('{"a":1}');
    await request.text();
    expect(await readBoundedJsonBody(request, LIMIT)).toEqual({ kind: "invalid" });
  });

  it("never logs the request body, on success, rejection, or overflow", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const secret = "TOP-SECRET-BODY-MARKER";
    await readBoundedJsonBody(post(`{"a":"${secret}"}`), LIMIT);
    await readBoundedJsonBody(post(`{"a":"${secret}`), LIMIT);
    await readBoundedJsonBody(post(`{"a":"${secret}${"x".repeat(LIMIT)}"}`), LIMIT);
    await readBoundedJsonBody(post(`{"a":"${secret}"}`, { "content-length": "bad" }), LIMIT);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
