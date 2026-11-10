"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const DOC_ID = "f848c1a4-b8f5-4bfa-b4ef-16e56436276e";
const OLD_URL = "/files/cooperation/calculator-rassrochki-2026-09.html";
const ACTION = "INSTALLMENT_CALCULATOR_PUBLISHED";
const MAX_BYTES = 2 * 1024 * 1024;
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
function fail(code) {
  const error = new Error("Calculator publication refused");
  error.safeCode = code;
  throw error;
}
const json = (value) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? String(item) : item,
  );
const digest = (value) => sha(json(value));
function environment(env, now = Date.now()) {
  const mode = env.MODE || "plan";
  if (
    !["plan", "apply"].includes(mode) ||
    !/^[a-f0-9]{40}$/.test(env.SOURCE_SHA || "") ||
    !/^[a-f0-9]{40}$/.test(env.EXPECTED_DEPLOYED_SHA || "") ||
    env.GIT_SHA !== env.EXPECTED_DEPLOYED_SHA ||
    !/^\d+$/.test(env.PRODUCTION_PG_SYSTEM_IDENTIFIER || "") ||
    !/^[1-9]\d*$/.test(env.PRODUCTION_MIN_BROKER_ROWS || "") ||
    !/^[a-f0-9]{64}$/.test(env.SOURCE_HTML_SHA256 || "")
  )
    fail("ENVIRONMENT_INVALID");
  if (mode === "apply") {
    if (
      env.CONFIRM_APPLY !== "true" ||
      env.SOURCE_CI_ATTESTED !== "true" ||
      !/^[a-f0-9]{64}$/.test(env.EXPECTED_PLAN_HASH || "") ||
      !/^[a-f0-9]{64}$/.test(env.VERIFIED_BACKUP_SHA256 || "") ||
      env.VERIFIED_BACKUP_DEPLOYED_SHA !== env.EXPECTED_DEPLOYED_SHA
    )
      fail("APPLY_GATE_INVALID");
    const age = now - Date.parse(env.VERIFIED_BACKUP_AT || "");
    if (!Number.isFinite(age) || age < 0 || age >= 21600000)
      fail("BACKUP_STALE");
  }
  return mode;
}
function fileEvidence(file) {
  const before = fs.lstatSync(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    before.size > MAX_BYTES
  )
    fail("FILE_INVALID");
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = fs.fstatSync(fd);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      fail("FILE_CHANGED");
    const buffer = Buffer.alloc(opened.size + 1);
    let read = 0;
    while (read < buffer.length) {
      const count = fs.readSync(fd, buffer, read, buffer.length - read, null);
      if (!count) break;
      read += count;
    }
    if (read !== opened.size || fs.fstatSync(fd).size !== opened.size)
      fail("FILE_CHANGED");
    const bytes = buffer.subarray(0, read);
    return { hash: sha(bytes), size: bytes.length, bytes };
  } finally {
    fs.closeSync(fd);
  }
}
function invariant(row) {
  const result = { ...row };
  for (const field of ["fileUrl", "fileSize", "updatedAt"])
    delete result[field];
  return digest(result);
}
function publication(bytes, expectedHash) {
  if (
    bytes.length < 1 ||
    bytes.length > MAX_BYTES ||
    sha(bytes) !== expectedHash ||
    !/<html[\s>]/i.test(bytes.toString("utf8"))
  )
    fail("SOURCE_HTML_INVALID");
  return {
    hash: expectedHash,
    size: bytes.length,
    fileUrl: `/files/cooperation/calculator-rassrochki-${expectedHash}.html`,
  };
}
function plan(rows, currentFile, target, env) {
  if (!Array.isArray(rows) || rows.length > 10000)
    fail("DOCUMENT_SCOPE_INVALID");
  const row = rows.find((item) => item.id === DOC_ID);
  if (
    !row ||
    row.category !== "cooperation" ||
    row.type !== "HTML" ||
    row.isPublic !== true ||
    ![OLD_URL, target.fileUrl].includes(row.fileUrl) ||
    rows.filter((item) => item.category === "cooperation" && item.isPublic)
      .length !== 4 ||
    rows.some((item) => item.id !== DOC_ID && item.fileUrl === target.fileUrl)
  )
    fail("DOCUMENT_SCOPE_CHANGED");
  const othersHash = digest(rows.filter((item) => item.id !== DOC_ID));
  const planHash = digest({
    rows,
    currentFile: { hash: currentFile.hash, size: currentFile.size },
    target,
    sourceSha: env.SOURCE_SHA,
    deployedSha: env.EXPECTED_DEPLOYED_SHA,
  });
  const already = row.fileUrl === target.fileUrl;
  if (
    already &&
    (row.fileSize !== target.size || currentFile.hash !== target.hash)
  )
    fail("PUBLISHED_FILE_CHANGED");
  return {
    row,
    rowsHash: digest(rows),
    othersHash,
    invariantHash: invariant(row),
    planHash,
    already,
    currentFileHash: currentFile.hash,
    currentFileSize: currentFile.size,
  };
}
async function identity(tx, env) {
  const rows =
    await tx.$queryRaw`SELECT current_database() AS name, system_identifier::text AS identifier FROM pg_control_system()`;
  if (
    rows?.length !== 1 ||
    rows[0].name !== "broker_platform" ||
    rows[0].identifier !== env.PRODUCTION_PG_SYSTEM_IDENTIFIER ||
    (await tx.broker.count()) < Number(env.PRODUCTION_MIN_BROKER_ROWS)
  )
    fail("DATABASE_IDENTITY_INVALID");
}
async function documents(tx) {
  return tx.document.findMany({ orderBy: { id: "asc" }, take: 10001 });
}
function currentFilePath(row, root) {
  return path.join(root, path.basename(row.fileUrl));
}
function rootDirectory(root) {
  const stat = fs.lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(root) !== root
  )
    fail("UPLOAD_DIRECTORY_INVALID");
}
function ensureImmutableFile(file, bytes) {
  try {
    const fd = fs.openSync(file, "wx", 0o644);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fchmodSync(fd, 0o644);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const current = fileEvidence(file);
  if (current.hash !== sha(bytes) || current.size !== bytes.length)
    fail("IMMUTABLE_FILE_COLLISION");
  // Retry an existing verified orphan with the same durability guarantees.
  const durable = fs.openSync(
    file,
    fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    fs.fsyncSync(durable);
  } finally {
    fs.closeSync(durable);
  }
  const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}
async function verifyPublic(target, fetchImpl = fetch) {
  const response = await fetchImpl(
    "https://broker.stmichael.ru" + target.fileUrl,
    { redirect: "error", signal: AbortSignal.timeout(20000) },
  );
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => {});
    fail("PUBLIC_FILE_UNAVAILABLE");
  }
  const reader = response.body.getReader(),
    hash = crypto.createHash("sha256");
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (
        !(value instanceof Uint8Array) ||
        value.byteLength > target.size - bytes
      )
        fail("PUBLIC_FILE_HASH_MISMATCH");
      bytes += value.byteLength;
      hash.update(value);
    }
    if (bytes !== target.size || hash.digest("hex") !== target.hash)
      fail("PUBLIC_FILE_HASH_MISMATCH");
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
async function expectedAudit(tx, target, state) {
  const audits = await tx.auditLog.findMany({
    where: { action: ACTION, entity: "Document", entityId: DOC_ID },
    select: { payload: true },
    take: 101,
  });
  if (audits.length > 100) fail("AUDIT_SCOPE_LIMIT");
  const matches = audits.filter(
    (item) => item.payload?.newHash === target.hash,
  );
  if (
    matches.length !== 1 ||
    matches[0].payload.othersHash !== state.othersHash ||
    matches[0].payload.invariantHash !== state.invariantHash
  )
    fail("PUBLICATION_AUDIT_MISMATCH");
  return matches[0].payload;
}
async function run({
  env = process.env,
  prisma,
  uploadRoot = "/app/uploads/cooperation",
  fetchImpl = fetch,
} = {}) {
  const mode = environment(env);
  rootDirectory(uploadRoot);
  const source = fileEvidence(env.SOURCE_HTML);
  const target = publication(source.bytes, env.SOURCE_HTML_SHA256);
  let committed = false;
  let state;
  try {
    state = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await identity(tx, env);
        const rows = await documents(tx),
          row = rows.find((item) => item.id === DOC_ID);
        if (!row || ![OLD_URL, target.fileUrl].includes(row.fileUrl))
          fail("DOCUMENT_SCOPE_CHANGED");
        const current = plan(
          rows,
          fileEvidence(currentFilePath(row, uploadRoot)),
          target,
          env,
        );
        if (current.already) {
          const audit = await expectedAudit(tx, target, current);
          if (
            audit.oldUrl !== OLD_URL ||
            fileEvidence(path.join(uploadRoot, path.basename(OLD_URL))).hash !==
              audit.oldHash
          )
            fail("OLD_FILE_CHANGED");
          current.publishedPlanHash = audit.planHash;
        }
        if (!current.already) {
          const prior = await tx.auditLog.findMany({
            where: { action: ACTION, entity: "Document", entityId: DOC_ID },
            select: { payload: true },
            take: 101,
          });
          if (
            prior.length > 100 ||
            prior.some((item) => item.payload?.newHash === target.hash)
          )
            fail("PRIOR_AUDIT_STATE_MISMATCH");
        }
        return current;
      },
      { isolationLevel: "RepeatableRead", timeout: 20000 },
    );
    const receipt = {
      mode,
      status: state.already ? "ALREADY_PUBLISHED" : "PLANNED",
      planHash: state.planHash,
      currentFileHash: state.currentFileHash,
      currentFileSize: state.currentFileSize,
      newHash: target.hash,
      newSize: target.size,
      newUrl: target.fileUrl,
      publicCooperationDocuments: 4,
      otherDocumentsPreserved: true,
      oldFileKept: true,
      changedRows: 0,
    };
    if (mode === "plan") return receipt;
    if (
      (!state.already && state.planHash !== env.EXPECTED_PLAN_HASH) ||
      (state.already &&
        ![state.planHash, state.publishedPlanHash].includes(
          env.EXPECTED_PLAN_HASH,
        ))
    )
      fail("PLAN_CHANGED");
    environment(env);
    const targetPath = path.join(uploadRoot, path.basename(target.fileUrl));
    ensureImmutableFile(targetPath, source.bytes);
    await verifyPublic(target, fetchImpl);
    if (state.already) return { ...receipt, verified: true };
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '2s'`;
        // No data SELECT before this lock: establish the Serializable snapshot only
        // after every document insert/update writer is excluded for the short CAS.
        await tx.$executeRaw`LOCK TABLE documents IN SHARE ROW EXCLUSIVE MODE`;
        await identity(tx, env);
        await tx.$queryRaw`SELECT id FROM documents WHERE id = ${DOC_ID} FOR UPDATE`;
        const rows = await documents(tx),
          row = rows.find((item) => item.id === DOC_ID);
        if (digest(rows) !== state.rowsHash) fail("DOCUMENT_SNAPSHOT_CHANGED");
        const old = fileEvidence(currentFilePath(row, uploadRoot));
        if (
          old.hash !== state.currentFileHash ||
          old.size !== state.currentFileSize
        )
          fail("OLD_FILE_CHANGED");
        const installed = fileEvidence(targetPath);
        if (installed.hash !== target.hash || installed.size !== target.size)
          fail("IMMUTABLE_FILE_CHANGED");
        environment(env);
        const changed = await tx.document.updateMany({
          where: {
            id: DOC_ID,
            updatedAt: row.updatedAt,
            fileUrl: row.fileUrl,
            fileSize: row.fileSize,
          },
          data: { fileUrl: target.fileUrl, fileSize: target.size },
        });
        if (changed.count !== 1) fail("COMPARE_AND_SWAP_FAILED");
        const after = await documents(tx),
          updated = after.find((item) => item.id === DOC_ID);
        if (
          after.length !== rows.length ||
          digest(after.filter((item) => item.id !== DOC_ID)) !==
            state.othersHash ||
          invariant(updated) !== state.invariantHash ||
          updated.fileUrl !== target.fileUrl ||
          updated.fileSize !== target.size
        )
          fail("POSTWRITE_INVARIANT_FAILED");
        await tx.auditLog.create({
          data: {
            action: ACTION,
            entity: "Document",
            entityId: DOC_ID,
            payload: {
              version: 1,
              sourceSha: env.SOURCE_SHA,
              deployedSha: env.EXPECTED_DEPLOYED_SHA,
              planHash: state.planHash,
              oldUrl: row.fileUrl,
              oldHash: state.currentFileHash,
              newUrl: target.fileUrl,
              newHash: target.hash,
              othersHash: state.othersHash,
              invariantHash: state.invariantHash,
              changedRows: 1,
              oldFileKept: true,
            },
          },
        });
      },
      { isolationLevel: "Serializable", maxWait: 2000, timeout: 2500 },
    );
    committed = true;
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await identity(tx, env);
        const rows = await documents(tx),
          row = rows.find((item) => item.id === DOC_ID);
        const checked = plan(rows, fileEvidence(targetPath), target, env);
        if (
          !checked.already ||
          checked.othersHash !== state.othersHash ||
          invariant(row) !== state.invariantHash
        )
          fail("COMMITTED_READBACK_FAILED");
        await expectedAudit(tx, target, checked);
      },
      { isolationLevel: "RepeatableRead", timeout: 20000 },
    );
    if (
      fileEvidence(path.join(uploadRoot, path.basename(OLD_URL))).hash !==
      state.currentFileHash
    )
      fail("OLD_FILE_CHANGED");
    await verifyPublic(target, fetchImpl);
    return { ...receipt, status: "PUBLISHED", verified: true, changedRows: 1 };
  } catch (error) {
    if (committed) fail("COMMITTED_REQUIRES_READBACK_NO_BLIND_RETRY");
    if (error.safeCode) throw error;
    fail("PUBLICATION_FAILED_REVIEW_OUTCOME");
  }
}
module.exports = {
  run,
  plan,
  publication,
  environment,
  fileEvidence,
  ensureImmutableFile,
  verifyPublic,
  DOC_ID,
  OLD_URL,
  ACTION,
  digest,
};
if (require.main === module) {
  const watchdog = setTimeout(() => {
    console.log('{"status":"FAILED","code":"PROCESS_DEADLINE"}');
    process.exit(1);
  }, 90000);
  const { PrismaClient } = require("/app/node_modules/@st-michael/database");
  const prisma = new PrismaClient({ log: [] });
  run({ prisma })
    .then((receipt) => console.log(JSON.stringify(receipt)))
    .catch((error) => {
      console.log(
        JSON.stringify({
          status: "FAILED",
          code: /^[A-Z_]{1,80}$/.test(error.safeCode || "")
            ? error.safeCode
            : "UNEXPECTED_ERROR",
        }),
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      clearTimeout(watchdog);
      await prisma.$disconnect();
    });
}
