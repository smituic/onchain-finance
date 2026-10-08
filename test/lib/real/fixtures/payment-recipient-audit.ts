/**
 * TEST-ONLY. The standing pair-integrity audit for handle payments, exactly as
 * recorded in schema.sql's "Payment Attempt Recipient Identity" block.
 *
 * The database proves a recorded recipient handle exists and a recorded
 * recipient account exists — NOT that the handle belongs to that account
 * (there is deliberately no composite foreign key). This read-only query is
 * what does: it must return ZERO rows once Handle Pay Slice B writes handle
 * payments. It also holds Slice B to the address rule: the stored
 * `recipient` is the recipient account's Safe, compared case-insensitively
 * because payment_attempts.recipient is normalized lowercase while
 * real_accounts.safe_address is stored case-preserving.
 */
export const PAIR_INTEGRITY_AUDIT_SQL = `SELECT p.id
FROM payment_attempts p
LEFT JOIN real_account_handles h
  ON h.handle = p.recipient_handle
LEFT JOIN real_accounts a
  ON a.app_user_id = p.recipient_app_user_id
WHERE p.recipient_handle IS NOT NULL
  AND (
    h.kind IS DISTINCT FROM 'claimed'
    OR h.app_user_id IS DISTINCT FROM p.recipient_app_user_id
    OR lower(a.safe_address) IS DISTINCT FROM lower(p.recipient)
  )`;

/** The same query with only its three tables schema-qualified (for a scratch schema). */
export function pairIntegrityAuditFor(schema: string): string {
  let text = PAIR_INTEGRITY_AUDIT_SQL;
  for (const [from, to] of [
    ["FROM payment_attempts p", `FROM ${schema}.payment_attempts p`],
    ["LEFT JOIN real_account_handles h", `LEFT JOIN ${schema}.real_account_handles h`],
    ["LEFT JOIN real_accounts a", `LEFT JOIN ${schema}.real_accounts a`],
  ] as const) {
    if (text.split(from).length !== 2) throw new Error(`the audit query must contain "${from}" exactly once`);
    text = text.replace(from, to);
  }
  return text;
}
