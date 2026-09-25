import { createHash } from "node:crypto";
import { bytesToBase64Url, base64UrlToBytes } from "@/lib/real/bytes";
import { buildAuthenticationResponseJSON, type FixtureAuthenticator } from "./webauthn";

/**
 * A REAL WebAuthn stamp in @turnkey/webauthn-stamper's exact format: an
 * assertion by `authenticator` whose challenge is utf8(hex(sha256(body))).
 * The server verifies it cryptographically — nothing here is a stub.
 */
export function stampBody(input: { authenticator: FixtureAuthenticator; body: string; origin: string; rpId: string }) {
  const hex = createHash("sha256").update(input.body, "utf8").digest("hex");
  const assertion = buildAuthenticationResponseJSON({
    authenticator: input.authenticator,
    challenge: bytesToBase64Url(new TextEncoder().encode(hex)),
    origin: input.origin,
    rpId: input.rpId,
  });
  return {
    stampHeaderName: "X-Stamp-Webauthn",
    stampHeaderValue: JSON.stringify({
      authenticatorData: assertion.response.authenticatorData,
      clientDataJson: assertion.response.clientDataJSON,
      credentialId: assertion.id,
      signature: assertion.response.signature,
    }),
  };
}

export function signRequest(input: { authenticator: FixtureAuthenticator; activity: object; url: string; origin: string; rpId: string }) {
  const body = JSON.stringify(input.activity);
  return { body, url: input.url, stamp: stampBody({ authenticator: input.authenticator, body, origin: input.origin, rpId: input.rpId }) };
}

/** Standard, padded base64 of a base64url id — Turnkey may not echo WebAuthn's exact string form, so the fake deliberately doesn't. */
export function toStdBase64(base64url: string): string {
  return Buffer.from(base64UrlToBytes(base64url)).toString("base64");
}

type FakeAuthenticator = { authenticatorId: string; credentialId: string; authenticatorName: string; credential: { publicKey: string } };
type FakeActivity = Record<string, unknown> & { id: string; status: string; organizationId: string; type: string };
export type SubmitMode = "ok" | "lose_response_after_apply" | "lose_response_before_apply" | "fail_activity" | "pending_activity";

/**
 * Stateful stand-in for Turnkey: getUsers/getActivity (the parent key's
 * read-only calls, via the mocked TurnkeyClient) plus a fetch that serves
 * the two child-signed submit endpoints. Identical bodies map to the same
 * activity (fingerprint dedupe), which is what makes a same-body replay
 * safe. Records every forwarded request byte-for-byte.
 */
export class FakeTurnkey {
  users = new Map<string, FakeAuthenticator[]>();
  activities = new Map<string, FakeActivity>();
  byBody = new Map<string, string>();
  forwarded: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  nextMode: SubmitMode = "ok";
  /** Per-forward modes consumed in order before falling back to nextMode. */
  modeQueue: SubmitMode[] = [];
  /** When false, an identical body creates a NEW activity (no Turnkey fingerprint dedupe assumed). */
  dedupeByBody = true;
  /** Models read-after-write lag: authenticators created while true stay invisible, and ones deleted while true stay visible, to getUsers until propagate(). */
  lagReads = false;
  private hidden = new Set<string>();
  private ghosts: FakeAuthenticator[] = [];
  onForward: (() => void | Promise<void>) | null = null;
  private seq = 0;

  constructor(
    readonly organizationId: string,
    readonly userId: string,
  ) {
    this.users.set(userId, []);
  }

  addAuthenticator(credentialIdBase64Url: string, authenticatorId?: string): FakeAuthenticator {
    const authenticator = {
      authenticatorId: authenticatorId ?? `authenticator-${++this.seq}`,
      credentialId: toStdBase64(credentialIdBase64Url),
      authenticatorName: "x",
      credential: { publicKey: `02${createHash("sha256").update(credentialIdBase64Url).digest("hex")}` },
    };
    this.users.get(this.userId)!.push(authenticator);
    return authenticator;
  }

  authenticators(): FakeAuthenticator[] {
    return this.users.get(this.userId) ?? [];
  }

  propagate(): void {
    this.lagReads = false;
    this.hidden.clear();
    this.ghosts = [];
  }

  addActivity(activity: FakeActivity): void {
    this.activities.set(activity.id, activity);
  }

  getUsers = async ({ organizationId }: { organizationId: string }) => {
    if (organizationId !== this.organizationId) return { users: [] };
    return {
      users: [...this.users.entries()].map(([userId, authenticators]) => ({
        userId,
        authenticators: [...authenticators.filter((a) => !this.hidden.has(a.authenticatorId)), ...(userId === this.userId ? this.ghosts : [])],
      })),
    };
  };

  getActivity = async ({ organizationId, activityId }: { organizationId: string; activityId: string }) => {
    const activity = this.activities.get(activityId);
    if (!activity || organizationId !== this.organizationId) throw new Error("not found");
    return { activity };
  };

  fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    this.forwarded.push({ url, body: init.body, headers: init.headers });
    await this.onForward?.();
    const mode = this.modeQueue.shift() ?? this.nextMode;
    if (mode === "lose_response_before_apply") throw new Error("network");

    let activityId = this.dedupeByBody ? this.byBody.get(init.body) : undefined;
    if (!activityId) {
      const parsed = JSON.parse(init.body) as { type: string; organizationId: string; parameters: Record<string, unknown> };
      activityId = `activity-${++this.seq}`;
      let result: Record<string, unknown> = {};
      let status = "ACTIVITY_STATUS_COMPLETED";
      if (mode === "fail_activity") status = "ACTIVITY_STATUS_FAILED";
      else if (mode === "pending_activity") status = "ACTIVITY_STATUS_PENDING";
      else if (url.endsWith("/create_authenticators")) {
        const attestation = (parsed.parameters.authenticators as Array<{ attestation: { credentialId: string } }>)[0]!.attestation;
        const created = this.addAuthenticator(attestation.credentialId);
        if (this.lagReads) this.hidden.add(created.authenticatorId);
        result = { createAuthenticatorsResult: { authenticatorIds: [created.authenticatorId] } };
      } else if (url.endsWith("/delete_authenticators")) {
        const ids = parsed.parameters.authenticatorIds as string[];
        if (this.lagReads) this.ghosts.push(...this.authenticators().filter((a) => ids.includes(a.authenticatorId)));
        this.users.set(this.userId, this.authenticators().filter((a) => !ids.includes(a.authenticatorId)));
        result = { deleteAuthenticatorsResult: { authenticatorIds: ids } };
      }
      this.addActivity({ id: activityId, status, organizationId: parsed.organizationId, type: parsed.type, result, votes: [], intent: {} });
      this.byBody.set(init.body, activityId);
    }
    if (mode === "lose_response_after_apply") throw new Error("response lost");
    return new Response(JSON.stringify({ activity: this.activities.get(activityId) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}
