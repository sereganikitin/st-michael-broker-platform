/** Legacy corrections store edit time in occurredAt. Only explicit new metadata overrides the root call date. */
export function agencyCallOccurredAt(attempt: any, root: any = attempt): any {
  const value = attempt?.metadata?.callOccurredAt;
  return typeof value === "string" &&
    /(Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : root?.occurredAt;
}
