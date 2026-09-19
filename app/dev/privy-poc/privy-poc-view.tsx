"use client";

/**
 * Privy PoC — outer diagnostic view. DISPOSABLE.
 *
 * Privy is NOT initialised on mount. The page first captures a
 * BEFORE-PRIVY-INIT storage snapshot, then mounts the vendor bridge only when
 * the developer clicks "Initialize Privy". That makes the before/after storage
 * comparison honest and keeps the SDK completely inert until asked.
 */
import { Component, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC_ADDRESS,
  USDC_DECIMALS,
  type ConfigValidation,
} from "@/lib/poc/privy/config";
import { PrivyPocProvider } from "@/lib/poc/privy/privy-bridge";
import {
  captureStorageSnapshot,
  classifySnapshot,
  evaluateSecurityGate,
  type StorageSnapshot,
} from "@/lib/poc/privy/storage-audit";
import { PocDiagnostics } from "./poc-diagnostics";
import { GateView, Row, Section, SnapshotView, Verdict } from "./poc-ui";
import { SDK_STATIC_SECURITY_RESULT, SELECTED_ARCHITECTURE } from "@/lib/poc/privy/sdk-static";

/**
 * A vendor SDK that throws during mount must show up as a finding on this
 * page, not as a blank screen. Error messages are shown; they come from the
 * SDK/React, never from stored credentials.
 */
class PocErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <Section title="Privy failed to initialise">
          <div className="rounded border border-red-400/40 p-3 text-sm space-y-1">
            <div className="font-mono text-red-400 break-words">{this.state.error.name}: {this.state.error.message}</div>
            <p className="text-muted-foreground">
              Reload the page to retry. Typical causes: an app ID that does not exist, this origin not being in the
              Privy app&apos;s allowed origins, or a login method not enabled in the dashboard.
            </p>
          </div>
        </Section>
      );
    }
    return this.props.children;
  }
}

export function PrivyPocView({ validation }: { validation: ConfigValidation }) {
  const [initialized, setInitialized] = useState(false);
  const [beforeInit, setBeforeInit] = useState<StorageSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    captureStorageSnapshot("BEFORE PRIVY INIT").then((snap) => {
      if (!cancelled) setBeforeInit(snap);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Bottom padding clears the shell's fixed mobile tab bar.
  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 p-4 pb-28">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">Privy proof-of-concept (developer diagnostic)</h1>
        <p className="text-sm text-muted-foreground">
          Disposable evaluation of Privy for the Phase 2 real-account foundation. Testnet only. This page
          never displays credential values — storage is reported by key name only.
        </p>
      </header>

      <Section title="Fixed configuration">
        <Row label="Network" value={`Base Sepolia (chain id ${BASE_SEPOLIA_CHAIN_ID})`} />
        <Row label="Cash (USDC) contract" value={BASE_SEPOLIA_USDC_ADDRESS} mono />
        <Row label="USDC decimals" value={USDC_DECIMALS} />
        {validation.ok ? (
          <>
            <Row label="Privy app id (public)" value={validation.config.appId} mono />
            <Row label="Privy client id (public)" value={validation.config.clientId ?? "(not set)"} mono />
            <Row label="Read RPC" value={new URL(validation.config.rpcUrl).host} mono />
          </>
        ) : (
          <div className="rounded border border-amber-400/40 p-3 text-sm space-y-1">
            <div className="font-semibold text-amber-400">Configuration incomplete — Privy will not be initialised.</div>
            <ul className="list-disc pl-5">
              {validation.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Set the values in <code>.env.local</code> (see <code>.env.example</code>) and restart <code>next dev</code>.
            </p>
          </div>
        )}
      </Section>

      <Section title="Static SDK security">
        <div className="flex items-center gap-2 text-sm">
          <span>SDK static verdict:</span>
          <Verdict result={SDK_STATIC_SECURITY_RESULT} />
        </div>
        <Row label="Selected architecture" value={SELECTED_ARCHITECTURE} />
        <p className="text-sm text-muted-foreground">
          Installed <code>@privy-io/js-sdk-core</code> always writes access and refresh tokens to localStorage. Cookie
          mode only skips the JS-readable cookie mirror. Live login will confirm the keys; it cannot make this PASS.
        </p>
      </Section>

      {!initialized ? (
        <>
          <Section title="Storage before Privy initialisation">
            {beforeInit ? (
              <>
                <SnapshotView snapshot={beforeInit} classifications={classifySnapshot(beforeInit)} />
                <GateView
                  gate={evaluateSecurityGate(beforeInit, {
                    authenticated: false,
                    isLocalhost: beforeInit.origin.startsWith("http://localhost"),
                  })}
                />
              </>
            ) : (
              <div className="text-sm text-muted-foreground">Capturing…</div>
            )}
          </Section>
          <Section title="Initialise">
            <p className="text-sm text-muted-foreground">
              Mounting the Privy provider loads the SDK, fetches app configuration, opens the embedded-wallet iframe, and
              attempts to restore any existing session. On a reload/restart test, click this and observe whether the same
              account comes back without re-authenticating.
            </p>
            <Button disabled={!validation.ok || !beforeInit} onClick={() => setInitialized(true)}>
              Initialize Privy
            </Button>
          </Section>
        </>
      ) : validation.ok && beforeInit ? (
        <PocErrorBoundary>
          <PrivyPocProvider config={validation.config}>
            <PocDiagnostics config={validation.config} beforeInit={beforeInit} />
          </PrivyPocProvider>
        </PocErrorBoundary>
      ) : null}
    </main>
  );
}
