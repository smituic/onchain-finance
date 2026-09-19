import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OWNERSHIP_FACTS,
  PRIVY_JS_SDK_CORE_VERSION,
  PRIVY_REACT_AUTH_VERSION,
  SDK_STATIC_SECURITY_RESULT,
  SELECTED_ARCHITECTURE,
} from "@/lib/poc/privy/sdk-static";

function readFile(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

function findJsSdkCoreEsm(): string {
  const pnpm = path.join(process.cwd(), "node_modules/.pnpm");
  const dirs = fs.readdirSync(pnpm).filter((d) => d.startsWith("@privy-io+js-sdk-core@"));
  const match = dirs.find((d) => d.includes(PRIVY_JS_SDK_CORE_VERSION));
  if (!match) {
    throw new Error(`@privy-io/js-sdk-core@${PRIVY_JS_SDK_CORE_VERSION} not found under node_modules/.pnpm`);
  }
  return readFile(path.join("node_modules/.pnpm", match, "node_modules/@privy-io/js-sdk-core/dist/esm/index.mjs"));
}

function findJsSdkCoreDts(): string {
  const pnpm = path.join(process.cwd(), "node_modules/.pnpm");
  const dirs = fs.readdirSync(pnpm).filter((d) => d.startsWith("@privy-io+js-sdk-core@"));
  const match = dirs.find((d) => d.includes(PRIVY_JS_SDK_CORE_VERSION));
  if (!match) {
    throw new Error(`@privy-io/js-sdk-core@${PRIVY_JS_SDK_CORE_VERSION} not found under node_modules/.pnpm`);
  }
  return readFile(path.join("node_modules/.pnpm", match, "node_modules/@privy-io/js-sdk-core/dist/dts/index.d.ts"));
}

describe("installed Privy SDK — versions and selected architecture", () => {
  it("pins the installed @privy-io/react-auth version", () => {
    const pkg = JSON.parse(readFile("node_modules/@privy-io/react-auth/package.json")) as { version: string };
    expect(pkg.version).toBe(PRIVY_REACT_AUTH_VERSION);
  });

  it("does not pull permissionless / wagmi / ethers into this repo's package.json", () => {
    const pkg = JSON.parse(readFile("package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@privy-io/react-auth"]).toBe(PRIVY_REACT_AUTH_VERSION);
    expect(pkg.dependencies.viem).toBeDefined();
    expect(pkg.dependencies.permissionless).toBeUndefined();
    expect(pkg.dependencies.wagmi).toBeUndefined();
    expect(pkg.dependencies.ethers).toBeUndefined();
    expect(pkg.dependencies["@coinbase/wallet-sdk"]).toBeUndefined();
  });

  it("documents native sponsorship rather than Kernel/ERC-4337 as the selected path", () => {
    expect(SELECTED_ARCHITECTURE).toMatch(/native-sponsorship/);
    expect(SELECTED_ARCHITECTURE).not.toMatch(/kernel/i);
  });
});

describe("installed Privy SDK — session storage (js-sdk-core source)", () => {
  const esm = findJsSdkCoreEsm();
  const dts = findJsSdkCoreDts();

  it("implements LocalStorage on window.localStorage", () => {
    expect(esm).toContain("localStorage.getItem(e)");
    expect(esm).toContain("localStorage.setItem(e,JSON.stringify(t))");
    expect(esm).toContain("localStorage.removeItem(e)");
  });

  it("names the session credential keys that the storage audit classifies", () => {
    expect(esm).toContain("`privy:token`");
    expect(esm).toContain("`privy:refresh_token`");
    expect(esm).toContain("`privy:pat`");
    expect(esm).toContain("`privy:id-token`");
    expect(esm).toContain("`privy-token`");
    expect(esm).toContain("`privy-refresh-token`");
    expect(esm).toContain("`privy-session`");
  });

  it("always puts the access token in _storage; cookies are a parallel write", () => {
    expect(esm).toContain("await this._storage.put(n,t)");
    expect(esm).toContain("this.writeCookie(r,t,");
  });

  it("gates only the cookie mirror on useServerCookies or cookieWriteBehavior never", () => {
    expect(dts).toContain("type CookieWriteBehavior = 'default' | 'never'");
    expect(esm).toContain("ir=({useServerCookies:e,cookieWriteBehavior:t})=>e||t===`never`?!1:!rr()");
    expect(esm).toContain("shouldWriteCookies(){return ir({useServerCookies:this._isUsingServerCookies,cookieWriteBehavior:this._cookieWriteBehavior})}");
    expect(esm).toContain("writeCookie(e,t,n){this.shouldWriteCookies()&&R.set(e,t,n)}");
  });

  it("turns on server-cookie mode from app config custom_api_url, not from a client flag that disables localStorage", () => {
    expect(esm).toContain("this._config?.custom_api_url&&(this.baseUrl=this._config.custom_api_url,this.session.isUsingServerCookies=!0)");
    expect(esm).not.toMatch(/HttpOnly/);
  });

  it("always puts the refresh token in _storage even when server cookies are in play", () => {
    const storeRefresh = esm.slice(esm.indexOf("async storeRefreshTokenForUser"), esm.indexOf("async updateWithTokensResponse"));
    expect(storeRefresh).toContain("await this._storage.put(n,t)");
    // CookiesEnabled is reported on the event; it must not wrap the put.
    const putIndex = storeRefresh.indexOf("await this._storage.put(n,t)");
    const beforePut = storeRefresh.slice(0, putIndex);
    expect(beforePut).not.toMatch(/isUsingServerCookies/);
    expect(beforePut).not.toMatch(/shouldWriteCookies/);
  });
});

describe("installed Privy SDK — React types for the selected path", () => {
  const indexDts = readFile("node_modules/@privy-io/react-auth/dist/dts/index.d.ts");
  const smartDts = readFile("node_modules/@privy-io/react-auth/dist/dts/smart-wallets.d.ts");
  const contextCjs = readFile("node_modules/@privy-io/react-auth/dist/cjs/privy-context-jN1x5EqS.js");

  it("exposes native sponsorship as sendTransaction(..., { sponsor?: boolean }) returning { hash }", () => {
    expect(indexDts).toContain("sponsor?: boolean");
    expect(indexDts).toContain("sendTransaction: (input: UnsignedTransactionRequest, options?: {");
    expect(indexDts).toContain("Promise<{\n        hash: `0x${string}`;\n    }>");
    expect(indexDts).not.toContain("userOperationHash");
  });

  it("still exports the ERC-4337 SmartWalletsProvider path we deliberately did not take", () => {
    expect(smartDts).toContain("bundlerUrl: string");
    expect(smartDts).toContain("paymasterUrl?: string");
    expect(smartDts).toContain("declare const SmartWalletsProvider");
  });

  it("names the deprecated refresh-token placeholder without us ever reading a value", () => {
    expect(contextCjs).toContain('exports.DEPRECATED_REFRESH_TOKEN="deprecated"');
    expect(contextCjs).toContain('exports.IDENTITY_TOKEN_STORAGE_KEY="privy:id_token"');
  });

  it("exports passkey signup/login hooks used by the bridge", () => {
    expect(indexDts).toContain("useSignupWithPasskey");
    expect(indexDts).toContain("useLoginWithPasskey");
  });
});

describe("static security verdict", () => {
  it("is FAIL because a sensitive credential must land in localStorage", () => {
    expect(SDK_STATIC_SECURITY_RESULT).toBe("FAIL");
  });

  it("records ownership facts as questions, not slogans", () => {
    expect(OWNERSHIP_FACTS.map((f) => f.question)).toEqual([
      "Who controls the embedded wallet?",
      "Where does signing material exist?",
      "Can Privy sign without user authorization?",
      "Can our app/server sign?",
      "Smart account owner structure?",
      "Is this user-owned / non-custodial?",
    ]);
  });
});
