import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

function listFilesRecursive(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? listFilesRecursive(full) : [full];
  });
}

const LIB_REAL_DIR = path.resolve(process.cwd(), "lib/real");
const libRealFiles = listFilesRecursive(LIB_REAL_DIR).filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));

describe("lib/real/** boundary — no Turnkey session-login authority anywhere", () => {
  // Matches actual usage shapes (a call, a construction, or an import
  // specifier) — not the same names appearing in explanatory comments about
  // why they're absent, which several of these files deliberately have
  // (e.g. login.ts's own doc comment naming stampLogin/createReadWriteSession
  // to explain that neither is used). A naive substring check fails on
  // those comments — the same lesson learned elsewhere in this codebase
  // (verified-account.test.ts's @turnkey/viem check).
  const FORBIDDEN_TURNKEY_SESSION_PATTERNS = [
    /\.stampLogin\s*\(/,
    /\.createReadWriteSession\s*\(/,
    /\.loginWithPasskey\s*\(/,
    /\bnew\s+IndexedDbStamper\s*\(/,
    /["']CREDENTIAL_TYPE_READ_WRITE_SESSION/,
    /from\s+["']@turnkey\/(sdk-browser|sdk-server|core|indexed-db-stamper)["']/,
  ];

  it.each(libRealFiles.map((file) => [path.relative(process.cwd(), file), file] as const))(
    "%s never references a Turnkey session-login/IndexedDB-signing API",
    (_label, file) => {
      const source = readFileSync(file, "utf8");
      for (const forbidden of FORBIDDEN_TURNKEY_SESSION_PATTERNS) {
        expect(source).not.toMatch(forbidden);
      }
    },
  );

  it("the Turnkey parent API key stamper is imported only under lib/real/server/**, never a client/browser module", () => {
    const offenders = libRealFiles.filter((file) => {
      const source = readFileSync(file, "utf8");
      const importsApiKeyStamper = /from\s+["']@turnkey\/api-key-stamper["']/.test(source);
      const isServerOnly = file.includes(`${path.sep}server${path.sep}`);
      return importsApiKeyStamper && !isServerOnly;
    });
    expect(offenders).toEqual([]);
  });

  it("no components/** or lib/stores/** file imports anything from lib/real/server/** (the parent-key-holding layer)", () => {
    const projectRoot = process.cwd();
    const scanDirs = ["components", "lib/stores", "app"].map((dir) => path.join(projectRoot, dir));
    const offenders: string[] = [];
    for (const dir of scanDirs) {
      let files: string[];
      try {
        files = listFilesRecursive(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
      } catch {
        continue;
      }
      for (const file of files) {
        // app/api/real/** route handlers are the one legitimate caller of
        // lib/real/server/** — everything else (pages, components, client
        // stores) must never import it directly.
        if (file.includes(`${path.sep}app${path.sep}api${path.sep}real${path.sep}`)) continue;
        const source = readFileSync(file, "utf8");
        if (/from\s+["']@\/lib\/real\/server\//.test(source)) offenders.push(path.relative(projectRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("real-account-store.ts localStorage — public account metadata only", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists only { account } — never anything signing/Turnkey-shaped", async () => {
    vi.doMock("@simplewebauthn/browser", () => ({ startRegistration: vi.fn(), startAuthentication: vi.fn() }));
    const { useRealAccountStore, REAL_ACCOUNT_STORE_NAME } = await import("@/lib/stores/real-account-store");

    useRealAccountStore.setState({
      account: { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" },
      status: "ready",
      error: null,
      hasHydrated: true,
    });

    // Force a persist write synchronously by reading what the middleware
    // wrote to localStorage after the setState above (zustand's persist
    // middleware writes on every set()).
    const raw = localStorage.getItem(REAL_ACCOUNT_STORE_NAME);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { state: Record<string, unknown> };
    expect(Object.keys(parsed.state)).toEqual(["account"]);
    expect(raw).not.toMatch(/private|seed|sessionKey|stamper|signingKey|subOrganization|walletId|credentialId|credentialPublicKey/i);
  });
});
