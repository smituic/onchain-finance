import { PAY_CONTACTS, type PayActivity } from "@/simulation";

/**
 * The single presentation logic for a Pay activity entry — how it's labeled
 * and how its amount is signed. Shared by Pay's own activity list and
 * Home's "Recent payments" summary so the two surfaces can't describe the
 * same entry differently.
 */
export function payActivityLabel(activity: PayActivity): string {
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

/** An activity entry's amount, signed the way it affected Cash. */
export function signedPayActivityAmount(activity: PayActivity): number {
  return activity.kind === "send" || activity.kind === "withdraw"
    ? -activity.amountMicroUsd
    : activity.amountMicroUsd;
}
