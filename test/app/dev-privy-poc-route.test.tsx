import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_AREAS } from "@/lib/product-areas";

// The view pulls in the Privy SDK; the route gate is what is under test here,
// so the view is replaced with an inert stand-in. The page is called as a
// plain function and its returned element inspected — nothing is rendered.
vi.mock("@/app/dev/privy-poc/privy-poc-view", () => ({
  PrivyPocView: () => null,
}));

const ENV_KEYS = ["NEXT_PUBLIC_PRIVY_POC_ENABLED", "NEXT_PUBLIC_PRIVY_APP_ID"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

describe("/dev/privy-poc route gate", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("is a 404 when the flag is off", async () => {
    const { default: PrivyPocPage } = await import("@/app/dev/privy-poc/page");
    expect(() => PrivyPocPage()).toThrowError(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it("is a 404 for any flag value other than exactly 'true'", async () => {
    process.env.NEXT_PUBLIC_PRIVY_POC_ENABLED = "1";
    const { default: PrivyPocPage } = await import("@/app/dev/privy-poc/page");
    expect(() => PrivyPocPage()).toThrowError(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it("hands the view a failed validation when enabled but unconfigured", async () => {
    process.env.NEXT_PUBLIC_PRIVY_POC_ENABLED = "true";
    const { default: PrivyPocPage } = await import("@/app/dev/privy-poc/page");
    const { PrivyPocView } = await import("@/app/dev/privy-poc/privy-poc-view");
    const element = PrivyPocPage();
    expect(element.type).toBe(PrivyPocView);
    expect(element.props).toMatchObject({ validation: { ok: false, enabled: true } });
    expect((element.props as { validation: { errors: string[] } }).validation.errors).toEqual([
      "NEXT_PUBLIC_PRIVY_APP_ID is not set.",
    ]);
  });

  it("asks search engines not to index it", async () => {
    const { metadata } = await import("@/app/dev/privy-poc/page");
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });

  it("is not a product area and so never appears in navigation", () => {
    expect(PRODUCT_AREAS.some((area) => area.href.startsWith("/dev"))).toBe(false);
  });
});
