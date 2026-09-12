import type { PayContactId, PayState } from "./types";

export type PayContactDefinition = {
  id: PayContactId;
  displayName: string;
  handle: string;
};

/**
 * The fixed, clearly fictional set of Practice contacts Send/Receive/Request
 * move money between. Display definitions only — never mutable financial
 * state — so this stays a plain registry rather than a contacts system.
 */
export const PAY_CONTACTS: Record<PayContactId, PayContactDefinition> = {
  maya: { id: "maya", displayName: "Maya Chen", handle: "@maya" },
  jordan: { id: "jordan", displayName: "Jordan Lee", handle: "@jordan" },
  alex: { id: "alex", displayName: "Alex Rivera", handle: "@alex" },
};

export const PAY_CONTACT_IDS = Object.keys(PAY_CONTACTS) as PayContactId[];

/**
 * The user's own Practice identity, shown in Receive so incoming money has
 * somewhere to "arrive". A product preview of a future handle system, not a
 * real, globally registered identity — Practice Mode has no other users.
 */
export const PRACTICE_HANDLE = "@practice-you";

/** A new user's Pay state: nothing pending, nothing moved yet. */
export function createInitialPayState(): PayState {
  return { requests: [], activity: [], nextRequestId: 1, nextActivityId: 1 };
}
