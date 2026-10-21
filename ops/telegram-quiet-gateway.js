"use strict";

// One authenticated bot, one recipient's quiet policy. No database/CRM access.
// Queue acceptance uses 202/queued, NEVER an invented Telegram Message receipt.
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, timingSafeEqual, randomUUID } = require("node:crypto");
const { makeOutbox, quietWindow, validatePolicy, SEND_METHODS, MAX_BODY_BYTES } = require("./telegram-quiet-hours");

function refused() { throw new Error("Telegram gateway refused"); }
function equal(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
async function recipient(body, contentType) {
  let values;
  if (/^application\/json(?:;|$)/i.test(contentType)) {
    const parsed = JSON.parse(body.toString("utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") refused();
    values = [parsed.chat_id];
  } else if (/^application\/x-www-form-urlencoded(?:;|$)/i.test(contentType)) {
    values = new URLSearchParams(body.toString("utf8")).getAll("chat_id");
  } else if (/^multipart\/form-data;/i.test(contentType)) {
    const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
    values = form.getAll("chat_id");
  } else refused();
  if (values.length !== 1 || !["string", "number"].includes(typeof values[0]) ||
    (typeof values[0] === "number" && !Number.isSafeInteger(values[0])) || !/^-?[1-9][0-9]{0,19}$/.test(String(values[0]))) refused();
  return String(values[0]);
}
function postTelegram(token, method, body, contentType) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const req = https.request({ host: "api.telegram.org", port: 443, method: "POST", path: `/bot${token}/${method}`,
      autoSelectFamily: true, timeout: 10000, headers: { "content-type": contentType, "content-length": body.length } }, (response) => {
      const chunks = []; let size = 0;
      response.on("data", (chunk) => { size += chunk.length; if (size > 1024 * 1024) { req.destroy(); finish({ status: 502, payload: null }); } else chunks.push(chunk); });
      response.on("error", () => finish({ status: 502, payload: null }));
      response.on("end", () => {
        let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { payload = null; }
        finish({ status: response.statusCode || 502, payload });
      });
    });
    req.on("timeout", () => req.destroy()); req.on("error", () => finish({ status: 502, payload: null })); req.end(body);
  });
}
function deliveryOutcome(response, chatId) {
  const { status, payload } = response || {};
  const results = Array.isArray(payload?.result) ? payload.result : [payload?.result];
  if (status >= 200 && status < 300 && payload?.ok === true && results.length > 0 && results.every((item) =>
    Number.isSafeInteger(item?.message_id) && item.message_id > 0 && (item.chat === undefined || String(item.chat.id) === chatId))) return { outcome: "confirmed" };
  if (status === 429 && payload?.ok === false && payload.error_code === 429 && Number.isSafeInteger(payload.parameters?.retry_after) &&
    payload.parameters.retry_after >= 1 && payload.parameters.retry_after <= 86400) return { outcome: "rate_limited", retryAfterSeconds: payload.parameters.retry_after };
  if (status >= 400 && status < 500 && payload?.ok === false && payload.error_code === status) return { outcome: "rejected" };
  return { outcome: "unknown" };
}
function createGateway({ token, policy, additionalPolicies = [], directory, clock, post = postTelegram }) {
  policy = validatePolicy(policy);
  if (typeof token !== "string" || !new RegExp(`^${policy.botId}:[A-Za-z0-9_-]{20,}$`).test(token)) refused();
  if (!Array.isArray(additionalPolicies) || additionalPolicies.length > 10) refused();
  const policies = [policy, ...additionalPolicies.map(validatePolicy)];
  if (policies.some(p => p.botId !== policy.botId) || new Set(policies.map(p => p.chatId)).size !== policies.length) refused();
  // Keep the original recipient's durable directory unchanged. Additional
  // recipients get separate, identity-bound queues, not a migrated shared queue.
  const boxes = policies.map((p, i) => ({ policy: p, outbox: makeOutbox({
    directory: i === 0 ? directory : path.join(directory, "recipients", createHash("sha256").update(`${p.botId}:${p.chatId}`).digest("hex")),
    policy: p, clock,
  }) }));
  // Single process serialises durable operations, including its morning worker.
  // No port-independent second sender, no token or payload in logs/receipts.
  let tail = Promise.resolve();
  function serial(fn) { const next = tail.then(fn); tail = next.catch(() => {}); return next; }
  const handle = async (req, res) => {
    const answer = (status, payload) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(payload)); };
    try {
      if (req.url === "/healthz" && req.method === "GET") { answer(200, { ok: true, quietHours: { start: policy.start, end: policy.end, timeZone: policy.timeZone }, additionalQuietHours: additionalPolicies.map(({start,end,timeZone})=>({start,end,timeZone})), worker: "enabled" }); return; }
      // /private is reachable ONLY from the existing private relay. nginx's
      // public location admits the literal /bot... shape, never this prefix.
      const privateRequest = (req.url || "").startsWith("/private/");
      const match = /^\/(?:private\/)?bot([0-9]+:[A-Za-z0-9_-]+)\/([A-Za-z]+)$/.exec(req.url || "");
      if (req.method !== "POST" || !match || (!privateRequest && !equal(match[1], token)) || !SEND_METHODS.includes(match[2])) { answer(403, { ok: false, gatewayRejected: true }); return; }
      const length = Number(req.headers["content-length"] || 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY_BYTES) refused();
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY_BYTES) refused(); chunks.push(chunk); }
      const body = Buffer.concat(chunks), contentType = req.headers["content-type"] || "";
      const chatId = await recipient(body, contentType);
      const scoped = boxes.find(b => b.policy.chatId === chatId && match[1].split(":")[0] === b.policy.botId);
      if (scoped && !equal(match[1], token)) refused();
      if (!scoped || !quietWindow(clock ? clock() : new Date(), scoped.policy).quiet) {
        // Authentication grants exactly the same bot rights as Telegram. Quiet
        // hours only affect the human's approved recipient at night. In daytime
        // return the REAL Telegram response (legacy callers require Message IDs).
        const result = await post(match[1], match[2], body, contentType);
        answer(result.status, result.payload || { ok: false, outcome: "unknown" }); return;
      }
      const supplied = req.headers["x-st-michael-delivery-id"];
      if (supplied !== undefined && (typeof supplied !== "string" || !/^[A-Za-z0-9_.:-]{1,180}$/.test(supplied))) refused();
      const id = supplied ? createHash("sha256").update(`${supplied}:${match[2]}:`).update(body).digest("hex") : randomUUID();
      const receipt = await serial(() => scoped.outbox.enqueue({ id, botId: scoped.policy.botId, chatId, method: match[2], contentType, body }));
      // 202 means durably accepted; workflows must say queued, not delivered.
      answer(202, { ok: false, queued: true, deliveryConfirmed: receipt.deliveryConfirmed, state: receipt.state, resumeAt: receipt.resumeAt });
    } catch { if (!res.headersSent) answer(503, { ok: false, gatewayRejected: true }); else res.end(); }
  };
  const tick = () => serial(async () => {
    const total = {sent:0,pending:0,unknown:0,rejected:0};
    for (const {outbox} of boxes) {
      await outbox.pruneConfirmed();
      const result = await outbox.flush(async (message) => deliveryOutcome(await post(token, message.method, message.body, message.contentType), message.chatId), 1);
      for (const key of Object.keys(total)) total[key] += result[key];
    }
    return total;
  });
  return { handle, tick, recoverAfterExclusiveBind: owned => boxes.map(({outbox})=>outbox.recoverAfterExclusiveBind(owned)) };
}
function main() {
  const filename = process.env.TELEGRAM_QUIET_POLICY || "/policy/policy.json";
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) refused();
  const config = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!["policy,token", "additionalPolicies,policy,token"].includes(Object.keys(config).sort().join())) refused();
  const gateway = createGateway({ ...config, directory: process.env.TELEGRAM_QUIET_DIRECTORY || "/data/outbox" });
  const server = http.createServer(gateway.handle);
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  let busy = false, ready = false, lastProblems = "";
  const timer = setInterval(async () => {
    if (busy || !ready) return; busy = true;
    try {
      const result = await gateway.tick(), problems = `${result.unknown}:${result.rejected}`;
      if (result.sent || ((result.unknown || result.rejected) && problems !== lastProblems)) console.log(JSON.stringify(result));
      lastProblems = problems;
    }
    catch { console.error("telegram_quiet_worker_refused=true"); }
    finally { busy = false; }
  }, 1200);
  server.on("error", () => { clearInterval(timer); console.error("telegram_quiet_start_refused=true"); process.exitCode = 1; });
  server.listen(Number(process.env.RELAY_PORT || 18082), process.env.RELAY_BIND || "172.18.0.1", () => {
    try { gateway.recoverAfterExclusiveBind(true); ready = true; }
    catch { clearInterval(timer); server.close(); console.error("telegram_quiet_recovery_refused=true"); process.exitCode = 1; }
  });
}
module.exports = { recipient, deliveryOutcome, createGateway, postTelegram };
if (require.main === module) { try { main(); } catch { console.error("telegram_quiet_start_refused=true"); process.exitCode = 1; } }
