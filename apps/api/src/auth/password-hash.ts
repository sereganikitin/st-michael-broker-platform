import * as bcrypt from "bcrypt";
import { createHash } from "crypto";

// bcrypt alone silently truncates after 72 UTF-8 bytes. Versioned prehashing
// supports the full 128-character input while keeping legacy hashes readable.
// Rollback constraint: after writing this format, keep this verifier and the
// authVersion checks. Older API releases cannot read these hashes or enforce
// session revocation; never strip the prefix or rewrite existing hashes.
const PREFIX = "bcrypt-sha256-v1$";
function digest(password: string) { return createHash("sha256").update(password, "utf8").digest("base64"); }

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(digest(password), 10).then(hash => PREFIX + hash);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (typeof password !== "string" || typeof hash !== "string") return Promise.resolve(false);
  return hash.startsWith(PREFIX)
    ? bcrypt.compare(digest(password), hash.slice(PREFIX.length))
    : bcrypt.compare(password, hash);
}
