"use strict";
// Local UI smoke test only. Every API request is intercepted with synthetic
// data; no live API, credentials, Google, Mango or amoCRM are accessed.
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.AGENCY_UI_URL || "http://127.0.0.1:3127";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base))
  throw Error("LOCAL_URL_REQUIRED");
const operator = "11111111-1111-4111-8111-111111111111";
const agency = "22222222-2222-4222-8222-222222222222";
const now = new Date().toISOString();
const data = {
  role: "ADMIN",
  currentUserId: operator,
  permissions: [
    "READ_ALL",
    "CALL_EXECUTE",
    "CALL_ASSIGN",
    "ENTITY_EDIT",
    "EXPORT",
    "REFERENCE_MANAGE",
  ],
  source: {
    loadedAt: now,
    sourceHash: "a".repeat(64),
    stale: false,
    reviewCount: 2,
  },
  period: { from: "2026-01-01T00:00:00Z", to: "2027-01-01T00:00:00Z" },
  script: {
    version: 1,
    current: true,
    text: "Учебный скрипт: уточните удобное время для разговора.",
    owner: "Учебный руководитель",
    validUntil: "2027-01-01T00:00:00Z",
  },
  metrics: {
    assignedAgencies: 1,
    attemptedAgencies: 0,
    attempts: 0,
    conversationAgencies: 0,
    agreements: 0,
    tasksDue: 0,
    tasksOnTime: 0,
    overdue: 0,
  },
  cards: [
    {
      id: agency,
      name: "Учебное агентство",
      type: "АН",
      phone: null,
      email: null,
      updatedAt: now,
      doNotCall: false,
      callControlVersion: 1,
      callContactsVersion: 1,
      callContacts: [],
      assignments: [
        {
          id: "assignment",
          version: 1,
          status: "PENDING",
          assignedToId: operator,
          assignedAt: now,
          campaign: { id: "campaign", name: "Учебный пилот", status: "ACTIVE" },
          assignedTo: { id: operator, fullName: "Учебный оператор" },
        },
      ],
      attempts: [],
      tasks: [],
      periods: [
        {
          tab: "Активные",
          row: 6,
          baselineRub: "0.00",
          addedRub: "0.00",
          totalRub: "0.00",
          fields: [],
        },
        {
          tab: "Спящие",
          row: 7,
          baselineRub: "0.00",
          addedRub: "0.00",
          totalRub: "0.00",
          fields: [],
        },
      ],
    },
  ],
};

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1080 },
    });
    await context.addInitScript((id) => {
      localStorage.setItem("accessToken", "synthetic-local-token");
      localStorage.setItem("stm_onboarding_seen_" + id, "1");
    }, operator);
    const saves = [];
    let failFirst = true;
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== base) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      let body = {};
      if (url.pathname === "/api/auth/me")
        body = {
          id: operator,
          role: "ADMIN",
          fullName: "Учебный оператор",
          agencies: [],
          status: "ACTIVE",
        };
      if (url.pathname === "/api/loyalty-workflow/agencies-v1-2") body = data;
      if (url.pathname === "/api/loyalty-workflow/operators")
        body = [{ id: operator, fullName: "Учебный оператор", role: "ADMIN" }];
      if (/assignments\/assignment\/attempts$/.test(url.pathname)) {
        saves.push(route.request().postDataJSON());
        if (failFirst) {
          failFirst = false;
          return route.abort("failed");
        }
        const submitted = saves.at(-1);
        data.cards[0].assignments[0].status = "COMPLETED";
        data.cards[0].attempts = [
          {
            ...submitted,
            id: "event",
            occurredAt: now,
            operator: { fullName: "Учебный оператор" },
            correctsAttemptId: null,
          },
        ];
        body = { remaining: 0, campaignRemaining: 0 };
      }
      if (/assignments\/assignment\/claim$/.test(url.pathname)) {
        data.cards[0].assignments[0].version = 2;
        data.cards[0].assignments[0].claimed = true;
        data.cards[0].assignments[0].status = "IN_PROGRESS";
        body = { version: 2, claimed: true };
      }
      await route.fulfill({ json: body });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/admin/agencies-v1-2/workspace");
    await page
      .getByRole("heading", { name: "Учебное агентство", exact: true })
      .waitFor();
    assert.equal(
      await page.getByText("Исторические периоды Google (2)").count(),
      1,
    );
    assert.equal(
      await page.getByRole("link", { name: "Позвонить вручную" }).count(),
      0,
    );
    await page
      .getByRole("button", { name: "Взять в работу", exact: true })
      .click();
    await page
      .getByText("Карточка закреплена за текущим сеансом", { exact: true })
      .waitFor();
    const otherPage = await context.newPage();
    await otherPage.goto(base + "/admin/agencies-v1-2/workspace");
    await otherPage
      .getByRole("button", { name: "Взять в работу", exact: true })
      .click();
    await otherPage
      .getByText(/Карточка уже открыта в другой вкладке/)
      .waitFor();
    await otherPage.close();
    if (process.env.AGENCY_SCREENSHOT_DIR)
      await page.screenshot({
        path:
          process.env.AGENCY_SCREENSHOT_DIR + "/agency-workspace-desktop.png",
        fullPage: true,
      });
    await page.locator("fieldset select").selectOption("NO_ANSWER");
    await page.locator("fieldset textarea").fill("Учебная попытка без ответа");
    await page.getByRole("button", { name: "Сохранить и следующий" }).click();
    await page.locator('p[role="alert"]').waitFor();
    assert.equal(
      await page.locator("fieldset textarea").inputValue(),
      "Учебная попытка без ответа",
    );
    await page.getByRole("button", { name: "Сохранить и следующий" }).click();
    await page.getByRole("status").waitFor();
    assert.equal(saves.length, 2);
    assert.equal(saves[0].submissionId, saves[1].submissionId);
    await page
      .getByRole("button", { name: "Все доступные", exact: true })
      .click();
    await page.getByText("Журнал попыток (1) и задач").click();
    await page
      .getByText("Учебная попытка без ответа", { exact: true })
      .first()
      .waitFor();
    await page.reload();
    await page
      .getByRole("button", { name: "Все доступные", exact: true })
      .click();
    await page.getByText("Журнал попыток (1) и задач").waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(350); // existing sidebar transition after breakpoint change
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
      "mobile layout must not overflow horizontally",
    );
    if (process.env.AGENCY_SCREENSHOT_DIR)
      await page.screenshot({
        path:
          process.env.AGENCY_SCREENSHOT_DIR + "/agency-workspace-mobile.png",
        fullPage: true,
      });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: synthetic UI, cross-tab claim, retry idempotency, retained draft, history after reload, grouped periods, missing phone, mobile layout",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
