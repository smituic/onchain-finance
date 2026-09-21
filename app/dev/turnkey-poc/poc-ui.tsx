"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createTurnkeyOwnerAccount, createPocSafeAccount, inspectSafe } from "@/lib/poc/turnkey/account";
import { createVerifiedTurnkeyOwnerAccount } from "@/lib/poc/turnkey/verified-account";
import {
  CASH_USDC,
  GATE2_PAYMENT_USDC,
  SAFE_POC,
  SESSION_COOKIE_NAME,
} from "@/lib/poc/turnkey/constants";
import { readPublicTurnkeyPocConfig } from "@/lib/poc/turnkey/config";
import { reportExecutedPath } from "@/lib/poc/turnkey/executed-path";
import { describeGate1Banner } from "@/lib/poc/turnkey/gate-banners";
import { normalizeAddress } from "@/lib/poc/turnkey/identifiers";
import { registerPasskey } from "@/lib/poc/turnkey/passkey";
import { classifyPaymentError } from "@/lib/poc/turnkey/payment-error";
import { sendSponsoredCashTransfer } from "@/lib/poc/turnkey/payment";
import { SafeOpPreflightError } from "@/lib/poc/turnkey/safe-op-preflight";
import {
  clearPendingOperation,
  loadOperationHistory,
  loadPendingOperation,
  loadPublicAccount,
  rememberOperation,
  savePendingOperation,
  savePublicAccount,
  clearTurnkeyPocPublicStorage,
  type PendingOperation,
  type PublicAccountState,
} from "@/lib/poc/turnkey/public-state";
import { canonicalPaymentRequest } from "@/lib/poc/turnkey/request-binding";
import { findSourceForSimulatedRecovery, simulateUnresolvedKnownHash } from "@/lib/poc/turnkey/recovery-harness";
import { evaluateSecurityGateOrIncomplete, type ChildConfigEvidence } from "@/lib/poc/turnkey/security-gate";
import {
  mutateSignRawPayloadBody,
  prepareSignRawPayloadStamp,
  runEip712SignProbe,
  runHarmlessSignProbe,
  runRawDigestSignProbe,
  runVerifiedEip712SignProbe,
} from "@/lib/poc/turnkey/sign-probe";
import { captureStorageSnapshot, rememberStorageSnapshot } from "@/lib/poc/turnkey/storage-audit";
import { evaluateStorageSnapshots, type StorageSnapshot } from "@/lib/poc/turnkey/storage";
import { statusAfterTransportUncertainty, type OperationStatus } from "@/lib/poc/turnkey/status";
import { formatUsdcFromUnits } from "@/lib/poc/turnkey/usdc";
import { TURNKEY_UV_SERVER_FINDING } from "@/lib/poc/turnkey/webauthn-flags";

type SessionResponse = {
  authenticated: boolean;
  appUserId?: string;
  subOrganizationId?: string;
  userId?: string;
  walletId?: string;
  ownerAddress?: string;
  authenticators?: PublicAccountState["authenticators"];
  cookie?: { name: string; httpOnly: boolean; jsReadable: boolean };
};

type BalanceSnapshot = {
  ownerEth: string;
  safeEth: string;
  ownerUsdc: string;
  safeUsdc: string;
  recipientUsdc: string | null;
  safeDeployed: boolean;
  safeBytecode: string | null;
};

function randomOperationId(): string {
  return crypto.randomUUID();
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? `Request failed (${response.status})`);
  return json;
}

function Field({ label, value }: { label: string; value: string | number | boolean | null | undefined }) {
  return (
    <div className="grid grid-cols-[12rem_1fr] gap-2 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all font-mono text-xs">{value === null || value === undefined || value === "" ? "—" : String(value)}</dd>
    </div>
  );
}

export function TurnkeyPocUi() {
  const publicConfig = readPublicTurnkeyPocConfig();
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const sendInFlight = useRef(false);
  const [account, setAccount] = useState<PublicAccountState | null>(null);
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const [history, setHistory] = useState<PendingOperation[]>([]);
  const [child, setChild] = useState<ChildConfigEvidence | null>(null);
  const [negative, setNegative] = useState<{ allFailedAsExpected: boolean; results: Array<{ name: string; failedAsExpected: boolean; error: string | null }> } | null>(null);
  const [signProbe, setSignProbe] = useState<string>("not run");
  const [cancelProbe, setCancelProbe] = useState<string>("not run");
  const [replay, setReplay] = useState<string>("not run");
  const [uvFlags, setUvFlags] = useState<string>("not captured");
  const [balances, setBalances] = useState<BalanceSnapshot | null>(null);
  const [safeDeployed, setSafeDeployed] = useState<boolean | null>(null);
  const [chainHistory, setChainHistory] = useState<Array<Record<string, string | undefined>>>([]);
  const [snapshots, setSnapshots] = useState<StorageSnapshot[]>([]);
  const [recipient, setRecipient] = useState("");
  const [httpOnlyCookie, setHttpOnlyCookie] = useState(`${SESSION_COOKIE_NAME} (HttpOnly; not JS-readable)`);
  const [eip712Probe, setEip712Probe] = useState<string>("not run");
  const [rawDigestProbe, setRawDigestProbe] = useState<string>("not run");
  const [legacyAdapterProbe, setLegacyAdapterProbe] = useState<string>("not run");
  const [addressToCheck, setAddressToCheck] = useState("");
  const [addressCheckResult, setAddressCheckResult] = useState<string>("not checked");

  const append = useCallback((line: string) => {
    setLog((current) => [...current, `${new Date().toISOString()} ${line}`]);
  }, []);

  const snapshot = useCallback(async (at: string) => {
    const captured = await captureStorageSnapshot(at);
    setSnapshots(rememberStorageSnapshot(captured));
    return captured;
  }, []);

  const persistAccount = useCallback((next: PublicAccountState) => {
    savePublicAccount(next);
    setAccount(next);
  }, []);

  const persistPending = useCallback((next: PendingOperation) => {
    savePendingOperation(next);
    rememberOperation(next);
    setPending(next);
    setHistory(loadOperationHistory());
  }, []);

  const refreshSession = useCallback(async () => {
    const session = await api<SessionResponse>("/api/dev/turnkey-poc/session");
    setHttpOnlyCookie(
      session.cookie
        ? `${session.cookie.name} (HttpOnly=${String(session.cookie.httpOnly)}; JS-readable=${String(session.cookie.jsReadable)})`
        : `${SESSION_COOKIE_NAME} (manual: HttpOnly cookie is not in document.cookie)`,
    );
    return session;
  }, []);

  // Shared by the mount effect and the "Inspect child" button. Re-derives
  // child config AND the canonical owner address from Turnkey itself (not
  // from anything cached), so a locally corrupted address self-heals from
  // the existing sub-org/wallet instead of requiring reprovisioning, and so
  // a reload/remount doesn't leave Gate 1's diagnostics looking like a real
  // authority failure just because they were never re-fetched.
  const fetchChildInspection = useCallback(async () => {
    const inspection = await api<{ child: ChildConfigEvidence; ownerAddress: string | null }>(
      "/api/dev/turnkey-poc/inspect",
    );
    setChild(inspection.child);
    if (inspection.ownerAddress) {
      setAccount((current) => {
        if (!current || current.ownerAddress === inspection.ownerAddress) return current;
        const healed = { ...current, ownerAddress: inspection.ownerAddress! };
        savePublicAccount(healed);
        append(`Recovered canonical owner address from Turnkey inspection (was locally corrupted): ${inspection.ownerAddress}.`);
        return healed;
      });
    }
    return inspection.child;
  }, [append]);

  useEffect(() => {
    void (async () => {
      await snapshot("before-init");
      const stored = loadPublicAccount();
      const storedPending = loadPendingOperation();
      setHistory(loadOperationHistory());
      if (stored) setAccount(stored);
      if (storedPending) setPending(storedPending);
      const session = await refreshSession();
      if (session.authenticated && stored) {
        append("Reloaded public account identity from storage + app session. Signing permission was not restored.");
        try {
          await fetchChildInspection();
        } catch {
          // Best-effort: Gate 1 shows "not yet inspected" until retried manually.
        }
      }
    })();
  }, [append, fetchChildInspection, refreshSession, snapshot]);

  const normalizedRecipient = useMemo(() => normalizeAddress(recipient), [recipient]);
  const pendingUnresolved = Boolean(pending && pending.status !== "confirmed" && pending.status !== "failed");
  // DEV-ONLY reconciliation test harness precondition: only offer "Simulate
  // unresolved known-hash state" when there is an already-confirmed
  // operation (active or in history) with a known userOperationHash to
  // simulate a local recovery of. See recovery-harness.ts.
  const simulationSource = useMemo(() => findSourceForSimulatedRecovery(pending, history), [pending, history]);
  // "Send 0.10 Cash" must never silently no-op. This is the single source of
  // truth for both disabling the button and showing why — a click that
  // can't proceed always has a visible, specific reason on screen instead of
  // only an easy-to-miss line in the Event log.
  const sendPaymentBlockedReason = useMemo(() => {
    if (busy !== null) return null; // the "Busy: …" indicator already covers this.
    if (!account) return "Register a passkey and provision an account first.";
    if (pendingUnresolved) {
      return `A previous payment is unresolved (status: ${pending?.status}). Reconcile it, check USDC history, or clear it after manual review (Gate 3) before sending again.`;
    }
    if (!normalizedRecipient) {
      return recipient.trim() === ""
        ? "Enter a recipient address to enable Send 0.10 Cash."
        : "Recipient must be a valid 0x… Ethereum address.";
    }
    return null;
  }, [account, busy, normalizedRecipient, pending?.status, pendingUnresolved, recipient]);

  const storageEval = useMemo(() => evaluateStorageSnapshots(snapshots), [snapshots]);
  const executed = reportExecutedPath();
  const gate1 = useMemo(
    () =>
      evaluateSecurityGateOrIncomplete({
        passkeyRegistered: Boolean(account),
        child,
        signingPath: executed,
        storageFailed: storageEval.failed,
        storageReasons: storageEval.reasons,
        harmlessSignProduced: signProbe.startsWith("signed"),
        cancelledSignProducedSignature: cancelProbe.includes("signature produced"),
      }),
    [account, cancelProbe, child, executed, signProbe, storageEval],
  );

  async function registerAndProvision() {
    setBusy("provision");
    try {
      await snapshot("before-registration");
      append("Requesting a new passkey with userVerification: required.");
      const passkey = await registerPasskey();
      await snapshot("after-passkey-registration");
      append("Provisioning a Turnkey sub-organization. Parent API key is not added as a child root.");
      const provisioned = await api<{
        subOrganizationId: string;
        userId: string;
        walletId: string;
        ownerAddress: string;
        authenticators: PublicAccountState["authenticators"];
        child: ChildConfigEvidence;
      }>("/api/dev/turnkey-poc/provision", {
        method: "POST",
        body: JSON.stringify({
          challengeBase64Url: passkey.challengeBase64Url,
          attestation: passkey.attestation,
        }),
      });
      const next: PublicAccountState = {
        appUserId: crypto.randomUUID(),
        subOrganizationId: provisioned.subOrganizationId,
        userId: provisioned.userId,
        walletId: provisioned.walletId,
        // Turnkey's signRawPayload resource lookup is case-sensitive — keep
        // the exact string Turnkey returned. Do not .toLowerCase() this.
        ownerAddress: provisioned.ownerAddress,
        safeAddress: null,
        authenticators: provisioned.authenticators,
        safe: {
          version: SAFE_POC.version,
          threshold: SAFE_POC.threshold,
          saltNonce: SAFE_POC.saltNonce,
          entryPointAddress: SAFE_POC.entryPoint.address,
          entryPointVersion: SAFE_POC.entryPoint.version,
          moduleAddress: SAFE_POC.module.address,
          moduleVersion: SAFE_POC.module.version,
          useMultiSendForSetup: SAFE_POC.useMultiSendForSetup,
        },
      };
      persistAccount(next);
      setChild(provisioned.child);
      await refreshSession();
      await snapshot("after-provisioning");
      append(`Child sub-org ${provisioned.subOrganizationId} created. Owner ${provisioned.ownerAddress}.`);
    } catch (error) {
      append(`Provision failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function inspectChild() {
    setBusy("inspect");
    try {
      const childResult = await fetchChildInspection();
      append(`Inspected child: threshold=${childResult.rootThreshold}, apiKeys=${childResult.apiKeyCount}, authenticators=${childResult.authenticatorCount}.`);
    } catch (error) {
      append(`Inspect failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function runNegative() {
    setBusy("negative");
    try {
      const result = await api<{ allFailedAsExpected: boolean; results: Array<{ name: string; failedAsExpected: boolean; error: string | null }> }>(
        "/api/dev/turnkey-poc/negative-tests",
        { method: "POST" },
      );
      setNegative(result);
      append(result.allFailedAsExpected ? "Backend negative tests failed as expected." : "WARNING: a backend negative test succeeded.");
    } catch (error) {
      append(`Negative tests failed to run: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function deriveSafe() {
    if (!account) return;
    setBusy("safe");
    try {
      const owner = await createTurnkeyOwnerAccount({
        rpId: publicConfig.rpId,
        subOrganizationId: account.subOrganizationId,
        ownerAddress: account.ownerAddress,
      });
      const safe = await createPocSafeAccount(owner);
      const inspected = await inspectSafe(safe.address, account.ownerAddress);
      persistAccount({ ...account, safeAddress: safe.address.toLowerCase() });
      setSafeDeployed(inspected.deployed);
      append(`Counterfactual Safe ${safe.address}. Deployed=${String(inspected.deployed)}. Derivation does not restore signing permission after reload; the next signing call will prompt again.`);
    } catch (error) {
      append(`Safe derivation failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function refreshBalances() {
    if (!account?.safeAddress) return;
    setBusy("balances");
    try {
      const result = await api<BalanceSnapshot>("/api/dev/turnkey-poc/balances", {
        method: "POST",
        body: JSON.stringify({ safeAddress: account.safeAddress, recipient: normalizeAddress(recipient) }),
      });
      setBalances(result);
      setSafeDeployed(result.safeDeployed);
      append("Balance snapshot refreshed from public chain reads.");
    } catch (error) {
      append(`Balance read failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function signProbeAction() {
    if (!account) return;
    setBusy("sign");
    try {
      append("Harmless signing probe: a fresh WebAuthn ceremony is required.");
      const result = await runHarmlessSignProbe({
        rpId: publicConfig.rpId,
        subOrganizationId: account.subOrganizationId,
        ownerAddress: account.ownerAddress,
      });
      if (result.outcome === "cancelled") {
        setSignProbe("cancelled; no signature");
        append("Passkey prompt cancelled; no signature.");
      } else {
        setSignProbe(`signed activity=${result.activityId} signaturePresent=${String(result.signaturePresent)}`);
        append("Harmless probe produced a Turnkey signature metadata record (hash/activity only).");
      }
      await snapshot("after-signing");
    } catch (error) {
      append(`Sign probe failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function cancelProbeAction() {
    if (!account) return;
    setBusy("cancel");
    try {
      append("Cancel the upcoming passkey prompt to prove no signature is produced.");
      const result = await runHarmlessSignProbe({
        rpId: publicConfig.rpId,
        subOrganizationId: account.subOrganizationId,
        ownerAddress: account.ownerAddress,
      });
      setCancelProbe(result.outcome === "cancelled" ? "cancelled; no signature" : "signature produced (unexpected)");
    } catch (error) {
      setCancelProbe("cancelled or failed; no confirmed signature");
      append(`Cancel probe: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function replayProbeAction() {
    if (!account) return;
    setBusy("replay");
    try {
      append("Stamping a request, then submitting a mutated payload with the same assertion.");
      const prepared = await prepareSignRawPayloadStamp({
        rpId: publicConfig.rpId,
        subOrganizationId: account.subOrganizationId,
        ownerAddress: account.ownerAddress,
      });
      setUvFlags(
        prepared.uvFlags
          ? `UP=${String(prepared.uvFlags.userPresent)} UV=${String(prepared.uvFlags.userVerified)}`
          : "not present in stamp",
      );
      const mutated = await api<{ ok: boolean; status: number; bodyPreview: string }>("/api/dev/turnkey-poc/replay", {
        method: "POST",
        body: JSON.stringify({
          url: prepared.url,
          stampHeaderName: prepared.stampHeaderName,
          stampHeaderValue: prepared.stampHeaderValue,
          requestBody: mutateSignRawPayloadBody(prepared.originalBody),
        }),
      });
      const original = await api<{ ok: boolean; status: number; bodyPreview: string }>("/api/dev/turnkey-poc/replay", {
        method: "POST",
        body: JSON.stringify({
          url: prepared.url,
          stampHeaderName: prepared.stampHeaderName,
          stampHeaderValue: prepared.stampHeaderValue,
          requestBody: prepared.originalBody,
        }),
      });
      setReplay(`mutated ok=${String(mutated.ok)} status=${mutated.status}; original ok=${String(original.ok)} status=${original.status}`);
      append("Request-binding probe finished. Mutating the body after WebAuthn should fail.");
    } catch (error) {
      append(`Replay probe failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function eip712SignProbeAction() {
    if (!account) return;
    setBusy("eip712-probe");
    try {
      append("Verified EIP-712 sign probe (fixed path): fresh passkey signing a fixed, non-Safe typed-data object via the custom signTypedData now used for real SafeOp signing (local hash -> Turnkey raw sign -> local recovery check).");
      const result = await runVerifiedEip712SignProbe({
        rpId: publicConfig.rpId,
        subOrganizationId: account.subOrganizationId,
        ownerAddress: account.ownerAddress,
      });
      setEip712Probe(
        `expected=${result.expectedOwner} recovered=${result.recoveredAddress} digest=${result.digest} v=${result.vByte} sigBytes=${result.signatureByteLength} match=${String(result.matches)}`,
      );
      append(`Verified EIP-712 probe: match=${String(result.matches)}. Never called Pimlico.`);

      append("Raw-digest reference probe: signing the SAME fixed object's local digest via Turnkey's low-level signRawPayload + HASH_FUNCTION_NO_OP (the same primitive the verified path uses) — fresh passkey again.");
      const rawResult = await runRawDigestSignProbe({
        rpId: publicConfig.rpId,
        subOrganizationId: account.subOrganizationId,
        ownerAddress: account.ownerAddress,
      });
      setRawDigestProbe(
        `expected=${rawResult.expectedOwner} recovered=${rawResult.recoveredAddress} digest=${rawResult.digest} match=${String(rawResult.matches)}`,
      );
      append(
        `Raw-digest probe: match=${String(rawResult.matches)}. digestsIdentical=${String(result.digest.toLowerCase() === rawResult.digest.toLowerCase())}. Never called Pimlico.`,
      );

      if (result.matches && rawResult.matches) {
        append("Both the verified path and the raw-digest reference recover the canonical owner — the signing path real SafeOp payments now use is healthy.");
      } else {
        append("WARNING: the verified path or the raw-digest reference failed to recover the canonical owner — do not attempt a Gate 2 payment yet.");
      }
    } catch (error) {
      append(`EIP-712 sign probe failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Optional, manually triggered comparison against @turnkey/viem's own
   * signTypedData adapter — proven live to recover the wrong signer. Kept
   * separate from eip712SignProbeAction (the normal verification flow) so
   * checking the real signing path never costs an extra, unnecessary passkey
   * ceremony against a path known not to be used for real signing anymore.
   */
  async function legacyAdapterProbeAction() {
    if (!account) return;
    setBusy("legacy-adapter-probe");
    try {
      append("Legacy @turnkey/viem EIP-712 adapter probe (known broken, optional): fresh passkey signing the same fixed typed-data object through the unmodified createAccount().signTypedData.");
      const result = await runEip712SignProbe({
        rpId: publicConfig.rpId,
        subOrganizationId: account.subOrganizationId,
        ownerAddress: account.ownerAddress,
      });
      setLegacyAdapterProbe(
        `expected=${result.expectedOwner} recovered=${result.recoveredAddress} digest=${result.digest} v=${result.vByte} sigBytes=${result.signatureByteLength} match=${String(result.matches)}`,
      );
      append(`Legacy adapter probe: match=${String(result.matches)}. Never called Pimlico. This path is not used for real signing.`);
    } catch (error) {
      append(`Legacy adapter probe failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function checkAddressOwnership() {
    const target = normalizeAddress(addressToCheck);
    if (!target) {
      setAddressCheckResult("Enter a valid 0x… address to check.");
      return;
    }
    setBusy("check-address");
    try {
      const result = await api<{ address: string; match: { found: boolean; walletAccountId: string | null; walletId: string | null; path: string | null; isKnownWallet: boolean } }>(
        "/api/dev/turnkey-poc/check-address",
        { method: "POST", body: JSON.stringify({ address: target }) },
      );
      if (!result.match.found) {
        setAddressCheckResult(`${target}: no known Turnkey wallet account in this sub-org.`);
      } else if (result.match.isKnownWallet) {
        setAddressCheckResult(`${target}: belongs to THIS wallet (walletAccountId=${result.match.walletAccountId}, path=${result.match.path}).`);
      } else {
        setAddressCheckResult(
          `${target}: belongs to a DIFFERENT wallet in this sub-org (walletId=${result.match.walletId}, walletAccountId=${result.match.walletAccountId}, path=${result.match.path}).`,
        );
      }
      append(`Checked address ownership for ${target}: found=${String(result.match.found)} isKnownWallet=${String(result.match.isKnownWallet)}.`);
    } catch (error) {
      setAddressCheckResult(`Check failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function sendPayment() {
    if (busy !== null || sendInFlight.current) return;
    // Defense-in-depth: the button is disabled (with sendPaymentBlockedReason
    // shown on screen) whenever this would be true, so this should be
    // unreachable in normal use. Still never silently no-op if it is reached.
    if (!account) {
      append("Send 0.10 Cash blocked: no account. Register a passkey and provision an account first.");
      return;
    }
    if (pendingUnresolved) {
      append(`Send 0.10 Cash blocked: a previous payment is unresolved (status: ${pending?.status}). Reconcile, check USDC history, or clear it first.`);
      return;
    }
    const normalizedRecipient = normalizeAddress(recipient);
    const identity = canonicalPaymentRequest({ recipient, amountUsdc: GATE2_PAYMENT_USDC });
    if (!normalizedRecipient || !identity) {
      append("Send 0.10 Cash blocked: recipient must be a valid 0x… Ethereum address.");
      return;
    }
    sendInFlight.current = true;
    setBusy("pay");
    // Tracks the operation's latest known state through each stage, so a
    // failure at any point (not just the very first one) is reported and
    // persisted against reality — this used to always fall back to the
    // original "preparing" snapshot because persistPending only ever wrote
    // new objects without this variable being updated.
    let operation: PendingOperation = {
      id: randomOperationId(),
      status: "preparing",
      recipient: normalizedRecipient,
      amountUsdc: GATE2_PAYMENT_USDC,
      userOperationHash: null,
      transactionHash: null,
      receiptStatus: null,
      submittedAt: new Date().toISOString(),
      lastError: null,
      autoResend: false,
      simulatedRecoveryOf: null,
    };
    try {
      persistPending(operation);
      await refreshBalances();
      operation = { ...operation, status: "awaiting-passkey" };
      persistPending(operation);
      append("Sending sponsored 0.10 USDC. Approve the fresh passkey prompt for this exact user operation.");
      const owner = await createVerifiedTurnkeyOwnerAccount({
        rpId: publicConfig.rpId,
        subOrganizationId: account.subOrganizationId,
        ownerAddress: account.ownerAddress,
      });
      const sent = await sendSponsoredCashTransfer({
        owner,
        recipient: normalizedRecipient,
        amountUsdc: GATE2_PAYMENT_USDC,
      });
      append(
        `Local preflight: recovered=${sent.preflight.recoveredAddress} v=${sent.preflight.vByte} sigBytes=${sent.preflight.signatureByteLength} matchesOwner=${String(sent.preflight.ok)} digestsMatch=${String(sent.digestsMatch)}. Submitting only because this passed.`,
      );
      operation = {
        ...operation,
        status: "submitted",
        userOperationHash: sent.userOperationHash,
        submittedAt: new Date().toISOString(),
      };
      persistPending(operation);
      persistAccount({ ...account, safeAddress: sent.safeAddress.toLowerCase() });
      await snapshot("after-payment-submission");
      append(`Submitted userOperationHash=${sent.userOperationHash}. Not auto-resending.`);
      await reconcile(sent.userOperationHash, operation);
    } catch (error) {
      // Distinguishes cancelled / signing-failed / rejected (all terminal —
      // safe to retry) from uncertain (the bundler response was lost; the
      // operation may already exist, so it stays "unknown" and blocks a new
      // send until the user reconciles, checks history, or clears it).
      const classification = classifyPaymentError(error, { submissionAcknowledged: operation.userOperationHash !== null });
      const status: OperationStatus = classification.stage === "uncertain" ? "unknown" : "failed";
      const rpcSuffix = classification.rpc
        ? ` [${classification.rpc.method}${classification.rpc.code !== undefined ? ` code=${classification.rpc.code}` : ""}]`
        : "";
      const lastError = `${classification.detail}${rpcSuffix}`;
      operation = { ...operation, status, lastError };
      persistPending(operation);
      append(`Payment stopped (${classification.stage}/${classification.phase}), not auto-resending: ${lastError}`);
      if (error instanceof SafeOpPreflightError) {
        append(
          `Preflight diagnostic: digest A (exact object passed to signTypedData)=${error.signDiagnostic?.preSignDigest ?? "unavailable"}, digest B (preflight reconstruction)=${error.preflight.reconstructedDigest ?? "unavailable"}, digestsMatch=${String(error.digestsMatch)}, recovered=${error.preflight.recoveredAddress}, expectedOwner=${error.preflight.expectedOwner}.`,
        );
      }
    } finally {
      sendInFlight.current = false;
      setBusy(null);
    }
  }

  function clearUnresolvedPayment() {
    if (!pending) return;
    const previousStatus = pending.status;
    clearPendingOperation();
    setPending(null);
    append(
      `Cleared the unresolved payment record (status was "${previousStatus}") after manual review. It remains visible in the operation history below. This does not resend or touch the chain.`,
    );
  }

  /**
   * DEV-ONLY reconciliation test harness: locally recreates the "unresolved,
   * known hash" state from an already-confirmed operation, so "Reconcile
   * pending" can be exercised for real against the actual bundler/chain
   * lookup without ever sending another live payment. This is a pure,
   * synchronous local data transform (simulateUnresolvedKnownHash) — no
   * await, no fetch, no Turnkey call, no WebAuthn prompt, no chain state
   * change. The historical confirmed record is untouched; this persists a
   * brand-new record under a new id (see recovery-harness.ts for why).
   */
  function simulateUnresolvedKnownHashAction() {
    if (!simulationSource) {
      append("Cannot simulate an unresolved known-hash state: no confirmed operation with a userOperationHash exists yet.");
      return;
    }
    const simulated = simulateUnresolvedKnownHash(simulationSource);
    persistPending(simulated);
    append(
      `DEV-ONLY: simulated a local unresolved (status=unknown) recovery copy of confirmed operation ${simulationSource.id}, preserving userOperationHash=${simulated.userOperationHash}. transactionHash/receipt were cleared from this active copy only. No Turnkey call, no WebAuthn prompt, no submission, no chain state changed. The historical confirmed record is untouched in history below. Click "Reconcile pending" to restore it via the real bundler/chain lookup.`,
    );
  }

  async function reconcile(hash: string, base: PendingOperation) {
    try {
      const result = await api<{
        status: OperationStatus;
        userOperationHash: string;
        transactionHash: string | null;
        receiptStatus: "success" | "reverted" | null;
        error?: string;
      }>("/api/dev/turnkey-poc/reconcile", {
        method: "POST",
        body: JSON.stringify({ userOperationHash: hash }),
      });
      if ((base.status === "confirmed" || base.status === "failed") && (result.status === "unknown" || result.status === "pending")) {
        append("Receipt lookup unavailable; retained the previously observed terminal receipt. Nothing was resent.");
        return;
      }
      persistPending({
        ...base,
        status: result.status,
        userOperationHash: result.userOperationHash,
        transactionHash: result.transactionHash,
        receiptStatus: result.receiptStatus,
        lastError: result.error ?? null,
      });
      await refreshBalances();
      append(`Reconciled userOperationHash=${result.userOperationHash} tx=${result.transactionHash ?? "none"} status=${result.status}.`);
    } catch (error) {
      persistPending({
        ...base,
        status: statusAfterTransportUncertainty(base.status),
        lastError: error instanceof Error ? error.message : "reconcile timeout",
      });
      append("Reconcile timed out or failed. Unresolved status stays unknown; any previously observed terminal receipt is retained. Nothing was resent.");
    }
  }

  async function reconcilePending() {
    if (!pending?.userOperationHash) return;
    setBusy("reconcile");
    try {
      await reconcile(pending.userOperationHash, pending);
    } finally {
      setBusy(null);
    }
  }

  async function loadHistory() {
    if (!account?.safeAddress) return;
    setBusy("history");
    try {
      const result = await api<{ history: Array<Record<string, string | undefined>> }>("/api/dev/turnkey-poc/history", {
        method: "POST",
        body: JSON.stringify({ safeAddress: account.safeAddress }),
      });
      setChainHistory(result.history);
    } catch (error) {
      append(`History failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function logout() {
    await api("/api/dev/turnkey-poc/session", { method: "DELETE" });
    clearTurnkeyPocPublicStorage();
    setAccount(null);
    setPending(null);
    setChild(null);
    await snapshot("after-logout");
    append("App session cookie cleared. Public storage cleared. No signing session existed to clear.");
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-5 py-8">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Isolated developer PoC</p>
        <h1 className="font-heading text-2xl font-semibold">Turnkey direct-passkey account</h1>
        <p className="text-sm text-muted-foreground">
          Not product navigation. Not Real Pay/Home. Flag: NEXT_PUBLIC_TURNKEY_POC_ENABLED. This page is noindex.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>XSS / UX truth</CardTitle>
          <CardDescription>
            Fresh passkey approval prevents stolen long-lived signing credentials. It does not guarantee the UI showed the same recipient/amount as the signed payload. Transaction-intent phishing is out of scope.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">{TURNKEY_UV_SERVER_FINDING}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Gate 1 — authority + storage</CardTitle>
          <CardDescription>Register a new passkey, provision a child sub-org, inspect, sign, cancel, audit storage.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy !== null} onClick={() => void registerAndProvision()}>
              Register passkey + provision
            </Button>
            <Button variant="outline" disabled={busy !== null || !account} onClick={() => void inspectChild()}>
              Inspect child
            </Button>
            <Button variant="outline" disabled={busy !== null || !account} onClick={() => void runNegative()}>
              Backend negative tests
            </Button>
            <Button variant="outline" disabled={busy !== null || !account} onClick={() => void signProbeAction()}>
              Harmless passkey sign
            </Button>
            <Button variant="outline" disabled={busy !== null || !account} onClick={() => void cancelProbeAction()}>
              Cancel passkey prompt
            </Button>
            <Button variant="outline" disabled={busy !== null || !account} onClick={() => void replayProbeAction()}>
              Request-binding probe
            </Button>
            <Button variant="outline" disabled={busy !== null || !account} onClick={() => void eip712SignProbeAction()}>
              EIP-712 sign probe
            </Button>
            <Button variant="outline" disabled={busy !== null || !account} onClick={() => void legacyAdapterProbeAction()}>
              Legacy adapter probe (known broken)
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => void logout()}>
              Clear app session
            </Button>
          </div>
          <dl>
            <Field
              label="Gate 1"
              value={describeGate1Banner({ gate1, hasPersistedIdentity: Boolean(account), probesRerunThisRuntime: signProbe !== "not run" })}
            />
            <Field label="App identity" value={account ? account.appUserId : "none"} />
            <Field label="Sub-org" value={account?.subOrganizationId} />
            <Field label="User" value={account?.userId} />
            <Field label="Owner" value={account?.ownerAddress} />
            <Field label="Root threshold" value={child?.rootThreshold} />
            <Field label="Root users" value={child?.rootUserCount} />
            <Field label="Authenticators" value={child?.authenticatorCount} />
            <Field label="Child API keys" value={child?.apiKeyCount} />
            <Field label="Session creds" value={child?.sessionCredentialCount} />
            <Field label="Backend on child" value={child?.backendApiKeyOnChild} />
            <Field label="Sign probe" value={signProbe} />
            <Field label="Cancel probe" value={cancelProbe} />
            <Field label="Replay probe" value={replay} />
            <Field label="Verified EIP-712 probe" value={eip712Probe} />
            <Field label="Raw-digest probe" value={rawDigestProbe} />
            <Field label="Legacy adapter probe (known broken)" value={legacyAdapterProbe} />
            <Field label="UV flags" value={uvFlags} />
            <Field label="HttpOnly cookie" value={httpOnlyCookie} />
            <Field label="WebAuthn stamper" value={executed.usedWebauthnStamper} />
            <Field label="IndexedDB stamper" value={executed.instantiatedIndexedDbStamper} />
            <Field label="RP ID" value={publicConfig.rpId} />
          </dl>
          {negative ? (
            <ul className="list-disc pl-5 text-sm">
              {negative.results.map((result) => (
                <li key={result.name}>
                  {result.name}: {result.failedAsExpected ? "rejected (expected)" : "UNEXPECTED SUCCESS"} {result.error ? `(${result.error})` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="space-y-2 border-t border-border pt-3">
            <Label htmlFor="address-check">Check address ownership (read-only, signs nothing)</Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="address-check"
                value={addressToCheck}
                onChange={(event) => setAddressToCheck(event.target.value)}
                placeholder="0x…"
                className="max-w-md"
              />
              <Button variant="outline" disabled={busy !== null || !account} onClick={() => void checkAddressOwnership()}>
                Check address
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">{addressCheckResult}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Gate 2 — sponsored 0.10 Cash (USDC)</CardTitle>
          <CardDescription>
            Owner ETH and Safe ETH must stay 0. Fund only the Safe with Circle testnet USDC, then send 0.10. Sponsorship covers deployment if needed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="recipient">Recipient</Label>
            <Input id="recipient" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="0x…" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy !== null || !account} onClick={() => void deriveSafe()}>
              Derive Safe
            </Button>
            <Button variant="outline" disabled={busy !== null || !account?.safeAddress} onClick={() => void refreshBalances()}>
              Refresh balances
            </Button>
            <Button disabled={busy !== null || sendPaymentBlockedReason !== null} onClick={() => void sendPayment()}>
              Send 0.10 Cash
            </Button>
          </div>
          {sendPaymentBlockedReason ? (
            <p className="text-sm text-destructive">Send 0.10 Cash is disabled: {sendPaymentBlockedReason}</p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Fund this Safe in the Circle faucet: {account?.safeAddress ?? "derive first"}. Do not fund the owner EOA with ETH.
          </p>
          <dl>
            <Field label="Chain" value="Base Sepolia / 84532" />
            <Field label="Cash token" value={`${CASH_USDC.diagnosticLabel} ${CASH_USDC.address}`} />
            <Field label="Safe" value={account?.safeAddress} />
            <Field label="Safe version" value={SAFE_POC.version} />
            <Field label="Module" value={`${SAFE_POC.module.version} ${SAFE_POC.module.address}`} />
            <Field label="EntryPoint" value={`${SAFE_POC.entryPoint.version} ${SAFE_POC.entryPoint.address}`} />
            <Field label="Deployed" value={safeDeployed} />
            <Field label="Owner ETH" value={balances ? formatEth(balances.ownerEth) : null} />
            <Field label="Safe ETH" value={balances ? formatEth(balances.safeEth) : null} />
            <Field label="Safe USDC" value={balances ? formatUsdcFromUnits(BigInt(balances.safeUsdc)) : null} />
            <Field label="Recipient USDC" value={balances?.recipientUsdc ? formatUsdcFromUnits(BigInt(balances.recipientUsdc)) : null} />
            <Field label="userOperationHash" value={pending?.userOperationHash} />
            <Field label="transactionHash" value={pending?.transactionHash} />
            <Field label="receipt" value={pending?.receiptStatus} />
            <Field label="status" value={pending?.status} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Gate 3 — recovery</CardTitle>
          <CardDescription>Reload restores public identity and pending hashes. It must not restore signing permission. No automatic resend.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy !== null || !pending?.userOperationHash} onClick={() => void reconcilePending()}>
              Reconcile pending
            </Button>
            <Button variant="outline" disabled={busy !== null || !account?.safeAddress} onClick={() => void loadHistory()}>
              Load USDC history
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => void snapshot("after-reload")}>
              Snapshot storage now
            </Button>
            <Button variant="outline" disabled={busy !== null || !pendingUnresolved} onClick={() => clearUnresolvedPayment()}>
              Clear unresolved payment
            </Button>
            <Button variant="outline" disabled={busy !== null || !simulationSource} onClick={() => simulateUnresolvedKnownHashAction()}>
              Simulate unresolved known-hash state
            </Button>
          </div>
          {pendingUnresolved ? (
            <p className="text-sm text-destructive">
              A payment is unresolved (status: {pending?.status}). Sending is blocked until you reconcile it by hash,
              confirm via USDC history above, or clear it here after manual review — clearing does not resend or touch
              the chain, it only stops tracking this record locally.
            </p>
          ) : null}
          {pending?.simulatedRecoveryOf ? (
            <p className="text-sm text-muted-foreground">
              This record originated as a DEV-ONLY local recovery simulation of confirmed operation {pending.simulatedRecoveryOf}.
              {pending.status === "confirmed"
                ? " Reconciliation restored its confirmed transaction and receipt."
                : " Its transactionHash/receipt were initially cleared locally; current status is shown above."}
              {" Creating the simulation made no Turnkey call, WebAuthn prompt, or submission."}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">Pending autoResend is always false. A timeout becomes unknown, not failed.</p>
          <ul className="space-y-1 text-sm">
            {history.map((item) => (
              <li key={item.id} className="font-mono text-xs">
                {item.status} amount={item.amountUsdc} userOp={item.userOperationHash ?? "—"} tx={item.transactionHash ?? "—"}
                {item.simulatedRecoveryOf ? ` [simulated recovery of ${item.simulatedRecoveryOf}]` : ""}
              </li>
            ))}
          </ul>
          <ul className="space-y-1 text-sm">
            {chainHistory.map((item, index) => (
              <li key={`${item.transactionHash ?? index}`} className="font-mono text-xs">
                {item.direction} {item.value} tx={item.transactionHash}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Storage key names only</CardTitle>
          <CardDescription>Values are never printed. HttpOnly cookies are documented separately because document.cookie cannot see them.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">Storage gate: {storageEval.failed ? "FAIL" : "no forbidden JS-accessible signing artifacts in named snapshots"}</p>
          {snapshots.map((item) => (
            <div key={item.at} className="rounded-lg border border-border p-3 text-xs">
              <p className="font-medium">{item.at}</p>
              <p>localStorage: {item.localStorage.join(", ") || "none"}</p>
              <p>sessionStorage: {item.sessionStorage.join(", ") || "none"}</p>
              <p>indexedDB: {item.indexedDB.join(", ") || "none"}</p>
              <p>JS cookies: {item.cookies.join(", ") || "none"}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Event log</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{log.join("\n") || "No events yet."}</pre>
          {busy ? <p className="mt-2 text-sm">Busy: {busy}</p> : null}
        </CardContent>
      </Card>
    </main>
  );
}

function formatEth(wei: string): string {
  const value = BigInt(wei);
  if (value === BigInt(0)) return "0";
  return `${value.toString()} wei`;
}
