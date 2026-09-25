"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Expander } from "@/components/shell/expander";
import { Note } from "@/components/shell/note";
import { RealPasskeysManager } from "@/components/real/real-passkeys-manager";
import { useHasRealAccountHydrated, useRealAccountStore } from "@/lib/stores/real-account-store";

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

  useEffect(() => {
    if (hasHydrated) void checkSession();
    // Only re-check when hydration first completes — not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasHydrated]);

  const busy = status === "checking-session" || status === "registering" || status === "logging-in";

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
        <Button variant="outline" className="h-11 w-full" disabled={busy} onClick={() => void logout()}>
          Sign out
        </Button>
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
