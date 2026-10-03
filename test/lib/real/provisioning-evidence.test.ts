import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  classifyTerminalEvidence,
  compareFingerprint,
  compareIntent,
  evaluateCreateActivity,
  readDispatchRequestBody,
  type CreateActivityExpectation,
} from "@/lib/real/server/provisioning-evidence";
import { buildCreateSubOrganizationBody } from "@/lib/real/server/turnkey-provisioning";
import type { TurnkeyActivitySummary } from "@/lib/real/server/turnkey-signed-request";
import { FAKE_OWNER_ADDRESS, reorderKeys } from "./fixtures/turnkey-parent-fake";

/**
 * Provisioning Evidence Capture — the pure comparison of a Turnkey create
 * activity against the dispatch evidence persisted before it was sent.
 */
const TIMESTAMP_MS = 1790204988123;
const BODY = buildCreateSubOrganizationBody({
  organizationId: "parent-org",
  appUserId: "0b5c0c7e-6d9b-4f43-9a2e-1c2d3e4f5a6b",
  timestampMs: TIMESTAMP_MS,
  challengeBase64Url: "CHALLENGE",
  credentialId: "CRED",
  clientDataJson: "CDJ",
  attestationObject: "ATT",
  transports: ["hybrid", "internal"],
});
const SHA = createHash("sha256").update(BODY, "utf8").digest("hex");
const PARAMETERS = (JSON.parse(BODY) as { parameters: Record<string, unknown> }).parameters;

/** Whether the in-process rule would act on this activity at all (a completed create or a definitive failure). */
const actsOn = (evaluation: ReturnType<typeof evaluateCreateActivity>) => classifyTerminalEvidence(evaluation).kind !== "review";

const expected: CreateActivityExpectation = { activityId: "activity-1", organizationId: "parent-org", requestBody: BODY, requestBodySha256: SHA, stampPublicKey: "02abc", requestTimestampMs: TIMESTAMP_MS };

/** A truthful COMPLETED activity in the live API's observed shape. */
function activity(overrides: Record<string, unknown> = {}): TurnkeyActivitySummary {
  const raw: Record<string, unknown> = {
    id: "activity-1",
    organizationId: "parent-org",
    status: "ACTIVITY_STATUS_COMPLETED",
    type: "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8",
    intent: { createSubOrganizationIntentV8: reorderKeys(PARAMETERS) },
    result: { createSubOrganizationResultV8: { subOrganizationId: "sub-org-1", wallet: { walletId: "wallet-1", addresses: [FAKE_OWNER_ADDRESS] }, rootUserIds: ["turnkey-user-1"] } },
    votes: [{ selection: "VOTE_SELECTION_APPROVED", publicKey: "02abc", message: BODY }],
    appProofs: [],
    fingerprint: `sha256:${SHA}`,
    canApprove: true,
    canReject: true,
    createdAt: { seconds: String(Math.floor(TIMESTAMP_MS / 1000)), nanos: "0" },
    updatedAt: { seconds: String(Math.floor(TIMESTAMP_MS / 1000)), nanos: "0" },
    failure: null,
    ...overrides,
  };
  return { id: raw.id as string, status: raw.status as string, type: raw.type as string, organizationId: raw.organizationId as string, raw };
}

describe("identity: exact activity id, organization, and type", () => {
  it("a truthful activity evaluates clean", () => {
    const evaluation = evaluateCreateActivity(activity(), expected);
    expect(evaluation).toMatchObject({
      identity: "ok",
      terminalStatus: "ACTIVITY_STATUS_COMPLETED",
      intentVerdict: "exact",
      fingerprintVerdict: "match",
      voteVerdict: "parent_key",
      fingerprint: `sha256:${SHA}`,
      createdAtPlausible: true,
      failure: null,
      result: { subOrganizationId: "sub-org-1", rootUserId: "turnkey-user-1", walletId: "wallet-1", ownerAddress: FAKE_OWNER_ADDRESS },
    });
    expect(actsOn(evaluation)).toBe(true);
  });

  it.each([
    ["id_mismatch", { id: "activity-2" }],
    ["organization_mismatch", { organizationId: "another-org" }],
    ["type_mismatch", { type: "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V7" }],
  ] as const)("%s fails closed", (identity, overrides) => {
    const evaluation = evaluateCreateActivity(activity(overrides), expected);
    expect(evaluation.identity).toBe(identity);
    expect(actsOn(evaluation)).toBe(false);
  });

  it("with no recorded id yet (the submit response), the id itself is not compared — organization and type still are", () => {
    expect(evaluateCreateActivity(activity({ id: "anything" }), { ...expected, activityId: null }).identity).toBe("ok");
    expect(evaluateCreateActivity(activity({ organizationId: "x" }), { ...expected, activityId: null }).identity).toBe("organization_mismatch");
  });
});

describe("intent: structural, key-order-insensitive — never a string comparison", () => {
  it("Turnkey's reordered keys are still 'exact' — although the serialized strings differ", () => {
    const echoed = reorderKeys(PARAMETERS);
    expect(JSON.stringify(echoed)).not.toBe(JSON.stringify(PARAMETERS));
    expect(compareIntent(BODY, { createSubOrganizationIntentV8: echoed })).toBe("exact");
  });

  it.each([
    ["a different credential id", (p: Record<string, never>) => void ((p.rootUsers as never as Array<{ authenticators: Array<{ attestation: { credentialId: string } }> }>)[0]!.authenticators[0]!.attestation.credentialId = "OTHER")],
    ["a different attestation object", (p: Record<string, never>) => void ((p.rootUsers as never as Array<{ authenticators: Array<{ attestation: { attestationObject: string } }> }>)[0]!.authenticators[0]!.attestation.attestationObject = "X")],
    ["a different challenge", (p: Record<string, never>) => void ((p.rootUsers as never as Array<{ authenticators: Array<{ challenge: string }> }>)[0]!.authenticators[0]!.challenge = "X")],
    ["a second root user", (p: Record<string, never>) => void (p.rootUsers as never as unknown[]).push({ userName: "intruder", apiKeys: [], authenticators: [], oauthProviders: [] })],
    ["an API key on the root user", (p: Record<string, never>) => void ((p.rootUsers as never as Array<{ apiKeys: unknown[] }>)[0]!.apiKeys.push({ apiKeyName: "k", publicKey: "02" }))],
    ["a second authenticator", (p: Record<string, never>) => void ((p.rootUsers as never as Array<{ authenticators: unknown[] }>)[0]!.authenticators.push({ authenticatorName: "x" }))],
    ["a higher quorum threshold", (p: Record<string, unknown>) => void (p.rootQuorumThreshold = 2)],
    ["a different sub-organization name", (p: Record<string, unknown>) => void (p.subOrganizationName = "real-someone-else-1")],
    ["email recovery left enabled", (p: Record<string, unknown>) => void (p.disableEmailRecovery = false)],
    ["a second wallet account", (p: Record<string, never>) => void ((p.wallet as never as { accounts: unknown[] }).accounts.push({ curve: "CURVE_ED25519" }))],
    ["reordered transports", (p: Record<string, never>) => void (p.rootUsers as never as Array<{ authenticators: Array<{ attestation: { transports: string[] } }> }>)[0]!.authenticators[0]!.attestation.transports.reverse()],
    ["a field we sent that is missing from the echo", (p: Record<string, unknown>) => void delete p.disableSmsAuth],
    ["a field we sent echoed as null", (p: Record<string, unknown>) => void (p.wallet = null)],
  ])("%s -> mismatch (fails closed)", (_label, mutate) => {
    const echoed = structuredClone(PARAMETERS);
    (mutate as (p: Record<string, unknown>) => void)(echoed);
    expect(compareIntent(BODY, { createSubOrganizationIntentV8: echoed })).toBe("mismatch");
    expect(actsOn(evaluateCreateActivity(activity({ intent: { createSubOrganizationIntentV8: echoed } }), expected))).toBe(false);
  });

  it("keys we did NOT send, added to the echo, are 'fields_only' — not exact, not a mismatch", () => {
    const echoed = structuredClone(PARAMETERS) as Record<string, unknown> & { wallet: Record<string, unknown> };
    echoed.wallet.mnemonicLength = 12;
    echoed.verificationToken = null;
    expect(compareIntent(BODY, { createSubOrganizationIntentV8: echoed })).toBe("fields_only");
  });

  it("a missing intent, a non-object intent, or a SECOND intent member is a mismatch", () => {
    expect(compareIntent(BODY, null)).toBe("mismatch");
    expect(compareIntent(BODY, "createSubOrganizationIntentV8")).toBe("mismatch");
    expect(compareIntent(BODY, {})).toBe("mismatch");
    expect(compareIntent(BODY, { createSubOrganizationIntentV8: PARAMETERS, createUsersIntent: {} })).toBe("mismatch");
    expect(compareIntent(BODY, { createSubOrganizationIntentV7: PARAMETERS })).toBe("mismatch");
  });

  it("an unreadable stored body can never compare as anything but a mismatch", () => {
    expect(compareIntent("not json", { createSubOrganizationIntentV8: PARAMETERS })).toBe("mismatch");
    expect(compareIntent('{"type":"ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8","type":"x"}', { createSubOrganizationIntentV8: PARAMETERS })).toBe("mismatch");
    expect(readDispatchRequestBody(BODY)).toMatchObject({ type: "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8", timestampMs: String(TIMESTAMP_MS), organizationId: "parent-org" });
    expect(readDispatchRequestBody(BODY.replace("_V8", "_V7"))).toBeNull();
  });
});

describe("fingerprint: Turnkey's value, compared with OUR digest only in its recognized form", () => {
  it("recognized form + our digest -> match; recognized form + another digest -> mismatch (fails closed)", () => {
    expect(compareFingerprint(SHA, `sha256:${SHA}`)).toBe("match");
    const other = `sha256:${"0".repeat(64)}`;
    expect(compareFingerprint(SHA, other)).toBe("mismatch");
    const evaluation = evaluateCreateActivity(activity({ fingerprint: other }), expected);
    expect(evaluation).toMatchObject({ fingerprintVerdict: "mismatch", fingerprint: other, intentVerdict: "exact" });
    expect(actsOn(evaluation)).toBe(false);
  });

  it.each([`sha512:${"a".repeat(128)}`, `SHA256:${SHA}`, `sha256:${SHA.toUpperCase()}`, SHA, `sha256:${SHA}0`, "", undefined, null, 7])("an unrecognized form (%s) is recorded as such and does NOT, alone, fail the activity", (fingerprint) => {
    const evaluation = evaluateCreateActivity(activity({ fingerprint }), expected);
    expect(evaluation.fingerprintVerdict).toBe("unrecognized_form");
    expect(evaluation.fingerprint).toBe(typeof fingerprint === "string" ? fingerprint : null);
    expect(evaluation.intentVerdict).toBe("exact");
    expect(actsOn(evaluation)).toBe(true);
  });

  it("an implausibly long fingerprint is not persisted at all", () => {
    expect(evaluateCreateActivity(activity({ fingerprint: `x`.repeat(201) }), expected).fingerprint).toBeNull();
  });

  it("COMPLETED needs an EXACT intent: extra echoed keys are review even with a matching fingerprint", () => {
    const echoed = { ...structuredClone(PARAMETERS), verificationToken: null };
    const withMatch = evaluateCreateActivity(activity({ intent: { createSubOrganizationIntentV8: echoed } }), expected);
    expect(withMatch).toMatchObject({ intentVerdict: "fields_only", fingerprintVerdict: "match", terminalStatus: "ACTIVITY_STATUS_COMPLETED" });
    expect(classifyTerminalEvidence(withMatch)).toEqual({ kind: "review", reason: "intent_not_exact" });
    const withoutAnyTie = evaluateCreateActivity(activity({ intent: { createSubOrganizationIntentV8: echoed }, fingerprint: "blake3:abc" }), expected);
    expect(classifyTerminalEvidence(withoutAnyTie)).toEqual({ kind: "review", reason: "intent_not_exact" });
    // COMPLETED + exact may continue (with its result).
    expect(classifyTerminalEvidence(evaluateCreateActivity(activity(), expected))).toMatchObject({ kind: "completed", result: { subOrganizationId: "sub-org-1" } });
  });

  it("FAILED/REJECTED + extra echoed keys is definitive ONLY with a recognized fingerprint that matches our body", () => {
    const echoed = { ...structuredClone(PARAMETERS), verificationToken: null };
    const failure = { code: 3, message: "x", details: [] };
    for (const status of ["ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"]) {
      const base = { status, result: null, failure, intent: { createSubOrganizationIntentV8: echoed } };
      expect(classifyTerminalEvidence(evaluateCreateActivity(activity(base), expected))).toEqual({ kind: "definitive_failure" });
      expect(classifyTerminalEvidence(evaluateCreateActivity(activity({ ...base, fingerprint: "blake3:abc" }), expected))).toEqual({ kind: "review", reason: "intent_not_exact" });
      expect(classifyTerminalEvidence(evaluateCreateActivity(activity({ ...base, fingerprint: `sha256:${"0".repeat(64)}` }), expected))).toEqual({ kind: "review", reason: "fingerprint_mismatch" });
      // exact + unrecognized fingerprint form: still definitive (a format change alone decides nothing).
      expect(classifyTerminalEvidence(evaluateCreateActivity(activity({ status, result: null, failure, fingerprint: "blake3:abc" }), expected))).toEqual({ kind: "definitive_failure" });
    }
  });

  it("every review reason is typed and specific", () => {
    expect(classifyTerminalEvidence(evaluateCreateActivity(activity({ id: "other" }), expected))).toEqual({ kind: "review", reason: "not_this_activity" });
    expect(classifyTerminalEvidence(evaluateCreateActivity(activity({ status: "ACTIVITY_STATUS_PENDING" }), expected))).toEqual({ kind: "review", reason: "not_terminal" });
    expect(classifyTerminalEvidence(evaluateCreateActivity(activity({ intent: null }), expected))).toEqual({ kind: "review", reason: "intent_mismatch" });
    expect(classifyTerminalEvidence(evaluateCreateActivity(activity({ result: null }), expected))).toEqual({ kind: "review", reason: "result_unusable" });
  });
});

describe("vote, createdAt, result, failure", () => {
  it("the vote verdict is 'parent_key' only for exactly one approval by the stamping key over the exact body", () => {
    const verdict = (votes: unknown) => evaluateCreateActivity(activity({ votes }), expected).voteVerdict;
    expect(verdict([{ selection: "VOTE_SELECTION_APPROVED", publicKey: "02abc" }])).toBe("parent_key"); // no message echoed: still our key
    expect(verdict([{ selection: "VOTE_SELECTION_APPROVED", publicKey: "02ABC", message: BODY }])).toBe("other"); // exact string, never case-folded
    expect(verdict([{ selection: "VOTE_SELECTION_APPROVED", publicKey: "02abc", message: `${BODY} ` }])).toBe("other");
    expect(verdict([{ selection: "VOTE_SELECTION_REJECTED", publicKey: "02abc", message: BODY }])).toBe("other");
    expect(verdict([])).toBe("other");
    expect(verdict([{ selection: "VOTE_SELECTION_APPROVED", publicKey: "02abc" }, { selection: "VOTE_SELECTION_APPROVED", publicKey: "02abc" }])).toBe("other");
    expect(verdict(undefined)).toBe("other");
  });

  it("createdAt is whole seconds and may be EARLIER than the millisecond timestamp — never compared for equality", () => {
    const seconds = Math.floor(TIMESTAMP_MS / 1000);
    expect(seconds * 1000).toBeLessThan(TIMESTAMP_MS);
    const at = (s: number) => evaluateCreateActivity(activity({ createdAt: { seconds: String(s), nanos: "0" } }), expected);
    expect(at(seconds)).toMatchObject({ createdAtPlausible: true, turnkeyCreatedAt: new Date(seconds * 1000).toISOString() });
    expect(at(seconds - 1).createdAtPlausible).toBe(true); // truncation / skew, still plausible
    expect(at(seconds + 3599).createdAtPlausible).toBe(true); // accepted late, inside Turnkey's 1 h window
    expect(at(seconds + 3 * 3600).createdAtPlausible).toBe(false);
    expect(at(seconds - 3600).createdAtPlausible).toBe(false);
    // Implausible or unreadable createdAt never fails the activity by itself.
    expect(actsOn(at(seconds + 3 * 3600))).toBe(true);
    const unreadable = evaluateCreateActivity(activity({ createdAt: "2026" }), expected);
    expect(unreadable).toMatchObject({ createdAtPlausible: null, turnkeyCreatedAt: null });
    expect(actsOn(unreadable)).toBe(true);
  });

  it.each([
    ["no result", null],
    ["an empty result", {}],
    ["no sub-organization id", { createSubOrganizationResultV8: { wallet: { walletId: "w", addresses: [FAKE_OWNER_ADDRESS] }, rootUserIds: ["u"] } }],
    ["no root user", { createSubOrganizationResultV8: { subOrganizationId: "s", wallet: { walletId: "w", addresses: [FAKE_OWNER_ADDRESS] }, rootUserIds: [] } }],
    ["TWO root users", { createSubOrganizationResultV8: { subOrganizationId: "s", wallet: { walletId: "w", addresses: [FAKE_OWNER_ADDRESS] }, rootUserIds: ["u1", "u2"] } }],
    ["no wallet", { createSubOrganizationResultV8: { subOrganizationId: "s", rootUserIds: ["u"] } }],
    ["TWO addresses", { createSubOrganizationResultV8: { subOrganizationId: "s", wallet: { walletId: "w", addresses: [FAKE_OWNER_ADDRESS, FAKE_OWNER_ADDRESS] }, rootUserIds: ["u"] } }],
    ["a malformed address", { createSubOrganizationResultV8: { subOrganizationId: "s", wallet: { walletId: "w", addresses: ["0x1234"] }, rootUserIds: ["u"] } }],
    ["an older result version", { createSubOrganizationResultV7: { subOrganizationId: "s", wallet: { walletId: "w", addresses: [FAKE_OWNER_ADDRESS] }, rootUserIds: ["u"] } }],
  ])("a COMPLETED activity with %s has no usable result", (_label, result) => {
    expect(evaluateCreateActivity(activity({ result }), expected).result).toBeNull();
  });

  it("the owner address is kept exactly as Turnkey reported it (mixed case), never lowercased", () => {
    expect(evaluateCreateActivity(activity(), expected).result?.ownerAddress).toBe(FAKE_OWNER_ADDRESS);
    expect(FAKE_OWNER_ADDRESS).not.toBe(FAKE_OWNER_ADDRESS.toLowerCase());
  });

  it("FAILED/REJECTED: the failure is captured (bounded), and never a result; non-terminal statuses are not terminal", () => {
    const failure = { code: 3, message: "invalid authenticator attestation: ChallengeMismatch", details: [] };
    for (const status of ["ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"] as const) {
      const evaluation = evaluateCreateActivity(activity({ status, result: null, failure }), expected);
      expect(evaluation).toMatchObject({ terminalStatus: status, result: null, failure: { code: 3, message: failure.message } });
      expect(actsOn(evaluation)).toBe(true);
    }
    expect(evaluateCreateActivity(activity({ status: "ACTIVITY_STATUS_FAILED", result: null, failure: { code: 3, message: "m".repeat(2000) } }), expected).failure?.message).toHaveLength(500);
    // A cut inside a surrogate pair never leaves half a character behind.
    const cut = evaluateCreateActivity(activity({ status: "ACTIVITY_STATUS_FAILED", result: null, failure: { code: 3, message: `${"m".repeat(499)}😀` } }), expected).failure?.message;
    expect(cut).toBe("m".repeat(499));
    expect(evaluateCreateActivity(activity({ status: "ACTIVITY_STATUS_FAILED", result: null, failure: null }), expected).failure).toBeNull();
    // A result on a FAILED activity is ignored; a failure on a COMPLETED one is ignored.
    expect(evaluateCreateActivity(activity({ status: "ACTIVITY_STATUS_FAILED" }), expected).result).toBeNull();
    expect(evaluateCreateActivity(activity({ failure }), expected).failure).toBeNull();
    for (const status of ["ACTIVITY_STATUS_PENDING", "ACTIVITY_STATUS_CREATED", "ACTIVITY_STATUS_CONSENSUS_NEEDED", "ACTIVITY_STATUS_AUTHENTICATORS_NEEDED", "ACTIVITY_STATUS_SOMETHING_NEW"]) {
      expect(evaluateCreateActivity(activity({ status }), expected)).toMatchObject({ terminalStatus: null, result: null, failure: null });
    }
  });
});
