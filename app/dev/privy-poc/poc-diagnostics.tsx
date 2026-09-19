"use client";

/**
 * Privy PoC — inner diagnostics, rendered inside the vendor bridge provider.
 * DISPOSABLE. Consumes the vendor-neutral `PrivyPocAccount` facade; never
 * imports the Privy SDK directly.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createChainReader, formatEthForDisplay } from "@/lib/poc/privy/chain";
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_EXPLORER_URL,
  CIRCLE_FAUCET_URL,
  type PrivyPocConfig,
} from "@/lib/poc/privy/config";
import { isAddress, type AccountCodeStatus } from "@/lib/poc/privy/identifiers";
import { clearPendingSend, loadPendingSend, savePendingSend } from "@/lib/poc/privy/pending-send-storage";
import { usePrivyPocAccount } from "@/lib/poc/privy/privy-bridge";
import {
  applySendError,
  applySendResult,
  createPendingSendRecord,
  describeRecoveredRecord,
  reconcileWithReceipt,
  withStatus,
  type PendingSendRecord,
} from "@/lib/poc/privy/send-status";
import {
  captureStorageSnapshot,
  classifySnapshot,
  diffSnapshots,
  evaluateSecurityGate,
  type StorageSnapshot,
} from "@/lib/poc/privy/storage-audit";
import { formatUsdcAmount, parseUsdcAmount } from "@/lib/poc/privy/usdc-amount";
import {
  OWNERSHIP_FACTS,
  SDK_STATIC_FINDINGS,
  SDK_STATIC_SECURITY_RESULT,
  SELECTED_ARCHITECTURE,
} from "@/lib/poc/privy/sdk-static";
import { Actions, Flag, GateView, Row, Section, SnapshotView, Verdict } from "./poc-ui";

const DEFAULT_RECIPIENT = "0x000000000000000000000000000000000000dEaD";
const RECEIPT_POLL_INTERVAL_MS = 3000;
const RECEIPT_POLL_MAX_ATTEMPTS = 30; // ~90s; a timeout leaves the record "pending", never "failed".

type ChainFacts = {
  eth: bigint | null;
  usdc: bigint | null;
  code: AccountCodeStatus | null;
  error: string | null;
  updatedAtMs: number | null;
};

type Evidence = {
  ethBefore: bigint | null;
  codeBefore: AccountCodeStatus | null;
  ethAfter: bigint | null;
  codeAfter: AccountCodeStatus | null;
};

function describeCode(code: AccountCodeStatus | null): string {
  if (!code) return "unknown";
  switch (code.kind) {
    case "none":
      return "no code (plain EOA — not yet upgraded)";
    case "eip7702-delegation":
      return `EIP-7702 delegation → ${code.delegate}`;
    case "contract":
      return `contract code (${code.byteLength} bytes)`;
  }
}

export function PocDiagnostics({ config, beforeInit }: { config: PrivyPocConfig; beforeInit: StorageSnapshot }) {
  const account = usePrivyPocAccount();
  const reader = useMemo(() => createChainReader(config.rpcUrl), [config.rpcUrl]);
  const isLocalhost = typeof window !== "undefined" && window.location.origin.startsWith("http://localhost");

  // --- storage snapshots -------------------------------------------------
  const [snapshots, setSnapshots] = useState<StorageSnapshot[]>([beforeInit]);
  const capture = useCallback(async (label: string) => {
    const snap = await captureStorageSnapshot(label);
    setSnapshots((prev) => [...prev, snap]);
    return snap;
  }, []);
  const [manualLabel, setManualLabel] = useState("MANUAL");
  const capturedReady = useRef(false);
  const prevAuthenticated = useRef<boolean | null>(null);
  const capturedWallet = useRef(false);

  useEffect(() => {
    if (account.ready && !capturedReady.current) {
      capturedReady.current = true;
      void capture("AFTER INIT / RESTORE");
    }
  }, [account.ready, capture]);

  useEffect(() => {
    if (!account.ready) return;
    const prev = prevAuthenticated.current;
    prevAuthenticated.current = account.authenticated;
    if (prev === null) return; // first observation after init already captured above
    if (!prev && account.authenticated) void capture("AFTER SIGN UP / SIGN IN");
    if (prev && !account.authenticated) {
      capturedWallet.current = false;
      void capture("AFTER SIGN OUT");
    }
  }, [account.ready, account.authenticated, capture]);

  useEffect(() => {
    if (account.wallet && !capturedWallet.current) {
      capturedWallet.current = true;
      void capture("AFTER ACCOUNT READY");
    }
  }, [account.wallet, capture]);

  const latest = snapshots[snapshots.length - 1];
  const gate = evaluateSecurityGate(latest, { authenticated: account.authenticated, isLocalhost });
  const diff = snapshots.length >= 2 ? diffSnapshots(snapshots[snapshots.length - 2], latest) : null;

  // --- chain facts --------------------------------------------------------
  const [chain, setChain] = useState<ChainFacts>({ eth: null, usdc: null, code: null, error: null, updatedAtMs: null });
  const address = account.wallet?.address ?? null;

  const refresh = useCallback(
    async (what: "all" | "eth" | "usdc" | "code") => {
      if (!address) return;
      try {
        const [eth, usdc, code] = await Promise.all([
          what === "all" || what === "eth" ? reader.readEthBalance(address) : Promise.resolve(undefined),
          what === "all" || what === "usdc" ? reader.readUsdcBalance(address) : Promise.resolve(undefined),
          what === "all" || what === "code" ? reader.readAccountCode(address) : Promise.resolve(undefined),
        ]);
        setChain((prev) => ({
          eth: eth ?? prev.eth,
          usdc: usdc ?? prev.usdc,
          code: code ?? prev.code,
          error: null,
          updatedAtMs: Date.now(),
        }));
      } catch (error) {
        setChain((prev) => ({ ...prev, error: error instanceof Error ? error.message : String(error) }));
      }
    },
    [address, reader],
  );

  useEffect(() => {
    if (address) void refresh("all");
  }, [address, refresh]);

  // --- pending send record + recovery -------------------------------------
  const [record, setRecord] = useState<PendingSendRecord | null>(null);
  const [recoveredNote, setRecoveredNote] = useState<string | null>(null);
  useEffect(() => {
    const existing = loadPendingSend();
    if (existing) {
      setRecord(existing);
      setRecoveredNote(describeRecoveredRecord(existing));
    }
  }, []);

  const persist = useCallback((next: PendingSendRecord) => {
    setRecord(next);
    savePendingSend(next);
    return next;
  }, []);

  const reconcileOnce = useCallback(
    async (current: PendingSendRecord) => {
      if (!current.transactionHash) return persist(reconcileWithReceipt(current, { kind: "not-found" }, Date.now()));
      const lookup = await reader.lookupReceipt(current.transactionHash);
      return persist(reconcileWithReceipt(current, lookup, Date.now()));
    },
    [persist, reader],
  );

  // --- send -----------------------------------------------------------------
  const [to, setTo] = useState(DEFAULT_RECIPIENT);
  const [amount, setAmount] = useState("0.10");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Evidence>({ ethBefore: null, codeBefore: null, ethAfter: null, codeAfter: null });

  const send = useCallback(async () => {
    setSendError(null);
    if (!address) return setSendError("No embedded account yet.");
    if (!isAddress(to)) return setSendError("Recipient is not a valid 0x address.");
    const parsed = parseUsdcAmount(amount);
    if (!parsed.ok) return setSendError(parsed.error);
    if (record && (record.status === "pending" || record.status === "submitted" || record.status === "unknown" || record.status === "awaiting-user" || record.status === "preparing")) {
      return setSendError("A previous send is unresolved. Reconcile or clear it first — never send again on an uncertain outcome.");
    }

    setSending(true);
    try {
      const [ethBefore, codeBefore] = await Promise.all([reader.readEthBalance(address), reader.readAccountCode(address)]);
      setEvidence({ ethBefore, codeBefore, ethAfter: null, codeAfter: null });

      let current = persist(
        createPendingSendRecord({
          clientRequestId: crypto.randomUUID(),
          chainId: BASE_SEPOLIA_CHAIN_ID,
          from: address,
          to: to as `0x${string}`,
          amountBaseUnits: parsed.baseUnits,
          nowMs: Date.now(),
        }),
      );
      current = persist(withStatus(current, "awaiting-user", Date.now()));

      let rawHash: string;
      try {
        rawHash = await account.actions.sendSponsoredUsdc(to as `0x${string}`, parsed.baseUnits);
      } catch (error) {
        persist(applySendError(current, error instanceof Error ? error.message : String(error), Date.now()));
        return;
      }
      current = persist(applySendResult(current, rawHash, Date.now()));
      void capture("AFTER SEND SUBMITTED");

      if (current.transactionHash) {
        for (let attempt = 0; attempt < RECEIPT_POLL_MAX_ATTEMPTS; attempt += 1) {
          current = await reconcileOnce(current);
          if (current.status === "confirmed" || current.status === "failed") break;
          await new Promise((r) => setTimeout(r, RECEIPT_POLL_INTERVAL_MS));
        }
      }

      const [ethAfter, codeAfter] = await Promise.all([reader.readEthBalance(address), reader.readAccountCode(address)]);
      setEvidence((prev) => ({ ...prev, ethAfter, codeAfter }));
      await refresh("all");
    } finally {
      setSending(false);
    }
  }, [account.actions, address, amount, capture, persist, reader, reconcileOnce, record, refresh, to]);

  // --- restore probe --------------------------------------------------------
  const [restoreResult, setRestoreResult] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  return (
    <>
      <Section title="Static SDK security (installed source, no network)">
        <div className="flex items-center gap-2 text-sm">
          <span>SDK static verdict:</span>
          <Verdict result={SDK_STATIC_SECURITY_RESULT} />
        </div>
        <Row label="Selected architecture" value={SELECTED_ARCHITECTURE} />
        <ul className="space-y-1">
          {SDK_STATIC_FINDINGS.map((f) => (
            <li key={f.id} className="text-xs flex gap-2">
              <span
                className={
                  f.result === "FAIL" ? "text-red-400" : f.result === "BLOCKED" ? "text-amber-400" : "text-emerald-400"
                }
              >
                {f.result}
              </span>
              <span className="break-words">{f.claim}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          A live snapshot cannot override this: the installed SDK always writes session tokens to localStorage when the
          API returns them. HttpOnly cookies on a verified domain only skip the JS cookie mirror.
        </p>
      </Section>

      <Section title="Privy state">
        <Row label="SDK ready" value={<Flag value={account.ready} />} />
        <Row label="Authenticated" value={<Flag value={account.authenticated} />} />
        <Row label="User id" value={account.userId ?? "—"} mono />
        <Row label="User created" value={account.createdAtMs ? new Date(account.createdAtMs).toISOString() : "—"} />
        <Row label="Linked account types" value={account.linkedAccountTypes.join(", ") || "—"} />
        <Row label="Passkeys linked" value={account.passkeyCount} />
        <Row
          label="Last login"
          value={
            account.lastLogin
              ? `${account.lastLogin.wasAlreadyAuthenticated ? "restored existing session" : account.lastLogin.isNewUser ? "NEW user" : "EXISTING user"} · method: ${account.lastLogin.loginMethod ?? "unknown"}`
              : account.authenticated
                ? "session restored on init (no login event this page load)"
                : "—"
          }
        />
        <Row label="Passkey flow" value={account.passkeyFlow} />
        {account.lastError && <Row label="Last error" value={<span className="text-red-400">{account.lastError}</span>} />}
        <Actions>
          <Button size="sm" disabled={!account.ready || account.authenticated} onClick={() => void account.actions.signupWithPasskey().catch(() => undefined)}>
            Sign up with passkey
          </Button>
          <Button size="sm" variant="outline" disabled={!account.ready || account.authenticated} onClick={() => void account.actions.loginWithPasskey().catch(() => undefined)}>
            Sign in with passkey
          </Button>
          <Button size="sm" variant="outline" disabled={!account.ready || account.authenticated} onClick={() => account.actions.openLoginModal()}>
            Privy login modal (passkey/email)
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!account.ready}
            onClick={() =>
              void account.actions
                .restoreSession()
                .then((ok) => setRestoreResult(ok ? "access token present after refresh (value not shown)" : "no access token"))
                .catch(() => setRestoreResult("restore failed"))
            }
          >
            Restore session
          </Button>
          <Button size="sm" variant="destructive" disabled={!account.authenticated} onClick={() => void account.actions.logout().catch(() => undefined)}>
            Sign out
          </Button>
        </Actions>
        {restoreResult && <Row label="Restore probe" value={restoreResult} />}
      </Section>

      <Section title="Account">
        {account.wallet ? (
          <>
            <Row label="Privy wallet id" value={account.wallet.walletId ?? "(null — not a TEE/delegable wallet)"} mono />
            <Row label="Account address" value={account.wallet.address} mono />
            <Row
              label="Smart-account address"
              value={
                <>
                  <span className="font-mono">{account.wallet.address}</span>
                  <span className="text-muted-foreground"> — same address: native sponsorship upgrades this EOA in place via EIP-7702</span>
                </>
              }
            />
            <Row label="Execution environment" value={`${account.wallet.execution} (recoveryMethod: ${account.wallet.recoveryMethod ?? "—"})`} />
            <Row label="HD index / delegated / imported" value={`${account.wallet.walletIndex ?? "—"} / ${String(account.wallet.delegated)} / ${String(account.wallet.imported)}`} />
          </>
        ) : (
          <div className="text-sm text-muted-foreground">
            {account.authenticated ? "Authenticated but no embedded Ethereum wallet yet." : "Sign in to see the account."}
          </div>
        )}
        <Actions>
          <Button size="sm" variant="outline" disabled={!account.authenticated || !!account.wallet} onClick={() => void account.actions.createWallet().catch(() => undefined)}>
            Create embedded wallet
          </Button>
          <Button size="sm" variant="outline" disabled={!address} onClick={() => void refresh("all")}>
            Refresh account
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!address}
            onClick={() => {
              if (!address) return;
              void navigator.clipboard.writeText(address).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "Copied" : "Copy account address"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.open(CIRCLE_FAUCET_URL, "_blank", "noopener")}>
            Open Circle faucet
          </Button>
          <Button size="sm" variant="outline" disabled={!address} onClick={() => window.open(`${BASE_SEPOLIA_EXPLORER_URL}/address/${address}`, "_blank", "noopener")}>
            Open in explorer
          </Button>
        </Actions>
      </Section>

      <Section title="Base Sepolia reads (independent of Privy)">
        <Row label="Chain id" value={reader.chainId} />
        <Row label="ETH balance" value={chain.eth === null ? "—" : `${formatEthForDisplay(chain.eth)} ETH${chain.eth === BigInt(0) ? " (zero — as required)" : ""}`} />
        <Row label="Cash (USDC) balance" value={chain.usdc === null ? "—" : `${formatUsdcAmount(chain.usdc)} USDC`} />
        <Row label="Account code" value={describeCode(chain.code)} />
        <Row label="Last read" value={chain.updatedAtMs ? new Date(chain.updatedAtMs).toLocaleTimeString() : "—"} />
        {chain.error && <Row label="Read error" value={<span className="text-red-400">{chain.error}</span>} />}
        <Actions>
          <Button size="sm" variant="outline" disabled={!address} onClick={() => void refresh("eth")}>
            Refresh ETH
          </Button>
          <Button size="sm" variant="outline" disabled={!address} onClick={() => void refresh("usdc")}>
            Refresh Cash
          </Button>
          <Button size="sm" variant="outline" disabled={!address} onClick={() => void refresh("code")}>
            Refresh code status
          </Button>
        </Actions>
      </Section>

      <Section title="Account ownership (configuration, not marketing)">
        {OWNERSHIP_FACTS.map((f) => (
          <Row key={f.question} label={f.question} value={f.answer} />
        ))}
      </Section>

      <Section title="Sponsorship">
        <Row label="Path" value="Privy native gas sponsorship — sendTransaction(…, { sponsor: true }); app pays; EIP-7702 upgrade on first use" />
        <Row label="Client-side secrets required" value="none (no paymaster/bundler URL or key in the browser)" />
        <Row label="Requires TEE wallet" value={<Flag value={account.wallet ? account.wallet.execution === "tee" : null} />} />
        <Row
          label="Dashboard state"
          value="not readable from the client — a sponsored send failing with a sponsorship error is the signal that Fee sponsorship / Base Sepolia / client-initiated sponsorship is not enabled"
        />
      </Section>

      <Section title="Send test Cash (sponsored)">
        <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Recipient 0x…" className="font-mono text-xs" />
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.10" className="font-mono text-xs" />
        </div>
        <Actions>
          <Button size="sm" disabled={!address || sending} onClick={() => void send()}>
            {sending ? "Sending…" : "Send test Cash"}
          </Button>
          <Button size="sm" variant="outline" disabled={!record || sending} onClick={() => record && void reconcileOnce(record)}>
            Check transaction status
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!record || sending}
            onClick={() => {
              clearPendingSend();
              setRecord(null);
              setRecoveredNote(null);
            }}
          >
            Clear record
          </Button>
        </Actions>
        {sendError && <div className="text-sm text-red-400">{sendError}</div>}
        {recoveredNote && <div className="text-sm text-amber-400">Recovered after reload: {recoveredNote}</div>}
        {record && (
          <div className="space-y-1">
            <Row label="Status" value={<span className="font-semibold">{record.status}</span>} />
            <Row label="Client request id" value={record.clientRequestId} mono />
            <Row label="Amount" value={`${formatUsdcAmount(BigInt(record.amountBaseUnits))} USDC → ${record.to}`} mono />
            <Row label="User-operation hash" value="not surfaced by @privy-io/react-auth 3.44.0 useSendTransaction (returns { hash } only)" />
            <Row
              label="Transaction hash"
              value={
                record.transactionHash ? (
                  <a className="underline" href={`${BASE_SEPOLIA_EXPLORER_URL}/tx/${record.transactionHash}`} target="_blank" rel="noopener noreferrer">
                    {record.transactionHash}
                  </a>
                ) : (
                  "none recorded"
                )
              }
              mono
            />
            <Row
              label="Receipt"
              value={
                record.receipt
                  ? `${record.receipt.status} · block ${record.receipt.blockNumber} · paid by ${record.receipt.from ?? "?"}${
                      record.receipt.from && address && record.receipt.from.toLowerCase() === address.toLowerCase()
                        ? " (the ACCOUNT paid — NOT sponsored)"
                        : record.receipt.from
                          ? " (not the account — consistent with a bundler-paid user operation)"
                          : ""
                    }`
                  : "—"
              }
            />
            {record.note && <Row label="Note" value={record.note} />}
          </div>
        )}
        <div className="rounded border border-border/60 p-3 text-xs space-y-1">
          <div className="font-semibold">Zero-ETH evidence</div>
          <Row label="ETH before send" value={evidence.ethBefore === null ? "—" : `${formatEthForDisplay(evidence.ethBefore)} ETH`} />
          <Row label="Code before send" value={describeCode(evidence.codeBefore)} />
          <Row label="ETH after" value={evidence.ethAfter === null ? "—" : `${formatEthForDisplay(evidence.ethAfter)} ETH`} />
          <Row label="Code after" value={describeCode(evidence.codeAfter)} />
          <Row
            label="Deployment / upgrade"
            value={
              evidence.codeBefore && evidence.codeAfter
                ? evidence.codeBefore.kind === "none" && evidence.codeAfter.kind !== "none"
                  ? "account was upgraded during this send (sponsored, since ETH stayed as shown)"
                  : evidence.codeBefore.kind !== "none"
                    ? "account already had code before this send"
                    : "no code change observed"
                : "—"
            }
          />
        </div>
      </Section>

      <Section title="Storage audit (key names only)">
        <GateView gate={gate} />
        {diff && (diff.added.length > 0 || diff.removed.length > 0) && (
          <div className="text-xs space-y-1">
            <div className="text-muted-foreground">Change since previous snapshot:</div>
            {diff.added.map((d) => (
              <div key={`+${d.area}:${d.key}`} className="font-mono text-emerald-400">
                + {d.area}: {d.key}
              </div>
            ))}
            {diff.removed.map((d) => (
              <div key={`-${d.area}:${d.key}`} className="font-mono text-red-400">
                − {d.area}: {d.key}
              </div>
            ))}
          </div>
        )}
        <Actions>
          <Input value={manualLabel} onChange={(e) => setManualLabel(e.target.value)} className="w-56 text-xs" />
          <Button size="sm" variant="outline" onClick={() => void capture(manualLabel || "MANUAL")}>
            Capture storage snapshot
          </Button>
        </Actions>
        <div className="space-y-2">
          {[...snapshots].reverse().map((s) => (
            <SnapshotView key={`${s.label}-${s.capturedAtMs}`} snapshot={s} classifications={classifySnapshot(s)} />
          ))}
        </div>
      </Section>

      <Section title="Dashboard setup still required (not done by this repo)">
        <ol className="list-decimal pl-5 text-sm space-y-1">
          <li>Create a Privy <b>Development</b> app (never a production app ID on localhost).</li>
          <li>Allowed origins: add <code>http://localhost:3000</code> (or whatever port <code>next dev</code> uses).</li>
          <li>Login methods: enable <b>Passkey</b> and <b>Email</b> (email is the fallback if passkey is unavailable).</li>
          <li>Embedded wallets: Ethereum on, TEE execution (Wallet → Advanced should not say On-device). Create-on-login can stay dashboard-default; this PoC also requests <code>users-without-wallets</code>.</li>
          <li>
            Fee sponsorship: enable <b>Sponsor gas fees</b>, add <b>Base Sepolia</b>, enable <b>Allow transactions from the
            client</b>. Prepaid testnet credits may be required. No paymaster key belongs in this repo.
          </li>
          <li>
            HttpOnly cookies: do <b>not</b> enable on the development app for localhost. Docs: production App IDs with
            verified DNS set server HttpOnly cookies; development App IDs set JS-readable cookies from the client.
            A production-domain test is a separate step.
          </li>
          <li>
            Copy the public App ID into <code>.env.local</code> as <code>NEXT_PUBLIC_PRIVY_APP_ID</code> and set{" "}
            <code>NEXT_PUBLIC_PRIVY_POC_ENABLED=true</code>. Restart <code>next dev</code>.
          </li>
        </ol>
      </Section>

      <Section title="Manual DevTools checklist (what JavaScript cannot verify)">
        <ol className="list-decimal pl-5 text-sm space-y-1">
          <li>
            Application → Cookies → this origin: for each <code>privy-*</code> cookie record <b>HttpOnly</b>, <b>Secure</b>,{" "}
            <b>SameSite</b>, <b>Domain</b>, <b>Path</b>, <b>Expires</b>. A cookie listed in the snapshot above is by definition
            NOT HttpOnly.
          </li>
          <li>
            Application → Local Storage → this origin: confirm which <code>privy:*</code> keys hold JWT-shaped values (three
            base64url segments) versus the placeholder string <code>&quot;deprecated&quot;</code>. Do not paste values anywhere.
          </li>
          <li>
            Application → Local Storage / IndexedDB → the Privy iframe origin (auth.privy.io or your <code>privy.</code>{" "}
            subdomain): note database/key names. Key shares for on-device wallets live there; TEE wallets should show none.
          </li>
          <li>Network → filter <code>privy</code>: on login/refresh responses, check whether <code>Set-Cookie</code> headers are present (server-set cookies) or absent (client-set).</li>
          <li>Repeat the storage capture after: full browser quit/restart; in Safari; with third-party cookies blocked.</li>
          <li>
            After a sponsored send: explorer receipt <code>from</code> should be a bundler/paymaster, not the account. ETH
            balance should remain 0. Account code should move from none → EIP-7702 delegation on first send.
          </li>
        </ol>
      </Section>
    </>
  );
}
