"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const file = path.join(
  __dirname,
  "../seed-data/documents/calculator-rassrochki-2026-09.html",
);
const html = fs.readFileSync(file, "utf8");
function script(id) {
  const match = new RegExp(
    `<script[^>]+id="${id}"[^>]*>([\\s\\S]*?)</script>`,
    "i",
  ).exec(html);
  assert.ok(match, `missing ${id} script`);
  return match[1];
}
const config = JSON.parse(script("conditions"));
function engine() {
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(script("engine"), sandbox, { timeout: 1000 });
  sandbox.module.exports.setConfig(config);
  return sandbox.module.exports;
}
function scheduleIsBalanced(result) {
  const api = engine();
  assert.equal(
    api.xround(
      result.schedule.reduce((sum, row) => sum + row.pay, 0),
      2,
    ),
    api.xround(result.S, 2),
  );
  assert.equal(api.xround(result.schedule.at(-1).rest, 2), 0);
  assert.ok(
    result.schedule.every((row) => Number.isFinite(row.pay) && row.pay >= 0),
  );
}

test("reviewed source conditions are ported without altering existing local editor authorization", () => {
  const expected = JSON.parse(script("conditions"));
  delete expected.admin;
  assert.equal(
    crypto.createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
    "f0321a1afcf7c63504a3ce064bd5b8e145f81ade578a978e1813d38300ce2e0a",
  );
  assert.equal(expected.serbor.programs.tenten.fixedTerm, 8);
  assert.equal(expected.zorge.promo.secondDate, "25.12.2026");
  assert.ok(fs.statSync(file).size > 100 * 1024);
});

test("Silver Bor replaces nine-month tables and 10/10/remainder with eight months", () => {
  assert.equal(config.serbor.programs.tenten.fixedTerm, 8);
  const expected = {
    standard: {
      monthly: [0.175, 0.179, 0.182, 0.185, 0.186, 0.188],
      quarterly: [0.17, 0.174, 0.178, 0.18, 0.183, 0.186],
      half: [0.153, 0.159, 0.166, 0.171, 0.173, 0.175],
    },
    reduced: {
      monthly: [0.125, 0.129, 0.132, 0.135, 0.136, 0.138],
      quarterly: [0.12, 0.124, 0.128, 0.13, 0.133, 0.136],
      half: [0.103, 0.109, 0.116, 0.121, 0.123, 0.125],
    },
  };
  for (const set of ["standard", "reduced"])
    for (const program of ["monthly", "quarterly", "half"]) {
      assert.deepEqual(
        config.serbor[set][program]["8"],
        expected[set][program],
      );
      assert.equal(config.serbor[set][program]["9"], undefined);
    }
  assert.match(config.serbor.programs.tenten.hint, /Срок 8 месяцев/);
});

test("Zorge one-room discount changes remain distinct by term and first installment", () => {
  const lot = config.zorge.lots.oneRoom;
  assert.equal(lot.monthly[18][2], 0.18);
  assert.equal(lot.half[9][2], 0.198);
  assert.deepEqual(lot.half[12].slice(2, 4), [0.185, 0.195]);
  assert.deepEqual(lot.half[15].slice(2, 5), [0.165, 0.185, 0.19]);
  assert.deepEqual(lot.half[18].slice(2, 5), [0.145, 0.175, 0.185]);
});

test("Zorge 5 plus 15 promotion preserves both schedules, discounts and calendar", () => {
  assert.deepEqual(config.zorge.programs.promoEq, {
    label: "5% + 15% · равные платежи",
    fixedPv: 0.05,
    fixedTerm: 12,
    promo: "eq",
  });
  assert.deepEqual(config.zorge.programs.promoFix, {
    label: "5% + 15% · фиксированный платёж",
    fixedPv: 0.05,
    fixedTerm: 12,
    promo: "fix",
  });
  assert.deepEqual(config.zorge.promo, {
    discountEq: 0.13,
    discountFix: 0.05,
    secondPct: 0.15,
    secondDate: "25.12.2026",
    firstMonth: "01.2027",
    payments: 10,
    fixedPayment: 150000,
  });
});

test("promotion equal payments include first 5%, separate 15% and ten balanced payments", () => {
  const api = engine();
  const result = api.calcFlat({
    price: 10000000,
    dvou: 100000,
    pv: 0.05,
    term: 12,
    program: "promoEq",
    discount: 0.13,
  });
  assert.equal(result.S, 8600000);
  assert.equal(result.PV, 430000);
  assert.equal(result.second, 1290000);
  assert.equal(result.regular, 688000);
  assert.equal(result.count, 10);
  assert.equal(result.schedule.length, 12);
  assert.equal(result.last, 688000);
  assert.equal(result.total, 8700000);
  scheduleIsBalanced(result);
});

test("promotion fixed payments retain the final remainder rather than ten equal payments", () => {
  const api = engine();
  const result = api.calcFlat({
    price: 10000000,
    dvou: 100000,
    pv: 0.05,
    term: 12,
    program: "promoFix",
    discount: 0.05,
  });
  assert.equal(result.S, 9400000);
  assert.equal(result.PV, 470000);
  assert.equal(result.second, 1410000);
  assert.equal(result.regular, 150000);
  assert.equal(result.count, 10);
  assert.equal(result.last, 6170000);
  scheduleIsBalanced(result);
});

test("parking deducts DVOu from financed value and includes it in the total", () => {
  assert.equal(config.parking.dvou, 50000);
  const api = engine();
  const without = api.calcParking({
    price: 3500000,
    dvou: 0,
    dop: 0,
    pv: 0.4,
    term: 12,
    program: "monthly",
    corr: 0,
  });
  const withDvou = api.calcParking({
    price: 3500000,
    dvou: 50000,
    dop: 0,
    pv: 0.4,
    term: 12,
    program: "monthly",
    corr: 0,
  });
  assert.equal(withDvou.S, without.S - 50000);
  assert.equal(withDvou.PV, 1380000);
  assert.equal(withDvou.regular, 172500);
  assert.equal(withDvou.total, without.total);
  scheduleIsBalanced(withDvou);
  const full = api.calcParking({
    price: 3500000,
    dvou: 50000,
    dop: 0,
    pv: 1,
    term: 12,
    program: "monthly",
    corr: 0,
  });
  assert.equal(
    full.S + full.dvou,
    3500000 * (1 - config.parking.fullPaymentDiscount),
  );
  scheduleIsBalanced(full);
});

test("standard schedules balance to cents for every available term", () => {
  const api = engine();
  let cases = 0;
  for (const [program, table] of Object.entries(config.serbor.standard)) {
    if (!table || typeof table !== "object") continue;
    for (const [term, values] of Object.entries(table))
      for (let column = 0; column < config.serbor.pv.length; column++) {
        const discount = values[column];
        if (discount === null || discount === undefined) continue;
        scheduleIsBalanced(
          api.calcFlat({
            price: 48070475,
            dvou: 480704.75,
            pv: config.serbor.pv[column],
            term: Number(term),
            program,
            discount,
          }),
        );
        cases++;
      }
  }
  for (const lot of Object.values(config.zorge.lots))
    for (const [program, table] of Object.entries(lot)) {
      if (!["monthly", "half"].includes(program)) continue;
      for (const [term, values] of Object.entries(table))
        for (let column = 0; column < config.zorge.pv.length; column++) {
          const discount = values[column];
          if (discount === null || discount === undefined) continue;
          scheduleIsBalanced(
            api.calcFlat({
              price: 30000000,
              dvou: 100000,
              pv: config.zorge.pv[column],
              term: Number(term),
              program,
              discount,
            }),
          );
          cases++;
        }
    }
  assert.ok(cases > 200);
});

test("authored calculator scripts have only required external libraries and no account-network access", () => {
  const external = [
    ...new Set(
      [...html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi)].map(
        (match) => match[1],
      ),
    ),
  ];
  assert.deepEqual(external, [
    "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  ]);
  const authored = script("engine") + "\n" + script("app");
  assert.ok(
    !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|document\.cookie|\beval\s*\(|new\s+Function|WebSocket|serviceWorker|postMessage|location\.(?:href|assign|replace)/.test(
      authored,
    ),
  );
  assert.ok(
    !/<form[^>]+action\s*=|<base\b|<iframe\b|<object\b|<embed\b/i.test(html),
  );
  const images = JSON.parse(script("assets"));
  assert.ok(
    Object.values(images).every((value) =>
      /^data:image\/png;base64,/.test(value),
    ),
  );
  assert.ok(!authored.includes("window.claude"));
  assert.ok(!authored.includes("art.publish"));
  assert.ok(!html.includes("xlsx.full.min.js"));
  assert.ok(authored.includes("pdf.save(fname)"));
  assert.ok(!authored.includes("commissionPolicy"));
});

test("eight-month quarterly keeps the source regular formula and pays the remainder at term end", () => {
  const api = engine();
  const result = api.calcFlat({
    price: 48070475,
    dvou: 480704.75,
    pv: 0.3,
    term: 8,
    program: "quarterly",
    discount: 0.17,
  });
  assert.equal(result.regular, api.xround(((result.S - result.PV) / 8) * 3, 2));
  assert.equal(result.count, 3);
  assert.equal(result.schedule[1].pay, result.regular);
  assert.equal(result.schedule[2].pay, result.regular);
  assert.equal(
    result.schedule[3].pay,
    api.xround(result.S - result.PV - 2 * result.regular, 2),
  );
  scheduleIsBalanced(result);
  const page = hostedCalculator();
  page.change("program", "quarterly");
  page.change("term", "8");
  assert.ok(page.result().includes("Месяц 3"));
  assert.ok(page.result().includes("Месяц 6"));
  assert.ok(page.result().includes("Месяц 8"));
  assert.ok(!page.result().includes("Месяц 9"));
});

test("displayed payment cents add up exactly for every available program", () => {
  const api = engine();
  const cents = (value) => Math.round(api.xround(value, 2) * 100);
  let checked = 0;
  const check = (result) => {
    assert.equal(
      result.schedule.reduce((sum, row) => sum + cents(row.pay), 0),
      cents(result.S),
    );
    assert.equal(cents(result.schedule.at(-1).rest), 0);
    assert.ok(result.schedule.every((row) => row.pay >= 0 && row.rest >= 0));
    for (const row of result.schedule)
      assert.equal(row.pay, Number(row.pay.toFixed(2)));
    checked++;
  };
  for (const set of [config.serbor.standard, config.serbor.reduced]) {
    for (const program of ["monthly", "quarterly", "half"])
      for (const [term, discounts] of Object.entries(set[program])) {
        discounts.forEach((discount, index) => {
          if (discount !== null)
            check(
              api.calcFlat({
                price: 48070475,
                dvou: 480704.75,
                pv: config.serbor.pv[index],
                term: Number(term),
                program,
                discount,
              }),
            );
        });
      }
    check(
      api.calcFlat({
        price: 48070475,
        dvou: 480704.75,
        pv: 0.1,
        term: 8,
        program: "tenten",
        discount: set.tenten,
      }),
    );
  }
  for (const lot of Object.values(config.zorge.lots))
    for (const program of ["monthly", "half"])
      for (const [term, discounts] of Object.entries(lot[program]))
        discounts.forEach((discount, index) => {
          if (discount !== null)
            check(
              api.calcFlat({
                price: 30000001,
                dvou: 100000,
                pv: config.zorge.pv[index],
                term: Number(term),
                program,
                discount,
              }),
            );
        });
  for (const program of ["monthly", "quarterly", "p25"])
    for (const [term, corrections] of Object.entries(
      config.parking.table[program],
    ))
      corrections.forEach((corr, index) => {
        if (corr !== null)
          check(
            api.calcParking({
              price: 3500001,
              dvou: 50000,
              dop: 0,
              pv: config.parking.pv[index],
              term: Number(term),
              program,
              corr,
            }),
          );
      });
  check(
    api.calcParking({
      price: 3500001,
      dvou: 50000,
      dop: 0,
      pv: 1,
      term: 0,
      program: "monthly",
      corr: 0,
    }),
  );
  for (const [program, discount] of [
    ["promoEq", 0.13],
    ["promoFix", 0.05],
  ])
    check(
      api.calcFlat({
        price: 30000001,
        dvou: 100000,
        pv: 0.05,
        term: 12,
        program,
        discount,
      }),
    );
  const tiny = api.calcFlat({
    price: 1,
    dvou: 0,
    pv: 0.05,
    term: 12,
    program: "promoFix",
    discount: 0.05,
  });
  check(tiny);
  assert.ok(checked > 300, `Verified ${checked} available combinations`);
});

function hostedCalculator() {
  const nodes = new Map();
  function element(id) {
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        value: "",
        textContent: "",
        innerHTML: "",
        hidden: false,
        dataset: {},
        listeners: {},
        classList: { toggle() {} },
        content: {
          cloneNode() {
            return {};
          },
        },
        addEventListener(event, callback) {
          this.listeners[event] = callback;
        },
        setAttribute() {},
        querySelectorAll() {
          return [];
        },
        focus() {},
        remove() {},
        setSelectionRange() {},
        selectionStart: 0,
      });
    return nodes.get(id);
  }
  element("conditions").textContent = JSON.stringify(config);
  element("assets").textContent = script("assets");
  const document = {
    body: { prepend() {} },
    activeElement: null,
    getElementById: element,
    querySelector: (selector) =>
      element(selector.startsWith("#") ? selector.slice(1) : selector),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const context = {
    document,
    location: { hash: "" },
    window: { matchMedia: () => ({ matches: false }) },
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    requestAnimationFrame() {
      throw Error("Financial numbers must not animate from stale values");
    },
    module: { exports: {} },
  };
  vm.runInNewContext(script("engine"), context, { timeout: 1000 });
  vm.runInNewContext(script("app"), context, { timeout: 1000 });
  return {
    element,
    changeProject(value) {
      element("projects").listeners.change({ target: { value } });
    },
    change(name, value) {
      element("form").listeners.change({ target: { name, value } });
    },
    input(id, value) {
      const input = element(id);
      input.value = value;
      input.selectionStart = value.length;
      element("form").listeners.input({ target: input });
    },
    result: () => element("results").innerHTML,
  };
}

test("live promotion price input updates the headline and schedule before blur", () => {
  const page = hostedCalculator();
  page.changeProject("zorge");
  page.change("program", "promoEq");
  page.input("price", "10000000");
  assert.match(page.result(), /data-v="688000"[^>]*>688\s*000/);
  assert.ok(page.result().includes("1 290 000"));
  page.change("program", "promoFix");
  assert.match(page.result(), /data-v="150000"[^>]*>150\s*000/);
});

test("parking refuses a non-positive financed amount without rendering negative payments", () => {
  const page = hostedCalculator();
  page.changeProject("parking");
  page.input("price", "500000");
  page.input("dvou", "50000");
  page.input("dop", "95");
  assert.ok(
    page.result().includes("Цена после скидок и ДВОУ должна быть больше нуля"),
  );
  assert.ok(!page.result().includes("data-v="));
});

test("Silver Bor reservation amount follows a price change immediately", () => {
  const page = hostedCalculator();
  page.changeProject("serbor");
  page.input("price", "10000000");
  assert.equal(page.element("f-dvou .fixed").textContent, "100 000 ₽");
  page.change("dvou-pct", "0.02");
  assert.equal(page.element("f-dvou .fixed").textContent, "200 000 ₽");
});
