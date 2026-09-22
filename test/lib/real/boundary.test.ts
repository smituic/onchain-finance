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

describe("Pimlico access — no generic proxy, key stays server-only", () => {
  it("PIMLICO_API_KEY / pimlicoApiKey is referenced only under lib/real/server/** and the payment route handlers that pass it through", () => {
    const projectRoot = process.cwd();
    const scanDirs = ["app", "components", "lib"].map((dir) => path.join(projectRoot, dir));
    const offenders: string[] = [];
    for (const dir of scanDirs) {
      const files = listFilesRecursive(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
      for (const file of files) {
        if (file.includes(`${path.sep}lib${path.sep}real${path.sep}server${path.sep}`)) continue;
        if (file.includes(`${path.sep}app${path.sep}api${path.sep}real${path.sep}payments${path.sep}`)) continue;
        const source = readFileSync(file, "utf8");
        if (/PIMLICO_API_KEY|pimlicoApiKey/.test(source)) offenders.push(path.relative(projectRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only lib/real/server/pimlico.ts ever builds a Pimlico URL", () => {
    const projectRoot = process.cwd();
    const files = [
      ...listFilesRecursive(path.join(projectRoot, "app")),
      ...listFilesRecursive(path.join(projectRoot, "lib")),
      ...listFilesRecursive(path.join(projectRoot, "components")),
    ].filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

    const offenders = files.filter((file) => {
      if (file.endsWith(`${path.sep}lib${path.sep}real${path.sep}server${path.sep}pimlico.ts`)) return false;
      return /api\.pimlico\.io/.test(readFileSync(file, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  it("no payments route imports lib/real/server/pimlico.ts directly, or forwards a client-supplied JSON-RPC method/params — every route goes through the purpose-built server/payments.ts resolvers", () => {
    const routesDir = path.resolve(process.cwd(), "app/api/real/payments");
    const files = listFilesRecursive(routesDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/from\s+["']@\/lib\/real\/server\/pimlico["']/);
      expect(source).toMatch(/from\s+["']@\/lib\/real\/server\/payments["']/);
    }
  });
});

describe("Payment records never hold signing material", () => {
  it("schema.sql's payment_attempts table has no signature column", () => {
    const source = readFileSync(path.resolve(process.cwd(), "lib/real/server/schema.sql"), "utf8");
    const tableStart = source.indexOf("CREATE TABLE IF NOT EXISTS payment_attempts");
    const tableEnd = source.indexOf(");", tableStart);
    expect(tableStart).toBeGreaterThan(-1);
    const tableBody = source.slice(tableStart, tableEnd);
    expect(tableBody).not.toMatch(/\bsignature\b/i);
  });

  it("the PaymentAttempt type and its Neon/in-memory adapters never persist a signature field", () => {
    for (const file of ["lib/real/server/payment-attempts.ts", "lib/real/server/neon-store.ts"]) {
      const source = readFileSync(path.resolve(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/\bsignature\s*:/i);
      expect(source).not.toMatch(/\bsignature\s+TEXT/i);
    }
  });

  it("the real-payment-store client store is entirely unpersisted — no zustand persist middleware, no localStorage", () => {
    const source = readFileSync(path.resolve(process.cwd(), "lib/stores/real-payment-store.ts"), "utf8");
    expect(source).not.toMatch(/zustand\/middleware/);
    expect(source).not.toMatch(/\bpersist\(/);
    expect(source).not.toMatch(/localStorage/);
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
