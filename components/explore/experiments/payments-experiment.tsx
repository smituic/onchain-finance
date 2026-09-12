"use client";

import { useState } from "react";
import { getAssetValueMicroUsd, PAY_CONTACTS, toMicroUnits, type PayActivity } from "@/simulation";
import { useExperimentSimulation } from "@/lib/explore/use-experiment-simulation";
import { formatSignedUsd, formatUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Note } from "@/components/shell/note";
import { Expander } from "@/components/shell/expander";
import { ExperimentShell } from "@/components/explore/experiment-shell";
import { EXPLORE_EXPERIMENTS_BY_ID } from "@/components/explore/experiments";

const SEND_AMOUNT = toMicroUnits(25);
const REQUEST_AMOUNT = toMicroUnits(25);
const SEND_TO = "maya" as const;
const REQUEST_FROM = "jordan" as const;

function activityLabel(activity: PayActivity): string {
  const contactName = activity.contactId ? PAY_CONTACTS[activity.contactId].displayName : null;
  switch (activity.kind) {
    case "send":
      return `Sent to ${contactName}`;
    case "receive":
      return `Received from ${contactName}`;
    case "deposit":
      return "Added Cash";
    case "withdraw":
      return "Withdrew Cash";
  }
}

function signedActivityAmount(activity: PayActivity): number {
  return activity.kind === "send" || activity.kind === "withdraw"
    ? -activity.amountMicroUsd
    : activity.amountMicroUsd;
}

export function PaymentsExperiment() {
  const experiment = EXPLORE_EXPERIMENTS_BY_ID.payments;
  const { state, version, dispatch, reset: resetSandbox } = useExperimentSimulation("payments");
  const [note, setNote] = useState<string | null>(null);

  const cashMicroUsd = getAssetValueMicroUsd(state, "USDC");
  const activity = state.pay.activity.slice().reverse();
  const pendingRequest = state.pay.requests.find((r) => r.status === "pending") ?? null;
  const hasSent = state.pay.activity.some((a) => a.kind === "send");
  const hasRequested = state.pay.requests.length > 0;

  function sendMoney() {
    const result = dispatch({ type: "send-payment", contactId: SEND_TO, amount: SEND_AMOUNT });
    if (!result.ok || !result.payActivity) return;
    setNote(
      `Sending moved money immediately — your cash dropped by ${formatUsd(result.payActivity.amountMicroUsd)}, and it showed up as activity below.`,
    );
  }

  function requestMoney() {
    const result = dispatch({ type: "create-payment-request", contactId: REQUEST_FROM, amount: REQUEST_AMOUNT });
    if (!result.ok) return;
    setNote("Requesting didn't move any money. It's just a pending ask, sitting there until Jordan pays it.");
  }

  function completeRequest() {
    if (!pendingRequest) return;
    const result = dispatch({ type: "complete-payment-request", requestId: pendingRequest.id });
    if (!result.ok || !result.paymentRequest) return;
    setNote(
      `Now it's paid — your cash went up by ${formatUsd(result.paymentRequest.amountMicroUsd)}, and a second activity entry appeared.`,
    );
  }

  function reset() {
    resetSandbox();
    setNote(null);
  }

  return (
    <ExperimentShell experiment={experiment} onReset={reset} canReset={version > 0}>
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">Cash available</p>
          <p
            className="font-heading text-4xl leading-none font-semibold tracking-tight tabular-nums"
            data-testid="payments-experiment-cash"
          >
            {formatUsd(cashMicroUsd)}
          </p>
        </section>

        {note ? (
          <Note title="What changed">
            <p>{note}</p>
          </Note>
        ) : null}

        <div className="flex flex-col gap-2">
          <Button className="h-11 w-full" disabled={hasSent} onClick={sendMoney}>
            Send $25 to {PAY_CONTACTS[SEND_TO].displayName}
          </Button>
          <Button variant="outline" className="h-11 w-full" disabled={hasRequested} onClick={requestMoney}>
            Request $25 from {PAY_CONTACTS[REQUEST_FROM].displayName}
          </Button>
          {pendingRequest ? (
            <Button variant="outline" className="h-11 w-full" onClick={completeRequest}>
              Simulate {PAY_CONTACTS[REQUEST_FROM].displayName} paying it
            </Button>
          ) : null}
        </div>

        <section className="flex flex-col gap-3" aria-labelledby="experiment-activity-heading">
          <h2 id="experiment-activity-heading" className="font-heading text-sm font-medium">
            Activity
          </h2>
          {activity.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {activity.map((entry) => (
                <li
                  key={entry.id}
                  data-testid={`experiment-activity-${entry.id}`}
                  className="flex items-center justify-between gap-4 rounded-xl bg-muted/60 px-4 py-3.5"
                >
                  <span className="text-sm font-medium">{activityLabel(entry)}</span>
                  <span className="shrink-0 text-sm font-medium tabular-nums">
                    {formatSignedUsd(signedActivityAmount(entry))}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing yet — send or request money above.</p>
          )}
        </section>

        <Note title="Where's the blockchain?">
          <p>
            You just moved money without ever seeing an address, a network, or a confirmation screen. In a future
            Real Mode, blockchain and payment infrastructure can sit underneath an experience like this rather than
            becoming a chore you manage yourself.
          </p>
          <Expander question="Would I need a wallet address or gas?">
            <p>
              Not to use the product day to day. Normal users should be able to send and receive with names or
              handles, the way you just did here — wallet and smart-account infrastructure can exist underneath,
              out of sight, while advanced users who want to inspect the technical details can always find them.
            </p>
            <p>
              To be precise: Practice Mode doesn&apos;t send blockchain transactions today — everything here is
              simulated.
            </p>
          </Expander>
        </Note>
      </div>
    </ExperimentShell>
  );
}
