import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealServerConfig } from "@/lib/real/server/config";
import {
  forwardSignedRequest,
  isExpectedEndpointUrl,
  isFreshTimestamp,
  isUnambiguousJson,
  parseSignedBody,
  parseSignedTurnkeyRequest,
  TURNKEY_STAMP_FRESHNESS_WINDOW_MS,
} from "@/lib/real/server/turnkey-signed-request";

const config = { turnkeyApiBaseUrl: "https://api.turnkey.com" } as RealServerConfig;
const stamp = { stampHeaderName: "X-Stamp-Webauthn", stampHeaderValue: '{"x":1}' };

describe("turnkey-signed-request", () => {
  it("forwards the byte-identical body with the original stamp header to the server-derived URL", async () => {
    const body = '{ "odd":  "spacing",\n"kept":true }';
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ activity: { id: "a1", status: "ACTIVITY_STATUS_PENDING" } }), { status: 200 }));
    const out = await forwardSignedRequest({ config, endpoint: "delete_authenticators", body, stamp, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toMatchObject({ kind: "activity", activity: { id: "a1", status: "ACTIVITY_STATUS_PENDING" } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://api.turnkey.com/public/v1/submit/delete_authenticators");
    expect(init.body).toBe(body);
    expect(init.headers["X-Stamp-Webauthn"]).toBe(stamp.stampHeaderValue);
    expect(init.redirect).toBe("error");
  });

  it.each([
    ["a network error", async () => Promise.reject(new Error("down"))],
    ["a non-2xx response", async () => new Response(JSON.stringify({ activity: { id: "a1", status: "x" } }), { status: 400 })],
    ["an unparseable body", async () => new Response("not json", { status: 200 })],
    ["a response without an activity id", async () => new Response(JSON.stringify({ activity: { status: "x" } }), { status: 200 })],
  ])("%s yields 'no_activity' (unknown — never treated as failure)", async (_label, impl) => {
    const out = await forwardSignedRequest({ config, endpoint: "create_authenticators", body: "{}", stamp, fetchImpl: vi.fn(impl) as unknown as typeof fetch });
    expect(out).toEqual({ kind: "no_activity" });
  });

  it("accepts only the exact expected endpoint URL for the activity", () => {
    expect(isExpectedEndpointUrl(config, "create_authenticators", "https://api.turnkey.com/public/v1/submit/create_authenticators")).toBe(true);
    expect(isExpectedEndpointUrl(config, "create_authenticators", "https://api.turnkey.com/public/v1/submit/delete_authenticators")).toBe(false);
    expect(isExpectedEndpointUrl(config, "delete_authenticators", "https://api.turnkey.com.evil.example/public/v1/submit/delete_authenticators")).toBe(false);
  });

  it("parses only well-formed signed requests with the WebAuthn stamp header", () => {
    expect(parseSignedTurnkeyRequest({ body: "{}", url: "u", stamp })).not.toBeNull();
    expect(parseSignedTurnkeyRequest({ body: "{}", url: "u", stamp: { ...stamp, stampHeaderName: "X-Stamp" } })).toBeNull();
    expect(parseSignedTurnkeyRequest({ body: "", url: "u", stamp })).toBeNull();
    expect(parseSignedTurnkeyRequest({ body: "x".repeat(20_000), url: "u", stamp })).toBeNull();
    expect(parseSignedTurnkeyRequest("nope")).toBeNull();
  });

  it.each([
    ["root duplicate", '{"a":1,"a":2}'],
    ["nested duplicate", '{"p":{"ids":["x"],"ids":["y"]}}'],
    ["duplicate inside an object in an array", '{"list":[{"k":1},{"k":1,"k":2}]}'],
    ["escaped spelling of the same name", '{"foo":1,"f\\u006fo":2}'],
    ["escaped spelling, upper-case hex", '{"foo":1,"f\\u006Fo":2}'],
    ["escaped solidus spelling", '{"a/b":1,"a\\/b":2}'],
    ["surrogate-pair escape of a literal non-BMP name", '{"😀":1,"\\ud83d\\ude00":2}'],
    ["duplicate separated by whitespace", '{ "a" : 1 ,\n "a" : 1 }'],
  ])("rejects a %s — even when both values agree or JSON.parse would accept it", (_label, text) => {
    expect(() => JSON.parse(text)).not.toThrow();
    expect(isUnambiguousJson(text)).toBe(false);
    expect(parseSignedTurnkeyRequest({ body: text, url: "u", stamp })).toBeNull();
    expect(parseSignedBody(text)).toBeNull();
  });

  it.each([
    ["trailing comma", '{"a":1,}'],
    ["leading zero", '{"a":01}'],
    ["raw control character in a string", '{"a":"x\ty"}'],
    ["bad escape", '{"a":"\\x"}'],
    ["short unicode escape", '{"a":"\\u12"}'],
    ["byte-order mark", '﻿{"a":1}'],
    ["trailing garbage", '{"a":1} x'],
    ["unterminated", '{"a":"b'],
    ["single quotes", "{'a':1}"],
    ["excessive nesting", `${"[".repeat(40)}${"]".repeat(40)}`],
  ])("malformed JSON fails closed: %s", (_label, text) => {
    expect(isUnambiguousJson(text)).toBe(false);
  });

  it.each([
    ["the same name in sibling objects", '{"a":{"k":1},"b":{"k":1}}'],
    ["repeated array values", '{"ids":["x","x"]}'],
    ["objects in an array sharing names", '[{"k":1},{"k":2}]'],
    ["names differing only by case", '{"a":1,"A":2}'],
    ["all value kinds", '{"s":"\\"q\\" \\\\ \\u00e9","n":-1.5e+3,"t":true,"f":false,"z":null,"e":{},"l":[]}'],
    ["surrounding whitespace", ' \n{"a":1}\r\n '],
  ])("accepts %s", (_label, text) => {
    expect(isUnambiguousJson(text)).toBe(true);
  });

  it("the stamp header value must be unambiguous too", () => {
    expect(parseSignedTurnkeyRequest({ body: "{}", url: "u", stamp: { ...stamp, stampHeaderValue: '{"credentialId":"a","credentialId":"b"}' } })).toBeNull();
  });

  it("freshness window is bounded in both directions", () => {
    const now = 1_000_000_000;
    expect(isFreshTimestamp(now - TURNKEY_STAMP_FRESHNESS_WINDOW_MS, now)).toBe(true);
    expect(isFreshTimestamp(now - TURNKEY_STAMP_FRESHNESS_WINDOW_MS - 1, now)).toBe(false);
    expect(isFreshTimestamp(now + 120_000, now)).toBe(false);
  });
});

describe("forwardSignedRequest — opt-in caller deadline (M3D DELETE forward)", () => {
  afterEach(() => vi.useRealTimers());

  const bounded = (fetchImpl: typeof fetch, deadlineMs: number) => forwardSignedRequest({ config, endpoint: "delete_authenticators", body: "{}", stamp, fetchImpl, deadlineMs });

  it("keeps the request itself byte-identical and only adds an abort signal", async () => {
    vi.useFakeTimers();
    const body = '{ "odd":  "spacing" }';
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ activity: { id: "a1", status: "ACTIVITY_STATUS_PENDING" } }), { status: 200 }));
    const out = await forwardSignedRequest({ config, endpoint: "delete_authenticators", body, stamp, fetchImpl: fetchImpl as unknown as typeof fetch, deadlineMs: 10_000 });
    expect(out).toMatchObject({ kind: "activity", activity: { id: "a1" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://api.turnkey.com/public/v1/submit/delete_authenticators");
    expect(init.body).toBe(body);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "X-Stamp-Webauthn": stamp.stampHeaderValue });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles with 'no_activity' at the deadline when the fetch never settles, and aborts the signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    let settled: unknown;
    void bounded(fetchImpl as unknown as typeof fetch, 5_000).then((value) => (settled = value));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ kind: "no_activity" });
    expect(signal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a response whose body never finishes is bounded by the same total deadline", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as unknown as Response);
    let settled: unknown;
    void bounded(fetchImpl as unknown as typeof fetch, 5_000).then((value) => (settled = value));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ kind: "no_activity" });
  });

  it("an answer that arrives after the deadline cannot change the settled result", async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
    let settled: unknown;
    void bounded(fetchImpl as unknown as typeof fetch, 5_000).then((value) => (settled = value));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toEqual({ kind: "no_activity" });
    release(new Response(JSON.stringify({ activity: { id: "late", status: "x" } }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual({ kind: "no_activity" });
  });

  it.each([
    ["a rejection", () => Promise.reject(new Error("down"))],
    [
      "a synchronous exception",
      () => {
        throw new Error("boom");
      },
    ],
    ["a non-2xx answer", async () => new Response("{}", { status: 502 })],
    ["unparseable JSON", async () => new Response("not json", { status: 200 })],
  ])("%s is still 'no_activity' and clears its timer", async (_label, impl) => {
    vi.useFakeTimers();
    expect(await bounded(vi.fn(impl) as unknown as typeof fetch, 5_000)).toEqual({ kind: "no_activity" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("without a deadline there is no signal, no timer, and the exact fetch passed in is used", async () => {
    vi.useFakeTimers();
    const inits: Array<RequestInit | undefined> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => (inits.push(init), new Response(JSON.stringify({ activity: { id: "a1", status: "x" } }), { status: 200 })));
    await forwardSignedRequest({ config, endpoint: "create_authenticators", body: "{}", stamp, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(inits[0]).not.toHaveProperty("signal");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -5, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid deadline (%s) before sending", async (bad) => {
    const fetchImpl = vi.fn();
    await expect(bounded(fetchImpl as unknown as typeof fetch, bad)).rejects.toBeInstanceOf(RangeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
