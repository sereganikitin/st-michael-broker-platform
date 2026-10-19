"use strict";

// Transport-independent outbox. Acceptance is NOT Telegram delivery. Callers
// must retain PENDING until a real, coherent Telegram acknowledgement arrives.
// Deliberately no CLI, timer or default policy: importing cannot send anything.
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_PENDING = 1000;
const MAX_QUEUE_BYTES = 64 * 1024 * 1024;
const SEND_METHODS = Object.freeze(["sendMessage", "sendDocument", "sendPhoto", "sendVideo", "sendAnimation", "sendAudio", "sendVoice", "sendMediaGroup", "forwardMessage", "forwardMessages", "copyMessage", "copyMessages", "sendSticker", "sendVideoNote", "sendLocation", "sendVenue", "sendContact", "sendPoll", "sendDice", "sendInvoice"]);
const MOSCOW = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Moscow", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", hourCycle: "h23",
});

function refuse() { throw new Error("Telegram quiet-hours operation refused"); }
function quietWindow(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) refuse();
  const parts = Object.fromEntries(MOSCOW.formatToParts(now).map(({ type, value }) => [type, value]));
  const hour = Number(parts.hour);
  const quiet = hour >= 22 || hour < 9;
  // Moscow is UTC+03:00 for this fixed policy. Intl is used for the local day,
  // never the host timezone. UTC date arithmetic handles month/year rollover.
  const resumeAt = quiet ? new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1,
    Number(parts.day) + (hour >= 22 ? 1 : 0), 6)) : now;
  return { quiet, resumeAt };
}

function validatePolicy(policy) {
  if (!policy || Object.keys(policy).sort().join() !== "botId,chatId,end,start,timeZone" ||
    !/^[1-9][0-9]{0,19}$/.test(policy.botId) || !/^-?[1-9][0-9]{0,19}$/.test(policy.chatId) ||
    policy.start !== "22:00" || policy.end !== "09:00" || policy.timeZone !== "Europe/Moscow") refuse();
  return Object.freeze({ ...policy });
}

function validateMessage(message, policy) {
  if (!message || Object.keys(message).sort().join() !== "body,botId,chatId,contentType,id,method" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(message.id) || message.botId !== policy.botId || message.chatId !== policy.chatId ||
    !SEND_METHODS.includes(message.method) ||
    typeof message.contentType !== "string" || message.contentType.length > 256 || /[\r\n]/.test(message.contentType) ||
    !Buffer.isBuffer(message.body) || message.body.length === 0 || message.body.length > MAX_BODY_BYTES) refuse();
}

function makeOutbox({ directory, policy, clock = () => new Date() }) {
  policy = validatePolicy(policy);
  if (typeof directory !== "string" || !path.isAbsolute(directory) || path.resolve(directory) === path.parse(directory).root) refuse();
  const root = path.resolve(directory);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) refuse();
  if (process.platform !== "win32" && (stat.mode & 0o077)) refuse();

  function file(id) { return path.join(root, `${createHash("sha256").update(id).digest("hex")}.json`); }
  function read(target) {
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const entryStat = fs.fstatSync(fd);
      if (!entryStat.isFile() || entryStat.size > MAX_BODY_BYTES * 1.4 + 2048 ||
        (process.platform !== "win32" && (entryStat.mode & 0o077))) refuse();
      const value = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (value.version !== 1 || !["PENDING", "SENDING", "SENT", "UNKNOWN", "REJECTED"].includes(value.state) ||
        value.botId !== policy.botId || value.chatId !== policy.chatId || !Number.isFinite(Date.parse(value.createdAt))) refuse();
      validateMessage({ ...value.message, body: Buffer.from(value.message.body, "base64") }, policy);
      return value;
    } finally { fs.closeSync(fd); }
  }
  function write(target, value, exclusive = false) {
    const temp = path.join(root, `.${randomUUID()}.tmp`);
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      if (exclusive) fs.linkSync(temp, target); else fs.renameSync(temp, target);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    if (process.platform !== "win32") {
      const directoryFd = fs.openSync(root, "r");
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
  }
  function entries() {
    const names = fs.readdirSync(root).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    if (names.length > MAX_PENDING) refuse();
    return names.map((name) => ({ target: path.join(root, name), value: read(path.join(root, name)) }));
  }
  function lock(callback) {
    const target = path.join(root, ".worker.lock");
    let fd;
    try { fd = fs.openSync(target, "wx", 0o600); } catch { refuse(); }
    // Never steal/expire a lock automatically: another worker may still send.
    return Promise.resolve().then(callback).finally(() => { fs.closeSync(fd); fs.unlinkSync(target); });
  }

  async function enqueue(message) {
    validateMessage(message, policy);
    return lock(() => {
      const target = file(message.id);
      if (fs.existsSync(target)) {
        const prior = read(target);
        const bytes = { ...message, body: message.body.toString("base64") };
        if (JSON.stringify(prior.message) !== JSON.stringify(bytes)) refuse();
        return { accepted: true, deliveryConfirmed: prior.state === "SENT", state: prior.state };
      }
      const existing = entries();
      if (existing.length >= MAX_PENDING || existing.reduce((sum, entry) => sum + fs.statSync(entry.target).size, 0) + message.body.length * 1.4 + 2048 > MAX_QUEUE_BYTES) refuse();
      const now = clock();
      const entry = { version: 1, state: "PENDING", botId: policy.botId, chatId: policy.chatId,
        createdAt: now.toISOString(), message: { ...message, body: message.body.toString("base64") } };
      write(target, entry, true);
      return { accepted: true, deliveryConfirmed: false, state: "PENDING", resumeAt: quietWindow(now).resumeAt.toISOString() };
    });
  }

  async function flush(send, limit = MAX_PENDING) {
    if (typeof send !== "function" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PENDING) refuse();
    return lock(async () => {
      const result = { sent: 0, pending: 0, unknown: 0, rejected: 0, quiet: quietWindow(clock()).quiet };
      const batch = entries().sort((a, b) => a.value.createdAt.localeCompare(b.value.createdAt) || a.target.localeCompare(b.target));
      let attempted = 0;
      for (const { target, value } of batch) {
        // Crash during a POST is indeterminate, not permission to POST again.
        if (value.state === "SENDING") { value.state = "UNKNOWN"; write(target, value); }
        if (value.state === "UNKNOWN") { result.unknown++; continue; }
        if (value.state === "REJECTED") { result.rejected++; continue; }
        if (value.state !== "PENDING") continue;
        if (quietWindow(clock()).quiet || attempted >= limit || (value.notBefore && Date.parse(value.notBefore) > clock().getTime())) { result.pending++; continue; }
        attempted++;
        value.state = "SENDING"; write(target, value);
        let receipt;
        try { receipt = await send({ ...value.message, body: Buffer.from(value.message.body, "base64") }); }
        catch { receipt = { outcome: "unknown" }; }
        // No provider response bodies, tokens or message contents in receipts.
        if (receipt?.outcome === "confirmed") { value.state = "SENT"; result.sent++; }
        else if (receipt?.outcome === "rate_limited" && Number.isSafeInteger(receipt.retryAfterSeconds) && receipt.retryAfterSeconds >= 1 && receipt.retryAfterSeconds <= 86400) {
          value.state = "PENDING"; value.notBefore = new Date(clock().getTime() + receipt.retryAfterSeconds * 1000).toISOString(); result.pending++;
        }
        else if (receipt?.outcome === "rejected") { value.state = "REJECTED"; result.rejected++; }
        else { value.state = "UNKNOWN"; result.unknown++; }
        write(target, value);
      }
      return result;
    });
  }
  async function pruneConfirmed() {
    return lock(() => {
      let pruned = 0;
      for (const { target, value } of entries()) {
        if (value.state === "SENT" && clock().getTime() - Date.parse(value.createdAt) > 7 * 86400000) { fs.unlinkSync(target); pruned++; }
      }
      return { pruned };
    });
  }
  function recoverAfterExclusiveBind(exclusiveBindOwned) {
    // Only the sole gateway listener may recover its OWN file mutex after a
    // process restart. This is unrelated to any business/Redis/CRM lease.
    if (exclusiveBindOwned !== true) refuse();
    const target = path.join(root, ".worker.lock");
    if (!fs.existsSync(target)) return { recovered: false };
    const lockStat = fs.lstatSync(target);
    if (!lockStat.isFile() || lockStat.isSymbolicLink() || (process.platform !== "win32" && (lockStat.mode & 0o077))) refuse();
    for (const entry of entries()) {
      if (entry.value.state === "SENDING") { entry.value.state = "UNKNOWN"; write(entry.target, entry.value); }
    }
    fs.unlinkSync(target);
    return { recovered: true };
  }
  return Object.freeze({ enqueue, flush, pruneConfirmed, recoverAfterExclusiveBind });
}

module.exports = { quietWindow, validatePolicy, makeOutbox, SEND_METHODS, MAX_BODY_BYTES };
