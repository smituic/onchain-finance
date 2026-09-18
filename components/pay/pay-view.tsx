"use client";

import { useState } from "react";
import {
  getAssetValueMicroUsd,
  PAY_CONTACT_IDS,
  PAY_CONTACTS,
  PRACTICE_HANDLE,
  type PayContactId,
} from "@/simulation";
import { useHasSimulationHydrated, useSimulationStore } from "@/lib/stores/simulation-store";
import { parseAmountToMicroUnits } from "@/lib/parse-amount";
import { formatSignedUsd, formatUsd } from "@/lib/format";
import { payActivityLabel, signedPayActivityAmount } from "@/lib/pay-activity";
import { PRODUCT_AREAS_BY_ID } from "@/lib/product-areas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/shell/page-header";
import { Note } from "@/components/shell/note";
import { Expander } from "@/components/shell/expander";
import { cn } from "@/lib/utils";

type PayMode = "send" | "receive" | "request" | "deposit" | "withdraw";

const MODE_COPY: Record<
  PayMode,
  { actionLabel: string; contactLabel?: string; amountHint: (cashMicroUsd: number) => string }
> = {
  send: { actionLabel: "Send money", contactLabel: "To", amountHint: (cash) => `${formatUsd(cash)} available` },
  receive: { actionLabel: "Receive", contactLabel: "From", amountHint: () => "Simulated incoming payment" },
  request: { actionLabel: "Request", contactLabel: "From", amountHint: () => "Not charged yet" },
  deposit: { actionLabel: "Add money", amountHint: () => "From Practice bank" },
  withdraw: { actionLabel: "Withdraw", amountHint: (cash) => `${formatUsd(cash)} available` },
};

function needsContact(mode: PayMode): boolean {
  return mode === "send" || mode === "receive" || mode === "request";
}

function needsNote(mode: PayMode): boolean {
  return mode === "send" || mode === "request";
}

export function PayView() {
  const state = useSimulationStore((s) => s.state);
  const dispatch = useSimulationStore((s) => s.dispatch);
  const hasHydrated = useHasSimulationHydrated();
  const area = PRODUCT_AREAS_BY_ID.pay;

  const [mode, setMode] = useState<PayMode | null>(null);
  const [contactId, setContactId] = useState<PayContactId | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  const cashMicroUsd = getAssetValueMicroUsd(state, "USDC");
  const pendingRequests = state.pay.requests.filter((request) => request.status === "pending").slice().reverse();
  const activity = state.pay.activity.slice().reverse();

  function openForm(next: PayMode) {
    setMode(next);
    setContactId(null);
    setAmountInput("");
    setNoteInput("");
    setError(null);
    setReceipt(null);
  }

  function closeForm() {
    setMode(null);
    setContactId(null);
    setAmountInput("");
    setNoteInput("");
    setError(null);
  }

  function submitForm(event: React.FormEvent) {
    event.preventDefault();
    if (!mode) return;

    if (needsContact(mode) && !contactId) {
      setError("Choose a contact.");
      return;
    }

    const amount = parseAmountToMicroUnits(amountInput);
    if (amount === null || amount <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }

    const note = noteInput.trim() || undefined;
    const result = dispatch(
      mode === "send"
        ? { type: "send-payment", contactId: contactId as PayContactId, amount, note }
        : mode === "receive"
          ? { type: "receive-payment", contactId: contactId as PayContactId, amount, note }
          : mode === "request"
            ? { type: "create-payment-request", contactId: contactId as PayContactId, amount, note }
            : mode === "deposit"
              ? { type: "deposit-cash", amount }
              : { type: "withdraw-cash", amount },
    );

    if (!result.ok) {
      setError(result.error);
      return;
    }

    const contactName = contactId ? PAY_CONTACTS[contactId].displayName : "";
    setReceipt(
      mode === "send"
        ? `Sent ${formatUsd(amount)} to ${contactName}.`
        : mode === "receive"
          ? `Received ${formatUsd(amount)} from ${contactName}.`
          : mode === "request"
            ? `Requested ${formatUsd(amount)} from ${contactName}.`
            : mode === "deposit"
              ? `Added ${formatUsd(amount)} of Cash.`
              : `Withdrew ${formatUsd(amount)} of Cash.`,
    );
    closeForm();
  }

  function completeRequest(requestId: string) {
    const result = dispatch({ type: "complete-payment-request", requestId });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const contactName = result.paymentRequest ? PAY_CONTACTS[result.paymentRequest.contactId].displayName : "";
    setError(null);
    setReceipt(`${formatUsd(result.paymentRequest?.amountMicroUsd ?? 0)} arrived from ${contactName}.`);
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={area.label} purpose={area.purpose} />

      <section className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">Cash available</p>
        {hasHydrated ? (
          <p
            className="font-heading text-4xl leading-none font-semibold tracking-tight tabular-nums"
            data-testid="pay-cash-headline"
          >
            {formatUsd(cashMicroUsd)}
          </p>
        ) : (
          <div aria-hidden="true" className="h-10 w-44 animate-pulse rounded-lg bg-muted" />
        )}
      </section>

      {receipt ? (
        <p className="text-sm text-foreground" role="status">
          {receipt}
        </p>
      ) : null}

      {mode ? (
        <PayForm
          mode={mode}
          contactId={contactId}
          amountInput={amountInput}
          noteInput={noteInput}
          error={error}
          cashMicroUsd={cashMicroUsd}
          onContactChange={(id) => {
            setContactId(id);
            setError(null);
          }}
          onAmountChange={(value) => {
            setAmountInput(value);
            setError(null);
          }}
          onNoteChange={setNoteInput}
          onSubmit={submitForm}
          onCancel={closeForm}
        />
      ) : (
        <section className="flex flex-col gap-2">
          <Button size="lg" className="h-12 w-full" onClick={() => openForm("send")} disabled={cashMicroUsd <= 0}>
            Send money
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" className="h-11" onClick={() => openForm("receive")}>
              Receive
            </Button>
            <Button variant="outline" className="h-11" onClick={() => openForm("request")}>
              Request
            </Button>
            <Button variant="ghost" className="h-11" onClick={() => openForm("deposit")}>
              Add money
            </Button>
            <Button
              variant="ghost"
              className="h-11"
              onClick={() => openForm("withdraw")}
              disabled={cashMicroUsd <= 0}
            >
              Withdraw
            </Button>
          </div>
        </section>
      )}

      {pendingRequests.length > 0 ? (
        <section className="flex flex-col gap-3" aria-labelledby="requests-heading">
          <h2 id="requests-heading" className="font-heading text-sm font-medium">
            Requests
          </h2>
          <ul className="flex flex-col gap-2">
            {pendingRequests.map((request) => (
              <li
                key={request.id}
                data-testid={`request-${request.id}`}
                className="flex items-center justify-between gap-4 rounded-xl bg-muted/60 px-4 py-3.5"
              >
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    {formatUsd(request.amountMicroUsd)} from {PAY_CONTACTS[request.contactId].displayName}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {request.note ? request.note : "Request sent"}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  onClick={() => completeRequest(request.id)}
                >
                  Simulate {PAY_CONTACTS[request.contactId].displayName} paying
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-3" aria-labelledby="pay-activity-heading">
        <h2 id="pay-activity-heading" className="font-heading text-sm font-medium">
          Pay activity
        </h2>
        {activity.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {activity.map((entry) => (
              <li
                key={entry.id}
                data-testid={`activity-${entry.id}`}
                className="flex items-center justify-between gap-4 rounded-xl bg-muted/60 px-4 py-3.5"
              >
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{payActivityLabel(entry)}</span>
                  {entry.note ? <span className="text-xs text-muted-foreground">{entry.note}</span> : null}
                </span>
                <span className="shrink-0 text-sm font-medium tabular-nums">
                  {formatSignedUsd(signedPayActivityAmount(entry))}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border px-6 py-10 text-center">
            <p className="text-sm font-medium">No activity yet</p>
            <p className="text-sm text-muted-foreground">
              Money you send, receive, or move in Practice Mode will show up here.
            </p>
          </div>
        )}
      </section>

      <Note title="Where is the blockchain?">
        <p>
          You&apos;re just moving money. In a future Real Mode, blockchain and payment infrastructure can sit
          underneath this experience rather than becoming a chore you manage yourself.
        </p>
        <div className="mt-3">
          <Expander question="Would I need a wallet address or gas?">
            <p>
              Not to use the product day to day. Normal users should be able to send and receive with names or
              handles, the way you just did here — wallet and smart-account infrastructure can exist underneath,
              out of sight. Ideas like transaction simulation, account recovery, permissions, gas abstraction, and
              chain abstraction can hide that plumbing, while advanced users who want to inspect the technical
              details can always find them.
            </p>
            <p>
              To be precise: Practice Mode doesn&apos;t send blockchain transactions today — everything here is
              simulated.
            </p>
          </Expander>
        </div>
      </Note>
    </div>
  );
}

function PayForm({
  mode,
  contactId,
  amountInput,
  noteInput,
  error,
  cashMicroUsd,
  onContactChange,
  onAmountChange,
  onNoteChange,
  onSubmit,
  onCancel,
}: {
  mode: PayMode;
  contactId: PayContactId | null;
  amountInput: string;
  noteInput: string;
  error: string | null;
  cashMicroUsd: number;
  onContactChange: (id: PayContactId) => void;
  onAmountChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  onCancel: () => void;
}) {
  const copy = MODE_COPY[mode];

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      {mode === "receive" ? (
        <p className="text-xs text-muted-foreground">
          Simulated as arriving at your Practice handle, {PRACTICE_HANDLE}.
        </p>
      ) : null}

      {needsContact(mode) ? (
        <div className="flex flex-col gap-1.5">
          <Label>{copy.contactLabel}</Label>
          <div className="grid grid-cols-3 gap-2">
            {PAY_CONTACT_IDS.map((id) => {
              const contact = PAY_CONTACTS[id];
              const selected = contactId === id;
              return (
                <button
                  key={id}
                  type="button"
                  data-testid={`contact-${id}`}
                  onClick={() => onContactChange(id)}
                  className={cn(
                    "rounded-xl px-2 py-2.5 text-sm font-medium ring-1 transition-colors",
                    selected
                      ? "bg-foreground text-background ring-foreground"
                      : "ring-foreground/10 hover:bg-muted",
                  )}
                >
                  {contact.displayName}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="pay-amount">{copy.actionLabel}</Label>
          <span className="text-xs text-muted-foreground">{copy.amountHint(cashMicroUsd)}</span>
        </div>
        <Input
          id="pay-amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          autoFocus
          value={amountInput}
          onChange={(event) => onAmountChange(event.target.value)}
        />
      </div>

      {needsNote(mode) ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pay-note">Note (optional)</Label>
          <Input
            id="pay-note"
            autoComplete="off"
            placeholder="What's this for?"
            value={noteInput}
            onChange={(event) => onNoteChange(event.target.value)}
          />
        </div>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex flex-col gap-2">
        <Button type="submit" size="lg" className="h-12 w-full">
          {copy.actionLabel}
        </Button>
        <Button type="button" variant="ghost" className="h-11 w-full" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
