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

describe("Batch 2g boundary — Model B: child-stamped Turnkey mutations, server raw-forward only", () => {
  const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");
  const SERVER_MODULES = ["lib/real/server/backup-passkey-pipeline.ts", "lib/real/server/passkey-revocation.ts", "lib/real/server/turnkey-signed-request.ts"];
  const BROWSER_STAMPER = "lib/real/signing/authenticator-requests.ts";
  const CLIENT_STORE = "lib/stores/real-passkeys-store.ts";

  it("no source file anywhere dispatches createAuthenticators/deleteAuthenticators through a TurnkeyClient method", () => {
    const files = ["app", "components", "lib"].flatMap((dir) => listFilesRecursive(path.resolve(process.cwd(), dir))).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    const offenders = files.filter((file) => /\.(createAuthenticators|deleteAuthenticators)\s*\(/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the browser module only STAMPS (stampCreateAuthenticators / stampDeleteAuthenticators) and never fetches", () => {
    const source = read(BROWSER_STAMPER);
    expect(source).toMatch(/\.stampCreateAuthenticators\s*\(/);
    expect(source).toMatch(/\.stampDeleteAuthenticators\s*\(/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it("server modules never stamp, never hold the parent API key stamper, and never build a parent client themselves", () => {
    for (const file of SERVER_MODULES) {
      const source = read(file);
      expect(source).not.toMatch(/\.stamp(Create|Delete)Authenticators\s*\(/);
      expect(source).not.toMatch(/from\s+["']@turnkey\/api-key-stamper["']/);
      expect(source).not.toMatch(/\bcreateParentTurnkeyClient\b/);
    }
  });

  it("the forwarder raw-POSTs the exact body with fetch — never TurnkeyClient.request (which re-stringifies and re-stamps)", () => {
    const source = read("lib/real/server/turnkey-signed-request.ts");
    expect(source).toMatch(/body:\s*input\.body/);
    expect(source).not.toMatch(/\.request\s*\(/);
    expect(source).not.toMatch(/new\s+TurnkeyClient/);
  });

  it("backup-passkey client code never builds, prepares, or sends a UserOperation — enrollment and removal never move funds", () => {
    for (const file of [BROWSER_STAMPER, CLIENT_STORE, ...SERVER_MODULES]) {
      const source = read(file);
      expect(source).not.toMatch(/\bsendUserOperation\b/);
      expect(source).not.toMatch(/\bprepareUserOperation\b/);
    }
  });

  it("Real Pay and the backup-passkey slice don't import each other", () => {
    const paymentFiles = [...listFilesRecursive(path.resolve(process.cwd(), "lib/real/payments")), path.resolve(process.cwd(), "lib/real/server/payments.ts"), path.resolve(process.cwd(), "lib/stores/real-payment-store.ts")];
    for (const file of paymentFiles) {
      expect(readFileSync(file, "utf8")).not.toMatch(/backup-passkey|passkey-revocation|turnkey-signed-request|authenticator-requests/);
    }
    for (const file of [...SERVER_MODULES, BROWSER_STAMPER, CLIENT_STORE]) {
      expect(read(file)).not.toMatch(/from\s+["'][^"']*\/payments(\/|["'])/);
    }
  });

  it("no one-off tsx runner or esbuild build-script approval was left behind", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty("tsx");
    expect(Object.values(pkg.scripts ?? {}).join(" ")).not.toMatch(/\btsx\b/);
    expect(read("pnpm-workspace.yaml")).not.toMatch(/esbuild/);
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

  it("no payments route imports lib/real/server/pimlico.ts directly, or forwards a client-supplied JSON-RPC method/params — every route goes through a purpose-built server resolver module", () => {
    const routesDir = path.resolve(process.cwd(), "app/api/real/payments");
    const files = listFilesRecursive(routesDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/from\s+["']@\/lib\/real\/server\/pimlico["']/);
      // The Batch 2e history route is a deliberate exception: it goes
      // through the physically separate, read-only server/payment-history.ts
      // module instead of server/payments.ts (see the "history read path
      // never depends on the write/signing module graph" suite below) —
      // every other payments route still goes through server/payments.ts.
      const isHistoryRoute = file.includes(`${path.sep}history${path.sep}`);
      expect(source).toMatch(isHistoryRoute ? /from\s+["']@\/lib\/real\/server\/payment-history["']/ : /from\s+["']@\/lib\/real\/server\/payments["']/);
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

/**
 * Batch 2e boundary — the history read path never depends on the
 * write/signing module graph.
 *
 * These are direct source-text scans of the specific files listed below,
 * not a transitive dependency analyzer — they prove none of these four
 * files themselves reference a forbidden import/identifier, the same way
 * every other check in this file works. They don't prove nothing forbidden
 * could ever be reached indirectly through some future import chain; the
 * physical-separation design (a dedicated payment-history.ts that never
 * imports server/payments.ts) is what makes that structurally unlikely, not
 * this scan alone.
 */
describe("Batch 2e boundary — the history read path never depends on the write/signing module graph", () => {
  const HISTORY_MODULE = path.resolve(process.cwd(), "lib/real/server/payment-history.ts");
  const HISTORY_ROUTE = path.resolve(process.cwd(), "app/api/real/payments/history/route.ts");
  const HISTORY_STORE = path.resolve(process.cwd(), "lib/stores/real-payment-history-store.ts");
  const HISTORY_UI = path.resolve(process.cwd(), "components/real/real-payment-history.tsx");

  const FORBIDDEN_IMPORT_PATTERNS = [
    /from\s+["']\.{1,2}\/payments["']/, // relative "./payments" / "../payments"
    /from\s+["'].*\/server\/payments["']/, // any path ending in server/payments
    /from\s+["'].*\/lib\/real\/payments\//, // lib/real/payments/** (client-sign, submit, prepared-operation, transfer, hash, ...)
    /from\s+["'].*\/lib\/real\/signing\//, // lib/real/signing/**
    /from\s+["'].*\/server\/pimlico["']/,
    /from\s+["'].*\/submit["']/,
    /from\s+["'].*\/client-sign["']/,
    /from\s+["'].*\/reconcile["']/,
    /from\s+["']@turnkey\//,
  ];
  const FORBIDDEN_CALL_PATTERNS = [
    /\bsendUserOperation\b/,
    /\bprepareUserOperation\b/,
    /\bresolvePaymentStatus\b/,
    /\bresolveSubmitPayment\b/,
    /\bresolvePreparePayment\b/,
    /\bdispatchPreparedPayment\b/,
    /\bverifyPreparedPaymentSignature\b/,
  ];

  function assertClean(file: string) {
    const source = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN_IMPORT_PATTERNS) expect(source).not.toMatch(pattern);
    for (const pattern of FORBIDDEN_CALL_PATTERNS) expect(source).not.toMatch(pattern);
  }

  it("payment-history.ts never imports the write/signing modules or calls their functions", () => {
    assertClean(HISTORY_MODULE);
  });

  it("the history route imports only server/payment-history.ts, never server/payments.ts, and is itself clean", () => {
    const source = readFileSync(HISTORY_ROUTE, "utf8");
    expect(source).toMatch(/from\s+["']@\/lib\/real\/server\/payment-history["']/);
    expect(source).not.toMatch(/from\s+["']@\/lib\/real\/server\/payments["']/);
    assertClean(HISTORY_ROUTE);
  });

  // Path-shaped, not bare substrings: a bare /\/cancel/ or /\/status/ also
  // matches this very file's own explanatory prose (e.g. "never calls
  // /cancel or /status") — the same naive-substring lesson this file's
  // Turnkey-session checks already learned at the top of the file. These
  // require the actual /api/real/payments/... call shape real code uses
  // (a template literal like `/api/real/payments/${id}/cancel`), which no
  // comment happens to contain.
  const CANCEL_OR_STATUS_CALL_PATTERNS = [/\/api\/real\/payments\/[^"'`]*\/cancel/, /\/api\/real\/payments\/[^"'`]*\/status/];

  it("the history client store never calls /prepare, /submit, /cancel, or /status — only /history — stays unpersisted, and is itself clean", () => {
    const source = readFileSync(HISTORY_STORE, "utf8");
    expect(source).not.toMatch(/\/api\/real\/payments\/prepare/);
    expect(source).not.toMatch(/\/api\/real\/payments\/submit/);
    for (const pattern of CANCEL_OR_STATUS_CALL_PATTERNS) expect(source).not.toMatch(pattern);
    expect(source).not.toMatch(/persist\(/);
    expect(source).not.toMatch(/localStorage/);
    assertClean(HISTORY_STORE);
  });

  it("the history UI component never calls /prepare, /submit, /cancel, or /status, and is itself clean", () => {
    const source = readFileSync(HISTORY_UI, "utf8");
    expect(source).not.toMatch(/\/api\/real\/payments\/prepare/);
    expect(source).not.toMatch(/\/api\/real\/payments\/submit/);
    for (const pattern of CANCEL_OR_STATUS_CALL_PATTERNS) expect(source).not.toMatch(pattern);
    assertClean(HISTORY_UI);
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

describe("Slice S3 boundary — the blocked-removal operator resolver is unreachable at runtime and has no mutation path", () => {
  const ROOT = process.cwd();
  const RESOLVER_FILES = ["lib/real/server/passkey-revocation-resolver.ts", "lib/real/server/passkey-revocation-resolution-store.ts"];
  const RESOLVER_SPECIFIER = /["'][^"']*passkey-revocation-resol(ver|ution-store)["']/;
  const runtimeSources = ["app", "components", "lib", "simulation"]
    .flatMap((dir) => listFilesRecursive(path.join(ROOT, dir)))
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .map((file) => path.relative(ROOT, file))
    .filter((file) => !RESOLVER_FILES.includes(file));

  it.each(runtimeSources.map((file) => [file] as const))("%s never imports the operator resolver or its store", (file) => {
    expect(readFileSync(path.join(ROOT, file), "utf8")).not.toMatch(RESOLVER_SPECIFIER);
  });

  it("runtime.ts (the only place routes get stores from) is among the files checked and wires no resolution store", () => {
    expect(runtimeSources).toContain("lib/real/server/runtime.ts");
    const runtime = readFileSync(path.join(ROOT, "lib/real/server/runtime.ts"), "utf8");
    expect(runtime).not.toMatch(/Resolution|resolveBlockedRevocation|ReadOnlyTurnkeyLedger/);
  });

  it("the resolver's Turnkey port declares EXACTLY the four read-only queries", () => {
    const source = readFileSync(path.join(ROOT, RESOLVER_FILES[0]!), "utf8");
    const port = /export interface TurnkeyReadOnlyLedger \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
    const methods = [...port.matchAll(/^\s+(\w+)\(/gm)].map((m) => m[1]).sort();
    expect(methods).toEqual(["getActivities", "getActivity", "getAuthenticators", "getUsers"]);
  });

  it.each(RESOLVER_FILES.map((file) => [file] as const))("%s contains no forwarding, signing, or Turnkey mutation path", (file) => {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    for (const forbidden of [
      /\bforwardSignedRequest\b/,
      /\bturnkeyEndpointUrl\b/,
      /\bfetch\s*\(/,
      /\/public\/v1\/submit/,
      /\bcreateActivityPoller\b/,
      /\bstamp[A-Z]\w*\s*\(/,
      /\bsign[A-Z]\w*\s*\(/,
      /\bconfirmDeleted\s*\(/,
      /\bbeginDispatch\s*\(/,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
    // The only parent-client calls are the four reads.
    const clientCalls = [...source.matchAll(/\bclient\.(\w+)\s*\(/g)].map((m) => m[1]);
    expect(clientCalls.every((name) => ["getActivity", "getActivities", "getUsers", "getAuthenticators"].includes(name!))).toBe(true);
  });

  it("the resolution store never talks to Turnkey at all", () => {
    const store = readFileSync(path.join(ROOT, RESOLVER_FILES[1]!), "utf8");
    expect(store).not.toMatch(/@turnkey\/|turnkey-provisioning|turnkey-discovery|createParentTurnkeyClient/);
  });
});
