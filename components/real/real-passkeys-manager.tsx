"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import {
  BACKUP_PASSKEY_EXPLANATION,
  EQUAL_AUTHORITY_NOTE,
  MAY_STILL_AUTHORIZE_NOTE,
  TOTAL_LOSS_NOTE,
  mayStillAuthorize,
  passkeyDisplayState,
  passkeyRoleLabel,
  passkeyStateLabel,
} from "@/lib/real/display/passkey-status";
import { useRealPasskeysStore, type RealPasskeySummary } from "@/lib/stores/real-passkeys-store";

/**
 * Truthful, minimal passkey management. A passkey whose Turnkey removal
 * isn't confirmed is never shown as removed, and always carries the
 * "may still authorize" note. Reuses only existing primitives — no new
 * visual-identity decisions.
 */
export function RealPasskeysManager() {
  const passkeys = useRealPasskeysStore((s) => s.passkeys);
  const enrollment = useRealPasskeysStore((s) => s.enrollment);
  const listStatus = useRealPasskeysStore((s) => s.listStatus);
  const listError = useRealPasskeysStore((s) => s.listError);
  const setupBusy = useRealPasskeysStore((s) => s.setupBusy);
  const setupMessage = useRealPasskeysStore((s) => s.setupMessage);
  const setupError = useRealPasskeysStore((s) => s.setupError);
  const removalBusyCredentialId = useRealPasskeysStore((s) => s.removalBusyCredentialId);
  const removalMessage = useRealPasskeysStore((s) => s.removalMessage);
  const removalError = useRealPasskeysStore((s) => s.removalError);
  const refresh = useRealPasskeysStore((s) => s.refresh);
  const continueBackupSetup = useRealPasskeysStore((s) => s.continueBackupSetup);
  const abandonBackupSetup = useRealPasskeysStore((s) => s.abandonBackupSetup);
  const removePasskey = useRealPasskeysStore((s) => s.removePasskey);
  const checkRemoval = useRealPasskeysStore((s) => s.checkRemoval);
  const cancelRemoval = useRealPasskeysStore((s) => s.cancelRemoval);

  const [confirmingRemoval, setConfirmingRemoval] = useState<RealPasskeySummary | null>(null);

  useEffect(() => {
    void refresh();
    // Only on mount — the store's own actions refresh after they complete.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeCount = passkeys.filter((p) => p.status === "active").length;
  const busy = setupBusy || removalBusyCredentialId !== null;

  return (
    <div className="flex flex-col gap-3" data-testid="real-passkeys-manager">
      <div className="flex flex-col gap-1">
        <h3 className="font-heading text-sm font-medium">Passkeys</h3>
        <p className="text-xs text-muted-foreground">{BACKUP_PASSKEY_EXPLANATION}</p>
        <p className="text-xs text-muted-foreground">{EQUAL_AUTHORITY_NOTE}</p>
        <p className="text-xs text-muted-foreground">{TOTAL_LOSS_NOTE}</p>
      </div>

      {listStatus === "loading" && passkeys.length === 0 ? <div aria-busy="true" aria-label="Loading" className="h-16 animate-pulse rounded-xl bg-muted/60" /> : null}
      {listStatus === "error" ? <p className="text-sm text-destructive">{listError}</p> : null}

      <ul className="flex flex-col gap-2">
        {passkeys.map((passkey) => {
          const state = passkeyDisplayState({ status: passkey.status, removalState: passkey.removal?.state ?? null });
          const rowBusy = removalBusyCredentialId === passkey.credentialId;
          return (
            <li key={passkey.credentialId} className="flex flex-col gap-2 rounded-xl bg-muted/60 px-4 py-3" data-testid="real-passkey-row">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    {passkeyRoleLabel(passkey.role)}
                    {passkey.isCurrentSession ? " (signed in)" : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">{passkeyStateLabel(state)}</span>
                </div>
                {(state === "active" || state === "removal_not_authorized") && !passkey.isCurrentSession && activeCount > 1 && !passkey.removal?.ownedBySession ? (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmingRemoval(passkey)}>
                    Remove
                  </Button>
                ) : null}
              </div>
              {state === "active" && passkey.isCurrentSession && activeCount > 1 ? (
                <p className="text-xs text-muted-foreground">To remove this passkey, sign in with a different one.</p>
              ) : null}
              {mayStillAuthorize(state) ? <p className="text-xs text-muted-foreground">{MAY_STILL_AUTHORIZE_NOTE}</p> : null}
              {removalMessage?.credentialId === passkey.credentialId ? <p className="text-xs text-muted-foreground">{removalMessage.text}</p> : null}
              {passkey.removal && state === "removal_not_authorized" && passkey.removal.ownedBySession ? (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void removePasskey(passkey.credentialId)}>
                    Authorize removal
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void cancelRemoval(passkey.credentialId, passkey.removal!.attemptId)}>
                    Cancel removal
                  </Button>
                </div>
              ) : null}
              {passkey.removal && state === "removal_submitted" ? (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void checkRemoval(passkey.credentialId, passkey.removal!.attemptId)}>
                  {rowBusy ? "Checking…" : "Check removal status"}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {removalError ? <p className="text-sm text-destructive">{removalError}</p> : null}

      {enrollment ? (
        <div className="flex flex-col gap-2">
          <Button variant="outline" className="h-11 w-full" disabled={busy} onClick={() => void continueBackupSetup()}>
            {setupBusy ? (setupMessage ?? "Working…") : "Resume backup passkey setup"}
          </Button>
          {enrollment.abandonable ? (
            <Button variant="ghost" className="h-11 w-full" disabled={busy} onClick={() => void abandonBackupSetup()}>
              Cancel setup
            </Button>
          ) : null}
        </div>
      ) : activeCount < 2 && listStatus === "ready" ? (
        <Button variant="outline" className="h-11 w-full" disabled={busy} onClick={() => void continueBackupSetup()}>
          {setupBusy ? (setupMessage ?? "Working…") : "Add a backup passkey"}
        </Button>
      ) : null}
      {!setupBusy && setupMessage ? <p className="text-xs text-muted-foreground">{setupMessage}</p> : null}
      {setupError ? <p className="text-sm text-destructive">{setupError}</p> : null}

      <AlertDialog
        open={confirmingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingRemoval(null);
        }}
      >
        <AlertDialogContent>
          <div className="flex flex-col gap-2">
            <AlertDialogTitle>Remove this passkey?</AlertDialogTitle>
            <AlertDialogDescription>
              You&apos;ll approve this with the passkey you&apos;re signed in with. Nothing changes until you do. Once approved, sign-in with the removed passkey stops right away, but {MAY_STILL_AUTHORIZE_NOTE.charAt(0).toLowerCase() + MAY_STILL_AUTHORIZE_NOTE.slice(1)}
            </AlertDialogDescription>
          </div>
          <div className="flex flex-col gap-2">
            <Button
              variant="destructive"
              className="h-11 w-full"
              onClick={() => {
                const target = confirmingRemoval;
                setConfirmingRemoval(null);
                if (target) void removePasskey(target.credentialId);
              }}
            >
              Remove
            </Button>
            <Button variant="ghost" className="h-11 w-full" onClick={() => setConfirmingRemoval(null)}>
              Cancel
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
