"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ACCOUNT_DISPLAY_NAME_MAX_LENGTH } from "@/lib/real/display/account-name";
import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH, canonicalizeHandle, formatHandle } from "@/lib/real/handle";
import { useRealAccountStore } from "@/lib/stores/real-account-store";

export const HANDLE_PERMANENCE_WARNING = "This is how people will find you to pay you. You can't change it later.";
export const HANDLE_RULES = `${HANDLE_MIN_LENGTH}–${HANDLE_MAX_LENGTH} characters. Letters a–z, numbers, and underscores. Start with a letter.`;

/**
 * The account's human-readable identity: an optional display name and a
 * permanent @name. Both are labels — neither signs in, authorizes, or moves
 * anything, and an account without them works exactly the same. Choosing an
 * @name is skippable and asks for the passkey once, because it can't be
 * changed afterward. Reuses only existing primitives — no new
 * visual-identity decisions.
 */
export function AccountIdentity() {
  const account = useRealAccountStore((s) => s.account);
  const profileBusy = useRealAccountStore((s) => s.profileBusy);
  const profileError = useRealAccountStore((s) => s.profileError);
  const clearProfileError = useRealAccountStore((s) => s.clearProfileError);
  const claimHandle = useRealAccountStore((s) => s.claimHandle);
  const saveDisplayName = useRealAccountStore((s) => s.saveDisplayName);

  const [mode, setMode] = useState<"idle" | "claiming" | "naming">("idle");
  const [skipped, setSkipped] = useState(false);
  const [handleInput, setHandleInput] = useState("");
  const [confirmInput, setConfirmInput] = useState("");
  const [nameInput, setNameInput] = useState("");

  if (!account) return null;
  const handle = account.handle ?? null;
  const displayName = account.displayName ?? null;

  const canonical = canonicalizeHandle(handleInput);
  const confirmation = canonicalizeHandle(confirmInput);
  const entriesMatch = canonical.ok && confirmation.ok && canonical.handle === confirmation.handle;

  function close() {
    setMode("idle");
    setHandleInput("");
    setConfirmInput("");
    clearProfileError();
  }

  /**
   * Editing either entry makes any message about the PREVIOUS attempt stale ("That name isn't
   * available" must not sit beside a different name). Purely local state: no request is made.
   * Only the error is cleared — the fields, the form, and the busy flag are untouched.
   */
  function editHandleEntry(setter: (value: string) => void, value: string) {
    setter(value);
    if (profileError) clearProfileError();
  }

  async function submitClaim() {
    if (!canonical.ok || !entriesMatch) return;
    if (await claimHandle(canonical.handle)) close();
  }

  async function submitName() {
    if (await saveDisplayName(nameInput)) close();
  }

  return (
    <div className="flex flex-col gap-3" data-testid="real-account-identity">
      {mode !== "naming" ? (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/60 px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="truncate text-sm font-medium" data-testid="real-account-display-name">
              {displayName ?? (handle ? formatHandle(handle) : "No name yet")}
            </p>
            {displayName && handle ? (
              <p className="truncate text-xs text-muted-foreground" data-testid="real-account-handle">
                {formatHandle(handle)}
              </p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={profileBusy || mode !== "idle"}
            onClick={() => {
              clearProfileError();
              setNameInput(displayName ?? "");
              setMode("naming");
            }}
          >
            {displayName ? "Edit name" : "Add your name"}
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2 rounded-xl bg-muted/60 px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submitName();
          }}
        >
          <Label htmlFor="real-account-name">Your name</Label>
          <Input id="real-account-name" value={nameInput} maxLength={ACCOUNT_DISPLAY_NAME_MAX_LENGTH * 2} autoFocus disabled={profileBusy} onChange={(event) => setNameInput(event.target.value)} />
          <p className="text-xs text-muted-foreground">Shown next to your @name. You can change it any time, or leave it empty.</p>
          {profileError ? <p className="text-xs text-destructive">{profileError}</p> : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={profileBusy}>
              {profileBusy ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={profileBusy} onClick={close}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {handle === null && mode === "idle" && !skipped ? (
        <div className="flex flex-col gap-2 rounded-xl px-4 py-3.5 ring-1 ring-foreground/10" data-testid="real-handle-card">
          <p className="text-sm font-medium">Choose your @name</p>
          <p className="text-sm text-muted-foreground">A short name people can use to find you, instead of a long account address. You can do this later.</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={profileBusy}
              onClick={() => {
                clearProfileError();
                setMode("claiming");
              }}
            >
              Choose a name
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSkipped(true)}>
              Not now
            </Button>
          </div>
        </div>
      ) : null}

      {handle === null && mode === "claiming" ? (
        <form
          className="flex flex-col gap-3 rounded-xl px-4 py-3.5 ring-1 ring-foreground/10"
          data-testid="real-handle-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitClaim();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="real-handle">Choose your @name</Label>
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true" className="text-sm text-muted-foreground">
                @
              </span>
              <Input id="real-handle" value={handleInput} autoFocus autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={profileBusy} onChange={(event) => editHandleEntry(setHandleInput, event.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground">{HANDLE_RULES}</p>
            {handleInput.trim() !== "" && !canonical.ok ? <p className="text-xs text-destructive">{canonical.reason}</p> : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="real-handle-confirm">Type it again</Label>
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true" className="text-sm text-muted-foreground">
                @
              </span>
              <Input id="real-handle-confirm" value={confirmInput} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={profileBusy} onChange={(event) => editHandleEntry(setConfirmInput, event.target.value)} />
            </div>
            {canonical.ok && confirmInput.trim() !== "" && !entriesMatch ? <p className="text-xs text-destructive">The two names don&apos;t match.</p> : null}
          </div>
          <p className="text-sm font-medium">{HANDLE_PERMANENCE_WARNING}</p>
          {profileError ? <p className="text-sm text-destructive">{profileError}</p> : null}
          {/* The last thing read before the passkey prompt, which can't show the name itself: the exact canonical value the claim will submit. */}
          {entriesMatch && canonical.ok ? (
            <div className="flex flex-col gap-1 rounded-lg bg-muted px-3.5 py-3" data-testid="real-handle-summary">
              <p className="text-base font-semibold text-foreground">
                Your name will be <span data-testid="real-handle-summary-handle">{formatHandle(canonical.handle)}</span>
              </p>
              <p className="text-xs text-muted-foreground">You&apos;ll confirm with your passkey.</p>
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <Button type="submit" className="h-11 w-full" disabled={profileBusy || !entriesMatch}>
              {profileBusy ? "Confirming…" : "Confirm with passkey"}
            </Button>
            <Button type="button" variant="ghost" className="h-11 w-full" disabled={profileBusy} onClick={close}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
