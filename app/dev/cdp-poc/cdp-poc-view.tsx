"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BASE_SEPOLIA_CHAIN_ID,
  CIRCLE_FAUCET_URL,
  CONSUMER_LABEL,
  USDC_ADDRESS,
  USDC_DECIMALS,
  USDC_SYMBOL,
  explorerAddressUrl,
  explorerTxUrl,
} from "@/lib/poc/cdp/constants";
import {
  completeEmailSignIn,
  ensureSmartAccount,
  fetchUserOperation,
  getRestoredSession,
  initializeCdp,
  readProjectConfig,
  refreshUserSummary,
  sendUsdcTransfer,
  signOutCdp,
  startEmailSignIn,
  subscribeAuthState,
  type ProjectConfigSummary,
  type SendUsdcResult,
  type UserSummary,
} from "@/lib/poc/cdp/cdp-client";
import { readAccountChainState, readTransactionReceipt, type AccountChainState, type ChainReceiptSummary } from "@/lib/poc/cdp/chain";
import { formatEth, formatUsdcAmount, parseUsdcAmount } from "@/lib/poc/cdp/usdc-amount";
import { isTerminalPhase, type NormalizedUserOperation } from "@/lib/poc/cdp/user-operation-status";
import {
  CDP_KNOWN_STORAGE_KEYS,
  browserStorageSources,
  diffKeys,
  evaluateStorageGate,
  takeStorageSnapshot,
  type StorageSnapshot,
} from "@/lib/poc/cdp/storage-audit";

/**
 * Developer diagnostic page for the CDP PoC. Every readout is public/debug
 * information (addresses, hashes, statuses, storage KEY names). Nothing here
 * ever reads or renders a token, key, or stored value.
 */

type Props = { projectId: string | null; rpcUrl: string | null; problems: string[] };

type Level = "info" | "ok" | "warn" | "fail";
type LogEntry = { at: string; level: Level; text: string; detail?: unknown };

/** Public address remembered across reloads purely to compare before/after. Not a credential. */
const LAST_ADDRESS_KEY = "onchain-finance:cdp-poc:last-smart-account";

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_MS = 3 * 60 * 1000;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v)));
}

export function CdpPocView({ projectId, rpcUrl, problems }: Props) {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [sdkState, setSdkState] = useState<"idle" | "initializing" | "ready" | "error">("idle");
  const [busy, setBusy] = useState<string | null>(null);

  const [user, setUser] = useState<UserSummary | null>(null);
  const [sessionOrigin, setSessionOrigin] = useState<"none" | "fresh-sign-in" | "restored">("none");
  const [restoreReport, setRestoreReport] = useState<{ signedIn: boolean; addressBefore: string | null; addressAfter: string | null } | null>(null);
  const [signingVerifiedThisLoad, setSigningVerifiedThisLoad] = useState(false);
  const [smartAccountCreatedHere, setSmartAccountCreatedHere] = useState<boolean | null>(null);
  const [projectConfig, setProjectConfig] = useState<ProjectConfigSummary | null>(null);

  const [email, setEmail] = useState("");
  const [flowId, setFlowId] = useState<string | null>(null);
  const [otp, setOtp] = useState("");

  const [chainState, setChainState] = useState<AccountChainState | null>(null);
  const [chainStateAt, setChainStateAt] = useState<string | null>(null);

  const [snapshots, setSnapshots] = useState<StorageSnapshot[]>([]);

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("0.10");
  const [useCdpPaymaster, setUseCdpPaymaster] = useState(true);
  const [ethBeforeSend, setEthBeforeSend] = useState<bigint | null>(null);
  const [deployedBeforeSend, setDeployedBeforeSend] = useState<boolean | null>(null);
  const [sendResult, setSendResult] = useState<SendUsdcResult | null>(null);
  const [userOp, setUserOp] = useState<NormalizedUserOperation | null>(null);
  const [userOpRaw, setUserOpRaw] = useState<unknown>(null);
  const [chainReceipt, setChainReceipt] = useState<ChainReceiptSummary | null>(null);
  const [polling, setPolling] = useState(false);
  const pollAbort = useRef<{ cancelled: boolean } | null>(null);
  // Dev-mode React Strict Mode runs effects twice; the SDK boot (and its
  // storage snapshots) must happen exactly once per page load.
  const booted = useRef(false);

  const smartAccount = user?.smartAccounts[0]?.address ?? null;

  const addLog = useCallback((level: Level, text: string, detail?: unknown) => {
    setLog((prev) => [...prev, { at: new Date().toISOString(), level, text, detail: detail === undefined ? undefined : jsonSafe(detail) }]);
  }, []);

  const snapshot = useCallback(
    async (label: string) => {
      const snap = await takeStorageSnapshot(label, browserStorageSources());
      setSnapshots((prev) => [...prev, snap]);
      const gate = evaluateStorageGate(snap);
      addLog(gate.verdict === "pass" ? "ok" : "fail", `Storage snapshot "${label}": gate ${gate.verdict.toUpperCase()}`, {
        localStorageKeys: snap.localStorageKeys,
        sessionStorageKeys: snap.sessionStorageKeys,
        indexedDbNames: snap.indexedDbNames,
        cookieNames: snap.cookieNames,
        sensitiveKeysFound: gate.sensitiveKeysFound,
      });
      return snap;
    },
    [addLog],
  );

  const refreshChain = useCallback(
    async (address: string | null = smartAccount) => {
      if (!address) return null;
      setBusy("chain");
      try {
        const state = await readAccountChainState(address as `0x${string}`, rpcUrl);
        setChainState(state);
        setChainStateAt(new Date().toISOString());
        if (state.rpcChainId !== BASE_SEPOLIA_CHAIN_ID) {
          addLog("fail", `RPC reports chain id ${state.rpcChainId}, expected ${BASE_SEPOLIA_CHAIN_ID}. Wrong network.`);
        }
        addLog("info", "Read chain state", {
          address,
          rpcChainId: state.rpcChainId,
          eth: formatEth(state.ethWei),
          usdc: formatUsdcAmount(state.usdcBaseUnits),
          isDeployed: state.isDeployed,
          blockNumber: state.blockNumber,
        });
        return state;
      } catch (error) {
        addLog("fail", `Chain read failed: ${errorMessage(error)}`);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [smartAccount, rpcUrl, addLog],
  );

  // Boot: snapshot storage before the SDK touches it, initialize, then see
  // what the SDK restored on its own from the refresh credential.
  useEffect(() => {
    if (!projectId || problems.length > 0 || booted.current) return;
    booted.current = true;
    (async () => {
      await snapshot("1. before SDK initialize (page load)");
      setSdkState("initializing");
      const addressBefore = window.localStorage.getItem(LAST_ADDRESS_KEY);
      try {
        await initializeCdp(projectId);
        setSdkState("ready");
        addLog("ok", "SDK initialized", { projectId, createOnLogin: "smart", disableAnalytics: true });

        subscribeAuthState((u) => {
          setUser(u);
          addLog("info", u ? "onAuthStateChange: signed in" : "onAuthStateChange: signed out", u ? { userId: u.userId, smartAccounts: u.smartAccounts.map((s) => s.address) } : undefined);
        });

        const restored = await getRestoredSession();
        const addressAfter = restored.user?.smartAccounts[0]?.address ?? null;
        setRestoreReport({ signedIn: restored.signedIn, addressBefore, addressAfter });
        if (restored.signedIn && restored.user) {
          setUser(restored.user);
          setSessionOrigin("restored");
          addLog(
            addressBefore && addressAfter && addressBefore.toLowerCase() === addressAfter.toLowerCase() ? "ok" : addressBefore ? "fail" : "info",
            `Session restored by SDK. Smart account before reload: ${addressBefore ?? "(none remembered)"}; after: ${addressAfter ?? "(none)"}`,
          );
        } else {
          addLog("info", `No session restored${addressBefore ? ` (previously saw smart account ${addressBefore})` : ""}`);
        }
        await snapshot("2. after SDK initialize / restore attempt");

        try {
          const cfg = await readProjectConfig();
          setProjectConfig(cfg);
          addLog(cfg.activeCookieDomain ? "ok" : "warn", cfg.activeCookieDomain ? `Project has an active first-party cookie domain: ${cfg.activeCookieDomain}` : "Project has NO active first-party cookie domain (auth cookies are third-party to this origin)", cfg.raw);
        } catch (error) {
          addLog("warn", `Could not read project config: ${errorMessage(error)}`);
        }
      } catch (error) {
        setSdkState("error");
        addLog("fail", `SDK initialize failed: ${errorMessage(error)}`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once per page load
  }, [projectId]);

  // Remember the current smart-account address (public) for the before/after reload comparison.
  useEffect(() => {
    if (smartAccount) window.localStorage.setItem(LAST_ADDRESS_KEY, smartAccount);
  }, [smartAccount]);

  const onStartSignIn = async () => {
    setBusy("sign-in");
    try {
      const result = await startEmailSignIn(email.trim());
      setFlowId(result.flowId);
      addLog("ok", `OTP requested. flowId received (${result.flowId.length} chars). ${result.message}`);
    } catch (error) {
      addLog("fail", `signInWithEmail failed: ${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const onVerifyOtp = async () => {
    if (!flowId) return;
    setBusy("verify");
    try {
      const summary = await completeEmailSignIn(flowId, otp.trim());
      setUser(summary);
      setSessionOrigin("fresh-sign-in");
      setFlowId(null);
      setOtp("");
      addLog("ok", `Signed in. isNewUser=${summary.isNewUser}`, {
        userId: summary.userId,
        eoaAddresses: summary.eoaAddresses,
        smartAccounts: summary.smartAccounts,
      });
      let address = summary.smartAccounts[0]?.address ?? null;
      if (!address) {
        const ensured = await ensureSmartAccount();
        address = ensured.address;
        setSmartAccountCreatedHere(ensured.created);
        addLog(ensured.created ? "warn" : "info", ensured.created ? `Smart account was NOT auto-created on login; created one now: ${address}` : `Smart account present: ${address}`);
        setUser(await refreshUserSummary());
      } else {
        setSmartAccountCreatedHere(false);
      }
      await snapshot("3. after sign-in");
      await refreshChain(address);
    } catch (error) {
      addLog("fail", `verifyEmailOTP failed: ${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const onRestoreSession = async () => {
    setBusy("restore");
    try {
      const restored = await getRestoredSession();
      setUser(restored.user);
      const addressAfter = restored.user?.smartAccounts[0]?.address ?? null;
      setRestoreReport((prev) => ({ signedIn: restored.signedIn, addressBefore: prev?.addressBefore ?? window.localStorage.getItem(LAST_ADDRESS_KEY), addressAfter }));
      addLog(restored.signedIn ? "ok" : "warn", `isSignedIn=${restored.signedIn}; getCurrentUser smart account: ${addressAfter ?? "(none)"}`);
    } catch (error) {
      addLog("fail", `Restore check failed: ${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const onSignOut = async () => {
    setBusy("sign-out");
    try {
      await signOutCdp();
      setUser(null);
      setSessionOrigin("none");
      setSigningVerifiedThisLoad(false);
      addLog("ok", "Signed out");
      await snapshot("4. after sign-out");
    } catch (error) {
      addLog("fail", `signOut failed: ${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const onRefreshAccount = async () => {
    setBusy("account");
    try {
      const summary = await refreshUserSummary();
      setUser(summary);
      addLog("info", "getCurrentUser", summary ? { userId: summary.userId, eoaAddresses: summary.eoaAddresses, smartAccounts: summary.smartAccounts } : null);
    } catch (error) {
      addLog("fail", `getCurrentUser failed: ${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const onCopyAddress = async () => {
    if (!smartAccount) return;
    await navigator.clipboard.writeText(smartAccount);
    addLog("info", "Copied smart-account address to clipboard");
  };

  const stopPolling = () => {
    if (pollAbort.current) pollAbort.current.cancelled = true;
    setPolling(false);
  };

  const reconcile = useCallback(
    async (hash: `0x${string}`, account: `0x${string}`) => {
      const { normalized, raw } = await fetchUserOperation(hash, account);
      setUserOp(normalized);
      setUserOpRaw(raw);
      if (normalized.transactionHash) {
        const receipt = await readTransactionReceipt(normalized.transactionHash as `0x${string}`, rpcUrl);
        setChainReceipt(receipt);
        return { normalized, receipt };
      }
      return { normalized, receipt: null };
    },
    [rpcUrl],
  );

  const onCheckStatus = async () => {
    if (!sendResult || !smartAccount) return;
    setBusy("status");
    try {
      const { normalized, receipt } = await reconcile(sendResult.userOperationHash, smartAccount as `0x${string}`);
      addLog("info", `getUserOperation: status=${normalized.sdkStatus} phase=${normalized.phase}`, { normalized, chainReceipt: receipt });
    } catch (error) {
      addLog("fail", `Status check failed: ${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const onSend = async () => {
    if (!smartAccount) return;
    const amountBaseUnits = parseUsdcAmount(amount);
    if (amountBaseUnits === null || amountBaseUnits <= BigInt(0)) {
      addLog("warn", `Invalid amount "${amount}" (max ${USDC_DECIMALS} decimals, > 0)`);
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(to.trim())) {
      addLog("warn", "Recipient must be a 0x address (40 hex chars)");
      return;
    }
    setBusy("send");
    setSendResult(null);
    setUserOp(null);
    setUserOpRaw(null);
    setChainReceipt(null);
    try {
      const before = await readAccountChainState(smartAccount as `0x${string}`, rpcUrl);
      setChainState(before);
      setEthBeforeSend(before.ethWei);
      setDeployedBeforeSend(before.isDeployed);
      addLog(before.ethWei === BigInt(0) ? "ok" : "warn", `Pre-send: ETH=${formatEth(before.ethWei)} (${before.ethWei === BigInt(0) ? "ZERO — a true gasless test" : "non-zero — NOT a zero-ETH test"}), USDC=${formatUsdcAmount(before.usdcBaseUnits)}, deployed=${before.isDeployed}`);
      if (before.usdcBaseUnits < amountBaseUnits) {
        addLog("warn", "Smart account USDC balance is below the amount — the transfer will revert. Fund it via the faucet first.");
      }

      const result = await sendUsdcTransfer({
        smartAccount: smartAccount as `0x${string}`,
        to: to.trim() as `0x${string}`,
        amountBaseUnits,
        useCdpPaymaster,
      });
      setSendResult(result);
      addLog("ok", `sendUserOperation accepted. userOperationHash=${result.userOperationHash}`, { request: result.request, amountBaseUnits });

      // Poll until terminal.
      const abort = { cancelled: false };
      pollAbort.current = abort;
      setPolling(true);
      const started = Date.now();
      let last: NormalizedUserOperation | null = null;
      while (!abort.cancelled && Date.now() - started < POLL_MAX_MS) {
        const { normalized, receipt } = await reconcile(result.userOperationHash, smartAccount as `0x${string}`);
        if (!last || last.sdkStatus !== normalized.sdkStatus) {
          addLog("info", `user op status: ${normalized.sdkStatus} (phase ${normalized.phase})${normalized.transactionHash ? ` tx=${normalized.transactionHash}` : ""}`);
        }
        last = normalized;
        if (isTerminalPhase(normalized.phase)) {
          if (normalized.phase === "confirmed" && receipt?.status === "success") {
            setSigningVerifiedThisLoad(true);
            addLog("ok", `CONFIRMED. tx ${normalized.transactionHash} success in block ${receipt.blockNumber.toString()}, gasUsed ${receipt.gasUsed.toString()}, ${receipt.logCount} logs. Session origin: ${sessionOrigin}. Pre-send ETH was ${formatEth(before.ethWei)}.`);
          } else if (normalized.phase === "confirmed") {
            addLog("warn", `SDK says complete but chain receipt is ${receipt ? receipt.status : "not found yet"}. Re-check status.`);
          } else {
            addLog("fail", `User op ended in phase ${normalized.phase} (status ${normalized.sdkStatus}). Revert: ${normalized.receipt?.revertMessage ?? "n/a"}`, normalized);
          }
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      if (!abort.cancelled && last && !isTerminalPhase(last.phase)) {
        addLog("warn", `Stopped polling after ${POLL_MAX_MS / 1000}s; last status ${last.sdkStatus}. Use "Check status" to keep reconciling.`);
      }
      setPolling(false);
      await refreshChain(smartAccount);
    } catch (error) {
      setPolling(false);
      addLog("fail", `Send failed: ${errorMessage(error)}`, error instanceof Error ? { name: error.name } : undefined);
    } finally {
      setBusy(null);
    }
  };

  const copyLog = async () => {
    await navigator.clipboard.writeText(JSON.stringify({ snapshots, log }, null, 2));
  };

  const latestGate = snapshots.length > 0 ? evaluateStorageGate(snapshots[snapshots.length - 1]) : null;
  const anyFail = snapshots.some((s) => evaluateStorageGate(s).verdict === "fail");

  return (
    <div className="flex flex-col gap-6 font-mono text-[13px]" data-testid="cdp-poc">
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Developer diagnostic · disposable · not product UI</p>
        <h1 className="font-heading text-xl font-semibold tracking-tight">CDP smart-account PoC — Base Sepolia</h1>
        <p className="text-muted-foreground">
          Token under test: Circle testnet {USDC_SYMBOL} at <Mono>{USDC_ADDRESS}</Mono> ({USDC_DECIMALS} decimals). The product calls it “{CONSUMER_LABEL}”. Chain id {BASE_SEPOLIA_CHAIN_ID}. Testnet only.
        </p>
      </header>

      {problems.length > 0 ? (
        <Panel title="Configuration problems" tone="fail">
          <ul className="list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="mt-2 text-muted-foreground">Set these in .env.local (see .env.example) and restart `pnpm dev`. The SDK is not initialized until they are fixed.</p>
        </Panel>
      ) : null}

      <Panel title="1 · SDK & session">
        <Row k="SDK" v={sdkState} />
        <Row k="Project ID" v={projectId ?? "(missing)"} />
        <Row k="Auth state" v={user ? `signed in (userId ${user.userId})` : "signed out"} />
        <Row k="Session origin (this page load)" v={sessionOrigin} />
        <Row k="Email on account" v={user?.email ?? "—"} />
        <Row k="First-party cookie domain (project config)" v={projectConfig ? projectConfig.activeCookieDomain ?? "none — cookies are third-party" : "—"} />
        {restoreReport ? (
          <div className="mt-2 rounded-md border border-border p-2">
            <p className="font-medium">Restore check (SDK-driven, on load)</p>
            <Row k="isSignedIn after initialize" v={String(restoreReport.signedIn)} />
            <Row k="Smart account remembered before this load" v={restoreReport.addressBefore ?? "(none)"} />
            <Row k="Smart account returned after restore" v={restoreReport.addressAfter ?? "(none)"} />
            <Row
              k="Same account?"
              v={
                restoreReport.addressBefore && restoreReport.addressAfter
                  ? restoreReport.addressBefore.toLowerCase() === restoreReport.addressAfter.toLowerCase()
                    ? "YES"
                    : "NO — DIFFERENT ACCOUNT"
                  : "n/a (nothing to compare yet)"
              }
            />
            <Row k="Signing proven after restore (a send confirmed this load)" v={sessionOrigin === "restored" ? (signingVerifiedThisLoad ? "YES" : "not yet — send test Cash to prove it") : "n/a (fresh sign-in)"} />
          </div>
        ) : null}

        {!user ? (
          <div className="mt-3 flex flex-col gap-2">
            <Label htmlFor="poc-email">Email (use a brand-new address for the new-user test)</Label>
            <div className="flex gap-2">
              <Input id="poc-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="new-user@example.com" disabled={sdkState !== "ready" || busy !== null} />
              <Button onClick={onStartSignIn} disabled={sdkState !== "ready" || busy !== null || email.trim() === ""}>
                Sign up / sign in
              </Button>
            </div>
            {flowId ? (
              <div className="flex gap-2">
                <Input value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="6-digit code from email" inputMode="numeric" disabled={busy !== null} />
                <Button onClick={onVerifyOtp} disabled={busy !== null || otp.trim().length < 4}>
                  Verify code
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onRestoreSession} disabled={sdkState !== "ready" || busy !== null}>
            Restore session (isSignedIn + getCurrentUser)
          </Button>
          <Button variant="outline" size="sm" onClick={onRefreshAccount} disabled={!user || busy !== null}>
            Refresh account
          </Button>
          <Button variant="destructive" size="sm" onClick={onSignOut} disabled={!user || busy !== null}>
            Sign out
          </Button>
        </div>
      </Panel>

      <Panel title="2 · Smart account (ERC-4337, user-controlled)">
        <Row k="Smart account" v={smartAccount ?? "—"} link={smartAccount ? explorerAddressUrl(smartAccount) : undefined} />
        <Row k="Owner EOA(s)" v={user?.smartAccounts[0]?.ownerAddresses.join(", ") ?? user?.eoaAddresses.join(", ") ?? "—"} />
        <Row k="Created at (CDP)" v={user?.smartAccounts[0]?.createdAt ?? "—"} />
        <Row k="isNewUser (from verify)" v={user?.isNewUser === null || user?.isNewUser === undefined ? "n/a (restored)" : String(user.isNewUser)} />
        <Row k="Smart account created by PoC after login" v={smartAccountCreatedHere === null ? "—" : String(smartAccountCreatedHere)} />
        <Row k="Chain (expected)" v={`Base Sepolia · ${BASE_SEPOLIA_CHAIN_ID}`} />
        <Row k="Chain id reported by RPC" v={chainState ? String(chainState.rpcChainId) : "—"} />
        <Row k="ETH balance" v={chainState ? `${formatEth(chainState.ethWei)} ETH` : "—"} />
        <Row k={`${CONSUMER_LABEL} balance (${USDC_SYMBOL})`} v={chainState ? `${formatUsdcAmount(chainState.usdcBaseUnits)} ${USDC_SYMBOL}` : "—"} />
        <Row k="Contract code deployed at address" v={chainState ? String(chainState.isDeployed) : "—"} />
        <Row k="Read at block / time" v={chainState ? `${chainState.blockNumber.toString()} / ${chainStateAt}` : "—"} />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => refreshChain()} disabled={!smartAccount || busy !== null}>
            Refresh {CONSUMER_LABEL} balance / chain state
          </Button>
          <Button variant="outline" size="sm" onClick={onCopyAddress} disabled={!smartAccount}>
            Copy smart-account address
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.open(CIRCLE_FAUCET_URL, "_blank", "noopener")}>
            Open Circle faucet (choose Base Sepolia)
          </Button>
        </div>
      </Panel>

      <Panel title={`3 · Send test ${CONSUMER_LABEL} (${USDC_SYMBOL}) with sponsored gas`}>
        <p className="text-muted-foreground">
          The zero-ETH test: the smart account should hold 0 ETH and some test {USDC_SYMBOL}. The transfer is one ERC-20 <Mono>transfer(to, amount)</Mono> call inside a user operation.
        </p>
        <div className="mt-2 flex flex-col gap-2">
          <Label htmlFor="poc-to">Recipient (0x…)</Label>
          <Input id="poc-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" disabled={!smartAccount || busy !== null} />
          <Label htmlFor="poc-amount">Amount ({USDC_SYMBOL})</Label>
          <Input id="poc-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" disabled={!smartAccount || busy !== null} />
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={useCdpPaymaster} onChange={(e) => setUseCdpPaymaster(e.target.checked)} disabled={busy !== null} />
            <span>
              Pass <Mono>useCdpPaymaster: true</Mono> (docs also say Base Sepolia user ops are subsidised without it — test both)
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button onClick={onSend} disabled={!smartAccount || busy !== null}>
              Send test {CONSUMER_LABEL}
            </Button>
            <Button variant="outline" size="sm" onClick={onCheckStatus} disabled={!sendResult || busy !== null}>
              Check / reconcile status
            </Button>
            {polling ? (
              <Button variant="ghost" size="sm" onClick={stopPolling}>
                Stop polling
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-3 rounded-md border border-border p-2">
          <p className="font-medium">Evidence (kept distinct, never collapsed)</p>
          <Row k="ETH before send" v={ethBeforeSend === null ? "—" : `${formatEth(ethBeforeSend)} ETH${ethBeforeSend === BigInt(0) ? " (zero ✓)" : " (NON-ZERO)"}`} />
          <Row k="Deployed before send" v={deployedBeforeSend === null ? "—" : String(deployedBeforeSend)} />
          <Row k="Deployed after (latest read)" v={chainState ? String(chainState.isDeployed) : "—"} />
          <Row k="Paymaster option sent" v={sendResult ? `useCdpPaymaster=${sendResult.request.useCdpPaymaster}` : "—"} />
          <Row k="Submission reference" v="none — sendUserOperation returns only userOperationHash (no calls ID)" />
          <Row k="User-operation hash (SDK)" v={sendResult?.userOperationHash ?? "—"} />
          <Row k="SDK status (raw)" v={userOp ? `${userOp.sdkStatus}${userOp.isKnownStatus ? "" : " (UNKNOWN TO INSTALLED TYPES)"} → phase ${userOp.phase}` : "—"} />
          <Row k="Transaction hash (SDK)" v={userOp?.transactionHash ?? "—"} link={userOp?.transactionHash ? explorerTxUrl(userOp.transactionHash) : undefined} />
          <Row k="SDK receipt" v={userOp?.receipt ? `block ${userOp.receipt.blockNumber ?? "?"}, gasUsed ${userOp.receipt.gasUsed ?? "?"}, revert ${userOp.receipt.revertMessage ?? "none"}` : "—"} />
          <Row k="SDK top-level hash vs receipt hash agree" v={userOp?.hashesAgree === null || userOp?.hashesAgree === undefined ? "n/a" : String(userOp.hashesAgree)} />
          <Row k="Chain receipt (viem, independent)" v={chainReceipt ? `${chainReceipt.status}, block ${chainReceipt.blockNumber.toString()}, gasUsed ${chainReceipt.gasUsed.toString()}, from ${chainReceipt.from}, ${chainReceipt.logCount} logs` : sendResult ? "not found yet" : "—"} />
          <Row k="Bundler tx sender ≠ smart account (expected for 4337)" v={chainReceipt && smartAccount ? String(chainReceipt.from.toLowerCase() !== smartAccount.toLowerCase()) : "—"} />
          {userOpRaw ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-muted-foreground">Raw getUserOperation response</summary>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(jsonSafe(userOpRaw), null, 2)}</pre>
            </details>
          ) : null}
        </div>
      </Panel>

      <Panel title="4 · Storage security audit (key NAMES only — values are never read)" tone={anyFail ? "fail" : latestGate ? "ok" : undefined}>
        <p className="text-muted-foreground">
          Gate: any of <Mono>{CDP_KNOWN_STORAGE_KEYS.refreshTokenMirror}</Mono> in localStorage/sessionStorage = FAIL. Known CDP keys: <Mono>{CDP_KNOWN_STORAGE_KEYS.refreshTokenMirror}</Mono> (sensitive mirror), <Mono>{CDP_KNOWN_STORAGE_KEYS.oauthPendingFlowId}</Mono> (CSRF state), <Mono>{CDP_KNOWN_STORAGE_KEYS.providerStore}</Mono> (EIP-1193 provider store; unused here). PoC-owned:{" "}
          <Mono>{LAST_ADDRESS_KEY}</Mono> (public address). Practice/mode stores: <Mono>onchain-finance:*</Mono>.
        </p>
        <p className="mt-1 text-muted-foreground">
          Not visible to script by design: HttpOnly cookies (the CDP refresh cookie <Mono>cdp_refresh_token</Mono> should be one). Confirm manually: DevTools → Application → Cookies → api.cdp.coinbase.com (or the first-party cookie domain), check the HttpOnly column; and Network → the <Mono>auth/verify/email</Mono> response → Set-Cookie header and whether the JSON body contains a <Mono>refreshToken</Mono> field.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => snapshot(`manual @ ${new Date().toLocaleTimeString()}`)}>
            Take snapshot now
          </Button>
        </div>
        <div className="mt-2 flex flex-col gap-2">
          {snapshots.map((s, i) => {
            const gate = evaluateStorageGate(s);
            const prev = snapshots[i - 1];
            const ls = prev ? diffKeys(prev.localStorageKeys, s.localStorageKeys) : null;
            return (
              <div key={`${s.label}-${s.takenAt}`} className={`rounded-md border p-2 ${gate.verdict === "fail" ? "border-destructive" : "border-border"}`}>
                <p className="font-medium">
                  {s.label} — <span className={gate.verdict === "fail" ? "text-destructive" : ""}>{gate.verdict.toUpperCase()}</span>
                  {gate.sensitiveKeysFound.length > 0 ? ` (found: ${gate.sensitiveKeysFound.join(", ")})` : ""}
                </p>
                <Row k="localStorage keys" v={s.localStorageKeys.join(", ") || "(none)"} />
                {ls && (ls.added.length > 0 || ls.removed.length > 0) ? <Row k="Δ localStorage vs previous" v={`+[${ls.added.join(", ")}] −[${ls.removed.join(", ")}]`} /> : null}
                <Row k="sessionStorage keys" v={s.sessionStorageKeys.join(", ") || "(none)"} />
                <Row k="IndexedDB databases" v={s.indexedDbNames === null ? "(not enumerable in this browser — check DevTools)" : s.indexedDbNames.join(", ") || "(none)"} />
                <Row k="Script-visible cookie names" v={s.cookieNames.join(", ") || "(none)"} />
                <Row k="Taken" v={s.takenAt} />
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel title="5 · Evidence log">
        <div className="mb-2 flex gap-2">
          <Button variant="outline" size="sm" onClick={copyLog}>
            Copy log + snapshots as JSON
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setLog([])}>
            Clear
          </Button>
        </div>
        <ol className="flex flex-col gap-1">
          {log.map((entry, i) => (
            <li key={`${entry.at}-${i}`} className={entry.level === "fail" ? "text-destructive" : entry.level === "warn" ? "text-amber-500" : entry.level === "ok" ? "text-emerald-500" : ""}>
              <span className="text-muted-foreground">{entry.at.slice(11, 19)}</span> [{entry.level}] {entry.text}
              {entry.detail !== undefined ? (
                <details>
                  <summary className="cursor-pointer text-muted-foreground">detail</summary>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(entry.detail, null, 2)}</pre>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}

function Panel({ title, tone, children }: { title: string; tone?: "ok" | "fail"; children: React.ReactNode }) {
  return (
    <section className={`flex flex-col gap-1 rounded-xl border p-4 ${tone === "fail" ? "border-destructive" : tone === "ok" ? "border-emerald-600/60" : "border-border"}`}>
      <h2 className="mb-1 font-heading text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Row({ k, v, link }: { k: string; v: string; link?: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,14rem)_1fr] gap-x-3 border-b border-border/40 py-0.5 last:border-b-0">
      <span className="text-muted-foreground">{k}</span>
      <span className="break-all">
        {link ? (
          <a href={link} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            {v}
          </a>
        ) : (
          v
        )}
      </span>
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 py-px text-xs">{children}</code>;
}
