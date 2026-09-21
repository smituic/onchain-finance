import { isWebAuthnCancellation } from "./passkey";

export type PaymentFailureStage = "cancelled" | "signing-failed" | "rejected" | "uncertain";

export type PaymentFailurePhase = "turnkey-signing" | "paymaster" | "estimation" | "validation" | "submission" | "unknown";

export type PaymentFailureClassification = {
  stage: PaymentFailureStage;
  phase: PaymentFailurePhase;
  detail: string;
  rpc?: { method: string; code?: number; message: string };
};

// viem's account-abstraction bundler error classes — see
// viem/account-abstraction/utils/errors/getBundlerError.js. Their names
// double as a phase classification for a rejected/reverted user operation.
const PAYMASTER_ERROR_NAMES = new Set([
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
]);
const ESTIMATION_ERROR_NAMES = new Set([
  "GasValuesOverflowError",
  "HandleOpsOutOfGasError",
  "VerificationGasLimitExceededError",
  "VerificationGasLimitTooLowError",
]);
const VALIDATION_ERROR_NAMES = new Set([
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
]);
const SUBMISSION_ERROR_NAMES = new Set([
  "ExecutionRevertedError",
  "FailedToSendToBeneficiaryError",
  "InternalCallOnlyError",
  "SmartAccountFunctionRevertedError",
]);

// viem's raw transport/RPC error classes. Turnkey's own client never throws
// these — they only occur talking to our /api/dev/turnkey-poc/pimlico proxy.
const BUNDLER_TRANSPORT_ERROR_NAMES = new Set(["HttpRequestError", "RpcRequestError", "TimeoutError", "WebSocketRequestError"]);

function errorName(error: unknown): string {
  return error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

/** The short, human part of a viem BaseError — never the full message, which embeds a raw request-body dump. */
function safeShortMessage(error: unknown): string {
  if (error && typeof error === "object" && "shortMessage" in error) {
    const short = (error as { shortMessage: unknown }).shortMessage;
    if (typeof short === "string" && short.trim() !== "") return short.trim();
  }
  return errorMessage(error);
}

function phaseForBundlerErrorName(name: string | null): PaymentFailurePhase {
  if (!name) return "submission";
  if (PAYMASTER_ERROR_NAMES.has(name)) return "paymaster";
  if (ESTIMATION_ERROR_NAMES.has(name)) return "estimation";
  if (VALIDATION_ERROR_NAMES.has(name)) return "validation";
  if (SUBMISSION_ERROR_NAMES.has(name)) return "submission";
  return "unknown";
}

type RpcCause = { name: string; code?: number; status?: number; message: string };

type CauseChain = {
  names: string[];
  bundlerErrorName: string | null;
  rpcCause: RpcCause | null;
};

/**
 * Walks `error.cause` (viem's BaseError and native Error both use the
 * standard `cause` chain) looking for the two facts that matter: which
 * viem account-abstraction bundler error (if any) wraps this, and the raw
 * transport/RPC error underneath it. Depth-limited defensively; real chains
 * here are at most 3-4 deep.
 */
function walkCauseChain(error: unknown, depth = 0): CauseChain {
  if (!error || typeof error !== "object" || depth > 12) {
    return { names: [], bundlerErrorName: null, rpcCause: null };
  }
  const name = errorName(error);
  const cause = "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  const rest = walkCauseChain(cause, depth + 1);

  const names = name ? [name, ...rest.names] : rest.names;

  let bundlerErrorName = rest.bundlerErrorName;
  if (!bundlerErrorName && (PAYMASTER_ERROR_NAMES.has(name) || ESTIMATION_ERROR_NAMES.has(name) || VALIDATION_ERROR_NAMES.has(name) || SUBMISSION_ERROR_NAMES.has(name))) {
    bundlerErrorName = name;
  }

  let rpcCause = rest.rpcCause;
  if (!rpcCause && BUNDLER_TRANSPORT_ERROR_NAMES.has(name)) {
    const status = "status" in error && typeof (error as { status: unknown }).status === "number" ? (error as { status: number }).status : undefined;
    const code = "code" in error && typeof (error as { code: unknown }).code === "number" ? (error as { code: number }).code : undefined;
    rpcCause = { name, code, status, message: safeShortMessage(error) };
  }

  return { names, bundlerErrorName, rpcCause };
}

/**
 * Classifies a thrown error from the post-passkey payment pipeline
 * (sendSponsoredCashTransfer), using viem's own error types and cause chain
 * — not message-text guessing:
 *
 * - "cancelled": the WebAuthn ceremony was aborted. Nothing was signed or sent.
 * - "signing-failed": nothing in the error or its cause chain is a viem
 *   bundler/paymaster transport error, so this happened talking to Turnkey
 *   (before a signature existed) or during prepareUserOperation's own
 *   paymaster/gas-estimation calls (before a passkey prompt could appear).
 *   Nothing was submitted either way.
 * - "rejected": a recognized bundler validation rejection came back as a
 *   JSON-RPC error. HTTP status alone is not proof of rejection.
 * - "uncertain": no definitive rejection/receipt exists, including HTTP
 *   gateway failures and local errors after a hash was acknowledged.
 *
 * IMPORTANT: viem's sendUserOperation only wraps an error as
 * UserOperationExecutionError when it comes from the final
 * eth_sendUserOperation call — and in viem's own source, that call only runs
 * after account.signUserOperation() has already returned a signature. So
 * finding "UserOperationExecutionError" anywhere in the chain is conclusive
 * proof signing already succeeded, regardless of how the underlying
 * transport error is shaped (an earlier version of this classifier only
 * checked the top-level error name, so it never recognized this wrapper and
 * misclassified every post-signing bundler rejection as "signing-failed").
 */
export function classifyPaymentError(error: unknown, context: { submissionAcknowledged?: boolean } = {}): PaymentFailureClassification {
  if (context.submissionAcknowledged) {
    return {
      stage: "uncertain",
      phase: "submission",
      detail: "The bundler returned a userOperationHash, but a later local step failed. Reconcile the known hash before sending again.",
    };
  }
  if (isWebAuthnCancellation(error)) {
    return {
      stage: "cancelled",
      phase: "turnkey-signing",
      detail: "The passkey prompt was cancelled. No signature was produced and nothing was submitted.",
    };
  }

  const message = errorMessage(error);

  if (errorName(error) === "SafeOpPreflightError") {
    // Turnkey signing definitely succeeded — a signature exists. The local
    // offline preflight (verifySafeOpSignature) caught that it does not
    // recover to the expected owner and aborted before eth_sendUserOperation
    // was ever called, so this is never "signing did not complete".
    return {
      stage: "signing-failed",
      phase: "validation",
      detail: `Local preflight rejected the SafeOp signature before submission — nothing was sent to the bundler: ${message}`,
    };
  }

  const chain = walkCauseChain(error);
  const reachedSubmission = chain.names.includes("UserOperationExecutionError");
  const talkedToBundlerTransport = reachedSubmission || chain.rpcCause !== null;

  if (!talkedToBundlerTransport) {
    return {
      stage: "signing-failed",
      phase: "turnkey-signing",
      detail: `Turnkey signing did not complete: ${message}`,
    };
  }

  if (!reachedSubmission) {
    // A viem transport/RPC error with no UserOperationExecutionError wrapper
    // can only come from prepareUserOperation's own paymaster/gas-estimation
    // calls, which run before account.signUserOperation() — so no passkey
    // prompt would have appeared yet for this specific failure.
    return {
      stage: "signing-failed",
      phase: "unknown",
      detail: `Preparing the payment failed before a passkey prompt could appear (sponsorship or gas estimation): ${chain.rpcCause?.message ?? message}`,
    };
  }

  const phase = phaseForBundlerErrorName(chain.bundlerErrorName);
  const rpc = chain.rpcCause ? { method: "eth_sendUserOperation", code: chain.rpcCause.code, message: chain.rpcCause.message } : undefined;
  const hadExplicitRejection = chain.rpcCause?.name === "RpcRequestError" && chain.bundlerErrorName !== null;

  if (hadExplicitRejection) {
    return {
      stage: "rejected",
      phase,
      rpc,
      detail: `Signing succeeded, but the bundler/paymaster explicitly rejected the request during ${phase}${
        rpc?.code !== undefined ? ` (code ${rpc.code})` : ""
      }: ${rpc?.message ?? message}`,
    };
  }

  return {
    stage: "uncertain",
    phase,
    rpc,
    // error.message on UserOperationExecutionError includes the complete
    // signed operation. This detail is persisted; retain only a short cause.
    detail: `Signing succeeded, but no definitive bundler result was received: ${chain.rpcCause?.message ?? "Submission outcome unavailable"}. It may already have been submitted — reconcile or check USDC history before sending again.`,
  };
}
