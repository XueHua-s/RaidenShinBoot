export function timeoutSignal(timeoutMs: number) {
  return AbortSignal.timeout(timeoutMs);
}

export function isAbortError(error: unknown) {
  return (
    error instanceof DOMException && error.name === "TimeoutError"
  ) || (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
