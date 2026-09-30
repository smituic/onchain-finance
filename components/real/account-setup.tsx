"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Expander } from "@/components/shell/expander";
import { Note } from "@/components/shell/note";
import { RealPasskeysManager } from "@/components/real/real-passkeys-manager";
import { useHasRealAccountHydrated, useRealAccountStore } from "@/lib/stores/real-account-store";
import { useRealPasskeysStore } from "@/lib/stores/real-passkeys-store";

/**
 * The one place Real Mode's account create/restore UX lives — reused by
 * RealHomeView and RealPayView. A valid app session (shown here) never
 * implies signing authority: nothing on this screen can move money: every
 * real payment triggers its own fresh Turnkey WebAuthn ceremony separately
 * (Batch 2d), unrelated to the app-login ceremony this screen performs.
 */
export function AccountSetup() {
  const hasHydrated = useHasRealAccountHydrated();
  const account = useRealAccountStore((s) => s.account);
  const status = useRealAccountStore((s) => s.status);
  const error = useRealAccountStore((s) => s.error);
  const checkSession = useRealAccountStore((s) => s.checkSession);
  const register = useRealAccountStore((s) => s.register);
  const login = useRealAccountStore((s) => s.login);
  const logout = useRealAccountStore((s) => s.logout);
  const bindPasskeysAccount = useRealPasskeysStore((s) => s.bindAccount);

  useEffect(() => {
    if (hasHydrated) void checkSession();
    // Only re-check when hydration first completes — not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasHydrated]);

  useEffect(() => {
    // Signed out: RealPasskeysManager unmounts, so the passkey list is
    // cleared here (the manager itself binds the next account on mount).
    if (!account) bindPasskeysAccount(null);
  }, [account, bindPasskeysAccount]);

  const busy = status === "checking-session" || status === "registering" || status === "logging-in" || status === "signing-out";

  if (!hasHydrated || status === "checking-session" || status === "idle") {
    return <div aria-busy="true" aria-label="Loading" className="h-24 animate-pulse rounded-xl bg-muted/60" />;
  }

  if (account) {
    return (
      <div className="flex flex-col gap-3" data-testid="real-account-connected">
        <Note title="Your account is connected">
          <p>Testnet only — this account holds no real money.</p>
        </Note>
        <Expander question="See account details">
          <p>Owner address: {account.ownerAddress}</p>
          <p>Safe address: {account.safeAddress}</p>
        </Expander>
        <RealPasskeysManager />
        <div className="flex flex-col gap-2">
          <Button variant="outline" className="h-11 w-full" disabled={busy} onClick={() => void logout()}>
            {status === "signing-out" ? "Signing out everywhere…" : "Sign out everywhere"}
          </Button>
          <p className="text-xs text-muted-foreground">Signs this account out on this device and on every other device where it&apos;s signed in.</p>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="real-account-setup">
      <Button className="h-11 w-full" disabled={busy} onClick={() => void register()}>
        Create your account
      </Button>
      <Button variant="outline" className="h-11 w-full" disabled={busy} onClick={() => void login()}>
        I already have an account
      </Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
