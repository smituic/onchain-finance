/**
 * Adapted from poc/turnkey-real-account's audited classifyPaymentError
 * (lib/poc/turnkey/payment-error.ts, see TURNKEY_POC_AUDIT.md) — trimmed to
 * exactly the part relevant here. By the time submit.ts calls
 * eth_sendUserOperation, Turnkey signing has already succeeded (it happens
 * client-side, before this server call) and the independent local preflight
 * has already passed — so there is no "cancelled" or "signing-failed" stage
 * to classify here, only: did the bundler give a definitive, recognized
 * rejection before ever accepting the operation ("failed"), or is the
 * outcome anything less certain than that ("unknown" — never resolved to
 * failure by a transport error, a timeout, or an unrecognized shape).
 */
export type SendErrorClassification = { stage: "failed" | "unknown"; detail: string };

// viem's account-abstraction bundler error classes — see
// viem/account-abstraction/utils/errors/getBundlerError.js. Their presence
// in the cause chain means the bundler evaluated (and rejected) the
// operation, as opposed to a transport-level failure that never reached it.
const BUNDLER_REJECTION_ERROR_NAMES = new Set([
  // Paymaster
  "PaymasterDepositTooLowError",
  "PaymasterFunctionRevertedError",
  "PaymasterNotDeployedError",
  "PaymasterPostOpFunctionRevertedError",
  "PaymasterRateLimitError",
  "PaymasterStakeTooLowError",
  "InvalidPaymasterAndDataError",
  "UserOperationPaymasterExpiredError",
  "UserOperationPaymasterSignatureError",
  "UserOperationRejectedByPaymasterError",
  // Estimation
  "GasValuesOverflowError",
  "HandleOpsOutOfGasError",
  "VerificationGasLimitExceededError",
  "VerificationGasLimitTooLowError",
  // Validation
  "InvalidFieldsError",
  "InvalidAccountNonceError",
  "SignatureCheckFailedError",
  "UserOperationSignatureError",
  "InitCodeFailedError",
  "InitCodeMustCreateSenderError",
  "InitCodeMustReturnSenderError",
  "SenderAlreadyConstructedError",
  "AccountNotDeployedError",
  "InsufficientPrefundError",
  "InvalidAggregatorError",
  "InvalidBeneficiaryError",
  "UnsupportedSignatureAggregatorError",
  "UserOperationOutOfTimeRangeError",
  "UserOperationExpiredError",
  "UserOperationRejectedByEntryPointError",
  "UserOperationRejectedByOpCodeError",
  // Submission
  "ExecutionRevertedError",
  "FailedToSendToBeneficiaryError",
  "InternalCallOnlyError",
  "SmartAccountFunctionRevertedError",
]);

function errorName(error: unknown): string {
  return error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
}

function safeShortMessage(error: unknown): string {
  if (error && typeof error === "object" && "shortMessage" in error) {
    const short = (error as { shortMessage: unknown }).shortMessage;
    if (typeof short === "string" && short.trim() !== "") return short.trim();
  }
  return error instanceof Error ? error.message : "Unknown error.";
}

type CauseChain = { bundlerRejectionName: string | null; sawRpcRejection: boolean };

/** Walks error.cause (viem's BaseError and native Error both use the standard cause chain). Depth-limited defensively. */
function walkCauseChain(error: unknown, depth = 0): CauseChain {
  if (!error || typeof error !== "object" || depth > 12) {
    return { bundlerRejectionName: null, sawRpcRejection: false };
  }
  const name = errorName(error);
  const cause = "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  const rest = walkCauseChain(cause, depth + 1);

  const bundlerRejectionName = rest.bundlerRejectionName ?? (BUNDLER_REJECTION_ERROR_NAMES.has(name) ? name : null);
  const sawRpcRejection = rest.sawRpcRejection || name === "RpcRequestError";

  return { bundlerRejectionName, sawRpcRejection };
}

export function classifySendError(error: unknown): SendErrorClassification {
  const detailMessage = safeShortMessage(error);
  const chain = walkCauseChain(error);

  if (chain.bundlerRejectionName && chain.sawRpcRejection) {
    return { stage: "failed", detail: `The bundler rejected the payment before executing it: ${detailMessage}` };
  }

  return {
    stage: "unknown",
    detail: `No definitive result was received after the operation was signed and dispatched: ${detailMessage}. The payment may still complete — reconcile before trying again.`,
  };
}
