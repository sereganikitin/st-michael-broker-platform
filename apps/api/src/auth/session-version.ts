export function sessionVersionMatches(payload: any, version: number, kind: "access" | "refresh"): boolean {
  if (!payload || typeof payload.sub !== "string" || !payload.sub || !Number.isSafeInteger(version) || version < 0) return false;
  // Only genuinely legacy, untyped/unversioned tokens have this transition path.
  if (payload.type === undefined && payload.authVersion === undefined) return version === 0;
  return payload.type === kind && Number.isSafeInteger(payload.authVersion) && payload.authVersion === version;
}
