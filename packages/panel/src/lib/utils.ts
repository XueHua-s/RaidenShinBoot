export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
