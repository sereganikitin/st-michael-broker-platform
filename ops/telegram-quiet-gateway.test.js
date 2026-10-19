"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { recipient, deliveryOutcome, createGateway } = require("./telegram-quiet-gateway");
const token = "123:fixture_token_not_a_real_token";
const policy = { botId: "123", chatId: "456", start: "22:00", end: "09:00", timeZone: "Europe/Moscow" };
async function fixture(t, instant = "2026-10-19T19:00:00Z") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tg-gateway-test-"));
  let now = new Date(instant), calls = [];
  const gateway = createGateway({ token, policy, directory, clock: () => now, post: async (...args) => {
    calls.push(args); return { status: 200, payload: { ok: true, result: { message_id: calls.length, chat: { id: 456 } } } };
  } });
  const server = http.createServer(gateway.handle); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, calls, gateway, time: (value) => { now = new Date(value); },
    request: (body = { chat_id: "456", text: "fixture" }, headers = {}, secret = token, method = "sendMessage") =>
      fetch(`http://127.0.0.1:${server.address().port}/bot${secret}/${method}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }) };
}
test("JSON and URL-encoded recipients are parsed strictly", async () => {
  assert.equal(await recipient(Buffer.from('{"chat_id":456}'), "application/json"), "456");
  assert.equal(await recipient(Buffer.from("chat_id=-456&text=fixture"), "application/x-www-form-urlencoded"), "-456");
  await assert.rejects(() => recipient(Buffer.from("chat_id=1&chat_id=2"), "application/x-www-form-urlencoded"));
  await assert.rejects(() => recipient(Buffer.from('{"chat_id":1.5}'), "application/json"));
});
test("multipart bytes, including a document, are persisted intact", async (t) => {
  const f = await fixture(t);
  const form = new FormData(); form.set("chat_id", "456"); form.set("document", new Blob(["fixture-file"]), "fixture.txt");
  const request = new Request("http://fixture", { method: "POST", body: form });
  const bytes = Buffer.from(await request.arrayBuffer()), contentType = request.headers.get("content-type");
  assert.equal(await recipient(bytes, contentType), "456");
  const root = http.createServer(f.gateway.handle); await new Promise((resolve) => root.listen(0, "127.0.0.1", resolve));
  t.after(() => root.close());
  const response = await fetch(`http://127.0.0.1:${root.address().port}/bot${token}/sendDocument`, { method: "POST", headers: { "content-type": contentType }, body: bytes });
  assert.equal(response.status, 202); await f.gateway.tick(); assert.equal(f.calls.length, 0);
  f.time("2026-10-20T06:00:00Z"); await f.gateway.tick(); assert.deepEqual(f.calls[0][2], bytes);
});
test("night acceptance is explicitly queued, not a Telegram success or delivery receipt", async (t) => {
  const f = await fixture(t); const response = await f.request(); const payload = await response.json();
  assert.equal(response.status, 202); assert.equal(payload.ok, false); assert.equal(payload.queued, true);
  assert.equal(payload.deliveryConfirmed, false); assert.equal(payload.result, undefined);
  await f.gateway.tick(); assert.equal(f.calls.length, 0);
  f.time("2026-10-20T06:00:00Z"); assert.equal((await f.gateway.tick()).sent, 1); assert.equal(f.calls.length, 1);
  await f.gateway.tick(); assert.equal(f.calls.length, 1);
});
test("authentication and method limits reject before any outgoing request", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request(undefined, {}, "123:other_fixture_token_value")).status, 403);
  assert.equal((await f.request(undefined, {}, token, "deleteMessage")).status, 403);
  await f.gateway.tick(); assert.equal(f.calls.length, 0); assert.equal(fs.readdirSync(f.directory).length, 0);
});
test("the recipient's quiet hours do not mute other chats", async (t) => {
  const f = await fixture(t); assert.equal((await f.request({ chat_id: "999", text: "fixture" })).status, 200);
  assert.equal(f.calls.length, 1); assert.equal((await f.gateway.tick()).pending, 0);
});
test("daytime returns a genuine Telegram receipt, not a queued success", async (t) => {
  const f = await fixture(t, "2026-10-19T06:00:00Z");
  const response = await f.request(), receipt = await response.json();
  assert.equal(response.status, 200); assert.equal(receipt.ok, true); assert.equal(receipt.result.message_id, 1);
  assert.equal(f.calls.length, 1); assert.equal(fs.readdirSync(f.directory).length, 0);
});
test("a rotated private token for the same scoped bot cannot bypass quiet hours", async (t) => {
  const f = await fixture(t);
  const server = http.createServer(f.gateway.handle); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/private/bot123:other_fixture_token_value/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"chat_id":"456","text":"fixture"}',
  });
  assert.equal(response.status, 503); assert.equal(f.calls.length, 0);
});
test("stable caller identity suppresses repeated queue acceptance, not different jobs", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) await f.request(undefined, { "x-st-michael-delivery-id": "workflow:1:step-a" });
  await f.request(undefined, { "x-st-michael-delivery-id": "workflow:2:step-a" });
  assert.equal((await f.gateway.tick()).pending, 2);
});
test("only coherent provider receipts count as delivered", () => {
  assert.equal(deliveryOutcome({ status: 200, payload: { ok: true } }, "456").outcome, "unknown");
  assert.equal(deliveryOutcome({ status: 200, payload: { ok: true, result: { message_id: 1, chat: { id: 999 } } } }, "456").outcome, "unknown");
  assert.equal(deliveryOutcome({ status: 502, payload: { ok: false } }, "456").outcome, "unknown");
  assert.equal(deliveryOutcome({ status: 403, payload: { ok: false, error_code: 403 } }, "456").outcome, "rejected");
  assert.deepEqual(deliveryOutcome({ status: 429, payload: { ok: false, error_code: 429, parameters: { retry_after: 10 } } }, "456"),
    { outcome: "rate_limited", retryAfterSeconds: 10 });
});
