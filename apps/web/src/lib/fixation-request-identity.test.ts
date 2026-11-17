import assert from "node:assert/strict";
import test from "node:test";
import { fixationRequestIdentity } from "./fixation-request-identity";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
test("a reload and a lost response keep the same submission identity", async () => {
  const saved = storage();
  const payload = { phone: "+79990000001", fullName: "Private Name" };
  const one = await fixationRequestIdentity("actor", payload, saved);
  const two = await fixationRequestIdentity("actor", payload, saved);
  assert.equal(one.key, two.key);
  assert.ok(!JSON.stringify([...saved.values]).includes("79990000001"));
  assert.ok(!JSON.stringify([...saved.values]).includes("Private Name"));
  assert.notEqual(
    one.key,
    (await fixationRequestIdentity("another-actor", payload, saved)).key,
  );
  assert.notEqual(
    one.key,
    (
      await fixationRequestIdentity(
        "actor",
        { ...payload, project: "ZORGE9" },
        saved,
      )
    ).key,
  );
  saved.values.delete(one.storageKey); // explicit new-fixation action
  assert.notEqual(
    one.key,
    (await fixationRequestIdentity("actor", payload, saved)).key,
  );
});
test("storage failure fails before any disposable request can be submitted", async () => {
  await assert.rejects(
    fixationRequestIdentity(
      "actor",
      {},
      {
        getItem: () => null,
        setItem: () => {
          throw Error("storage disabled");
        },
      },
    ),
    /Не удалось сохранить/,
  );
});
