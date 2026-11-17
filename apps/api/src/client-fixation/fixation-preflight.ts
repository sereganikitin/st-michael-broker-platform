/** Evidence supplied by the domain boundary, never inferred from an HTTP code. */
const BEFORE_MUTATION = Symbol("fixation-before-mutation");
const FAILURE_CODE = Symbol("fixation-failure-code");

export function markFixationPreflightFailure<T>(error: T): T {
  if (error && typeof error === "object")
    Object.defineProperty(error, BEFORE_MUTATION, { value: true });
  return error;
}

export function isFixationPreflightFailure(error: unknown): boolean {
  return (
    !!error && typeof error === "object" && error[BEFORE_MUTATION] === true
  );
}

export function withFixationFailureCode<T>(error: T, code: string): T {
  if (error && typeof error === "object")
    Object.defineProperty(error, FAILURE_CODE, { value: code });
  return error;
}

export function fixationFailureCode(error: unknown): string {
  const code = error && typeof error === "object" ? error[FAILURE_CODE] : null;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,80}$/.test(code)
    ? code
    : "FIXATION_FAILED";
}

export const RETRYABLE_FIXATION_CODES = new Set([
  "AMO_NETWORK_ERROR",
  "AMO_TEMPORARY_UNAVAILABLE",
  "AMO_RATE_LIMIT_429",
]);

export interface FixationExecution {
  requestId: string;
  beforeMutation(): Promise<void>;
}
