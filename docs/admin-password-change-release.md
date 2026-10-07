# Administrator password changes

The user detail page exposes password changes only to ADMIN accounts, for a
different ACTIVE, nonmerged account. The server additionally requires an
existing password hash; imported/passwordless accounts are not activated.

`POST /api/admin/brokers/:id/password` requires the current administrator
password and a new password of 12–128 Unicode characters. The target is the
explicit UUID, never a latest-card/phone heuristic. This sets a normal password,
not a temporary or automatically expiring password. Share it privately; this
feature does not email passwords or expose the old password.

The actor and target are locked and rechecked in one transaction. A successful
change increments the target authentication version, clears email reset fields,
invalidates outstanding login/reset OTPs, and writes an actor/target audit without
passwords or hashes. Existing target access/refresh sessions are revoked. The
administrator's own session is unchanged. Self-service changes also revoke their
own sessions; the profile page returns to login.

New tokens carry explicit access/refresh types and an authentication version.
Legacy untyped/unversioned tokens remain compatible only while the stored version
is zero. Apply the additive `auth_version` migration before running the new API.

## Release and rollback restrictions

New passwords use versioned SHA256-to-bcrypt hashes to avoid bcrypt's 72-byte
truncation. Existing bcrypt hashes remain readable and are not bulk rewritten.
After any new hash is written or a session version is increased, **do not roll
authentication back to an older implementation**: it cannot read the new hashes
or enforce revocation. A rollback must retain the new verifier/version checks and
the additive database column. Prefer a corrective forward release. Do not use
the manual create-admin/import tooling as a recovery workaround.

Before publication, obtain an exact-SHA backup and isolated clone migration
rehearsal; retain the existing protected production identity/disk checks. Never
change a real user's password solely to smoke-test the release. Functional tests
use synthetic users, OTPs and hashes. A live user change requires an explicit
administrator action and current-password confirmation.

Prisma error/warning events log fixed categories only. Query parameters,
passwords, hashes and recovery tokens must not be written to technical logs.
