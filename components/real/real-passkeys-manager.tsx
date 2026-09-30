"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { passkeyDisplayName } from "@/lib/real/display/passkey-name";
import {
  BACKUP_PASSKEY_EXPLANATION,
  BACKUP_REMOVAL_PENDING_NOTE,
  EQUAL_AUTHORITY_NOTE,
  MAY_STILL_AUTHORIZE_NOTE,
  SETUP_INCOMPLETE_NOTE,
  SETUP_NEEDS_REVIEW_NOTE,
  TOTAL_LOSS_NOTE,
  mayStillAuthorize,
  passkeyDisplayState,
  passkeyRoleLabel,
  passkeyStateLabel,
} from "@/lib/real/display/passkey-status";
import { useRealAccountStore } from "@/lib/stores/real-account-store";
import { useRealPasskeysStore, type RealPasskeySummary } from "@/lib/stores/real-passkeys-store";

/**
 * Truthful, minimal passkey management. Revoked passkeys are history, not
 * managed credentials, and never render here. A passkey whose Turnkey removal
 * isn't confirmed is never shown as removed, and always carries the
 * "may still authorize" note. Reuses only existing primitives — no new
 * visual-identity decisions.
 */
export function RealPasskeysManager() {
  const appUserId = useRealAccountStore((s) => s.account?.appUserId ?? null);
  const bindAccount = useRealPasskeysStore((s) => s.bindAccount);
  const allPasskeys = useRealPasskeysStore((s) => s.passkeys);
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
  const renameBusyCredentialId = useRealPasskeysStore((s) => s.renameBusyCredentialId);
  const renameError = useRealPasskeysStore((s) => s.renameError);
  const renamePasskey = useRealPasskeysStore((s) => s.renamePasskey);
  const clearRenameError = useRealPasskeysStore((s) => s.clearRenameError);

  const [confirmingRemoval, setConfirmingRemoval] = useState<RealPasskeySummary | null>(null);
  const [editing, setEditing] = useState<{ credentialId: string; value: string } | null>(null);

  function stopEditing() {
    setEditing(null);
    clearRenameError();
  }

  async function saveRename() {
    if (!editing) return;
    if (await renamePasskey(editing.credentialId, editing.value)) setEditing(null);
  }

  useEffect(() => {
    // S4: bind first — a different account resets the store (dropping any
    // late response or in-flight flow from the previous one) before loading.
    // Re-runs only when the signed-in account changes; the store's own
    // actions refresh after they complete.
    bindAccount(appUserId);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appUserId]);

  // The server already omits revoked (history-only) passkeys; filtered here too so they can never render.
  const passkeys = allPasskeys.filter((p) => p.status !== "revoked");
  const activeCount = passkeys.filter((p) => p.status === "active").length;
  const busy = setupBusy || removalBusyCredentialId !== null || renameBusyCredentialId !== null;
  const detachedRemovalMessage = removalMessage && !passkeys.some((p) => p.credentialId === removalMessage.credentialId) ? removalMessage.text : null;

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
          const state = passkeyDisplayState({ status: passkey.status, removalState: passkey.removal?.state ?? null, walletAccess: passkey.walletAccess });
          const rowBusy = removalBusyCredentialId === passkey.credentialId;
          const isEditing = editing?.credentialId === passkey.credentialId;
          const renaming = renameBusyCredentialId === passkey.credentialId;
          const awaitingMyAuthorization = passkey.removal?.state === "authorization_needed" && passkey.removal.ownedBySession;
          // An incomplete setup that already has wallet access is removable by
          // the (active) passkey this browser is signed in with.
          const canRemove =
            !awaitingMyAuthorization &&
            (((state === "active" || state === "removal_not_authorized") && !passkey.isCurrentSession && activeCount > 1) || state === "setup_incomplete");
          // 2g-H: a removal that blocked can be tried again — a fresh approval, never automatic.
          const canRetryRemoval = !awaitingMyAuthorization && state === "removal_needs_review" && !passkey.isCurrentSession;
          return (
            <li key={passkey.credentialId} className="flex flex-col gap-2 rounded-xl bg-muted/60 px-4 py-3" data-testid="real-passkey-row">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  {isEditing ? (
                    <form
                      className="flex items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveRename();
                      }}
                    >
                      <Input
                        aria-label="Passkey name"
                        autoFocus
                        value={editing?.value ?? ""}
                        disabled={renaming}
                        onChange={(event) => setEditing({ credentialId: passkey.credentialId, value: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") stopEditing();
                        }}
                      />
                      <Button type="submit" size="sm" disabled={renaming}>
                        {renaming ? "Saving…" : "Save"}
                      </Button>
                      <Button type="button" variant="ghost" size="sm" disabled={renaming} onClick={stopEditing}>
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <span className="truncate text-sm font-medium">
                      {passkeyDisplayName(passkey)}
                      {passkey.isCurrentSession ? " (signed in)" : ""}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {passkey.displayName ? `${passkeyRoleLabel(passkey.role)} · ${passkeyStateLabel(state)}` : passkeyStateLabel(state)}
                  </span>
                </div>
                {!isEditing && (passkey.status === "active" || canRemove || canRetryRemoval) ? (
                  <div className="flex shrink-0 gap-1">
                    {passkey.status === "active" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          clearRenameError();
                          setEditing({ credentialId: passkey.credentialId, value: passkey.displayName ?? "" });
                        }}
                      >
                        Rename
                      </Button>
                    ) : null}
                    {canRemove ? (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmingRemoval(passkey)}>
                        Remove
                      </Button>
                    ) : null}
                    {canRetryRemoval ? (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmingRemoval(passkey)}>
                        Try removal again
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {renameError?.credentialId === passkey.credentialId ? <p className="text-xs text-destructive">{renameError.text}</p> : null}
              {state === "active" && passkey.isCurrentSession && activeCount > 1 ? (
                <p className="text-xs text-muted-foreground">To remove this passkey, sign in with a different one.</p>
              ) : null}
              {mayStillAuthorize(state) ? <p className="text-xs text-muted-foreground">{MAY_STILL_AUTHORIZE_NOTE}</p> : null}
              {state === "setup_incomplete" ? <p className="text-xs text-muted-foreground">{SETUP_INCOMPLETE_NOTE}</p> : null}
              {state === "setup_needs_review" ? <p className="text-xs text-muted-foreground">{SETUP_NEEDS_REVIEW_NOTE}</p> : null}
              {removalMessage?.credentialId === passkey.credentialId ? <p className="text-xs text-muted-foreground">{removalMessage.text}</p> : null}
              {passkey.removal && awaitingMyAuthorization && (state === "removal_not_authorized" || state === "setup_incomplete" || state === "removal_needs_review") ? (
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

      {detachedRemovalMessage ? <p className="text-xs text-muted-foreground">{detachedRemovalMessage}</p> : null}
      {removalError ? <p className="text-sm text-destructive">{removalError}</p> : null}

      {enrollment?.state === "removal_in_progress" ? (
        <p className="text-xs text-muted-foreground">{BACKUP_REMOVAL_PENDING_NOTE}</p>
      ) : enrollment ? (
        <div className="flex flex-col gap-2">
          {/* A setup under review never sends a new authorization — "Check" only re-reads whether it went through. */}
          <Button variant="outline" className="h-11 w-full" disabled={busy} onClick={() => void continueBackupSetup()}>
            {setupBusy ? (setupMessage ?? "Working…") : enrollment.state === "blocked" ? "Check backup setup again" : "Resume backup passkey setup"}
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
            <AlertDialogTitle>{confirmingRemoval ? `Remove “${passkeyDisplayName(confirmingRemoval)}”?` : "Remove this passkey?"}</AlertDialogTitle>
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
