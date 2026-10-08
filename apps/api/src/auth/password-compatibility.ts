// Pure build capability: deployment reads this module without app startup,
// configuration, network access or password material. Change the marker only
// together with compatible hash verification and session-version enforcement.
export const AUTH_PASSWORD_COMPATIBILITY = "bcrypt-sha256-v1+auth-version-v1";
