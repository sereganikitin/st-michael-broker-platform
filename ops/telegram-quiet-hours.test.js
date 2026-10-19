"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { quietWindow, makeOutbox, validatePolicy } = require("./telegram-quiet-hours");
const policy = { botId: "123", chatId: "456", start: "22:00", end: "09:00", timeZone: "Europe/Moscow" };
const message = (id = "job-1") => ({ id, botId: "123", chatId: "456", method: "sendMessage", contentType: "application/json", body: Buffer.from('{"chat_id":"456","text":"fixture"}') });
function setup(t, instant = "2026-10-12T19:00:00Z") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tg-quiet-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = new Date(instant);
  return { directory, make: () => makeOutbox({ directory, policy, clock: () => now }), time: (value) => { now = new Date(value); } };
}
test("Moscow boundaries are 22:00 inclusive and 09:00 exclusive", () => {
  for (const [instant, quiet, resume] of [
    ["2026-10-12T18:59:59Z", false], ["2026-10-12T19:00:00Z", true, "2026-10-13T06:00:00.000Z"],
    ["2026-10-13T05:59:59Z", true, "2026-10-13T06:00:00.000Z"], ["2026-10-13T06:00:00Z", false],
    ["2026-12-31T20:00:00Z", true, "2027-01-01T06:00:00.000Z"],
  ]) {
    const window = quietWindow(new Date(instant)); assert.equal(window.quiet, quiet);
    if (resume) assert.equal(window.resumeAt.toISOString(), resume);
  }
});
test("policy cannot silently broaden to other recipients or time zones", () => {
  assert.throws(() => validatePolicy({ ...policy, timeZone: "UTC" }));
  assert.throws(() => validatePolicy({ ...policy, end: "08:00" }));
  assert.throws(() => validatePolicy({ ...policy, allChats: true }));
});
test("night enqueue persists but never calls sender or claims delivery", async (t) => {
  const fixture = setup(t), outbox = fixture.make();
  const receipt = await outbox.enqueue(message()); assert.equal(receipt.deliveryConfirmed, false);
  let calls = 0; const result = await outbox.flush(() => { calls++; });
  assert.equal(calls, 0); assert.equal(result.pending, 1); assert.equal(result.quiet, true);
});
test("queue survives restart and sends only after 09:00 Moscow", async (t) => {
  const fixture = setup(t); await fixture.make().enqueue(message());
  fixture.time("2026-10-13T06:00:00Z"); let calls = 0;
  const restarted = fixture.make();
  assert.equal((await restarted.flush(async (item) => {
    calls++; assert.deepEqual(item, message()); return { outcome: "confirmed" };
  })).sent, 1);
  await restarted.flush(async () => { calls++; return { outcome: "confirmed" }; }); assert.equal(calls, 1);
});
test("job identity deduplicates retries, not separate notifications", async (t) => {
  const fixture = setup(t), outbox = fixture.make();
  await outbox.enqueue(message()); await outbox.enqueue(message()); await outbox.enqueue(message("job-2"));
  assert.equal((await outbox.flush(async () => assert.fail("night send"))).pending, 2);
  await assert.rejects(() => outbox.enqueue({ ...message(), body: Buffer.from("different") }));
});
test("wrong recipient and unbounded content are refused before persistence", async (t) => {
  const fixture = setup(t), outbox = fixture.make();
  await assert.rejects(() => outbox.enqueue({ ...message(), chatId: "999" }));
  await assert.rejects(() => outbox.enqueue({ ...message(), body: Buffer.alloc(25 * 1024 * 1024 + 1) }));
  assert.equal(fs.readdirSync(fixture.directory).length, 0);
});
test("unknown provider response never triggers automatic resend", async (t) => {
  const fixture = setup(t, "2026-10-13T06:00:00Z"), outbox = fixture.make();
  await outbox.enqueue(message()); let calls = 0;
  assert.equal((await outbox.flush(async () => { calls++; throw new Error("private provider detail"); })).unknown, 1);
  const report = await fixture.make().flush(async () => { calls++; });
  assert.equal(calls, 1); assert.equal(report.unknown, 1); assert.equal(JSON.stringify(report).includes("private"), false);
});
test("night boundary is checked before every queued delivery", async (t) => {
  const fixture = setup(t, "2026-10-12T18:59:59Z"), outbox = fixture.make();
  await outbox.enqueue(message()); await outbox.enqueue(message("job-2"));
  let calls = 0; const result = await outbox.flush(async () => {
    calls++; fixture.time("2026-10-12T19:00:00Z"); return { outcome: "confirmed" };
  });
  assert.equal(calls, 1); assert.equal(result.pending, 1);
});
test("sender rejection is retained without false SENT state", async (t) => {
  const fixture = setup(t, "2026-10-13T06:00:00Z"), outbox = fixture.make(); await outbox.enqueue(message());
  assert.equal((await outbox.flush(async () => ({ outcome: "rejected" }))).rejected, 1);
  const receipt = await outbox.enqueue(message()); assert.equal(receipt.deliveryConfirmed, false); assert.equal(receipt.state, "REJECTED");
});
test("an interrupted SENDING record becomes UNKNOWN without another POST", async (t) => {
  const fixture = setup(t, "2026-10-13T06:00:00Z"), outbox = fixture.make();
  await outbox.enqueue(message());
  const name = fs.readdirSync(fixture.directory).find((entry) => entry.endsWith(".json"));
  const target = path.join(fixture.directory, name);
  const entry = JSON.parse(fs.readFileSync(target, "utf8")); entry.state = "SENDING";
  fs.writeFileSync(target, JSON.stringify(entry));
  assert.equal((await fixture.make().flush(async () => assert.fail("must not retry ambiguous POST"))).unknown, 1);
});
test("concurrent workers cannot send the same message twice", async (t) => {
  const fixture = setup(t, "2026-10-13T06:00:00Z"), outbox = fixture.make(); await outbox.enqueue(message());
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = outbox.flush(async () => { await gate; return { outcome: "confirmed" }; });
  await assert.rejects(async () => fixture.make().flush(async () => assert.fail("second worker")), /operation refused/);
  release(); assert.equal((await first).sent, 1);
});
test("an existing worker lock is never expired or stolen automatically", async (t) => {
  const fixture = setup(t), outbox = fixture.make();
  fs.writeFileSync(path.join(fixture.directory, ".worker.lock"), "", { mode: 0o600 });
  await assert.rejects(async () => outbox.enqueue(message()), /operation refused/);
  assert.equal(fs.existsSync(path.join(fixture.directory, ".worker.lock")), true);
});
test("exclusive gateway restart preserves unknown outcomes and permits new queue acceptance", async (t) => {
  const fixture = setup(t), outbox = fixture.make(); await outbox.enqueue(message());
  const filename = fs.readdirSync(fixture.directory).find(name => name.endsWith(".json"));
  const target = path.join(fixture.directory, filename), entry = JSON.parse(fs.readFileSync(target, "utf8"));
  entry.state = "SENDING"; fs.writeFileSync(target, JSON.stringify(entry));
  fs.writeFileSync(path.join(fixture.directory, ".worker.lock"), "", { mode: 0o600 });
  assert.throws(() => outbox.recoverAfterExclusiveBind(false));
  assert.equal(outbox.recoverAfterExclusiveBind(true).recovered, true);
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).state, "UNKNOWN");
  await outbox.enqueue(message("new-job"));
  assert.equal((await outbox.flush(async () => assert.fail("night send"))).pending, 1);
});
test("confirmed 429 rejection may retry later without retrying an uncertain POST", async (t) => {
  const fixture = setup(t, "2026-10-20T06:00:00Z"), outbox = fixture.make(); await outbox.enqueue(message());
  const result = await outbox.flush(async () => ({ outcome: "rate_limited", retryAfterSeconds: 10 }));
  assert.equal(result.pending, 1);
  await outbox.flush(async () => assert.fail("retry before retry_after"));
  fixture.time("2026-10-20T06:00:10Z");
  assert.equal((await outbox.flush(async () => ({ outcome: "confirmed" }))).sent, 1);
});
