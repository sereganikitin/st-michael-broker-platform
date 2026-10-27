"use strict";
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.AGENCY_UI_URL || "http://127.0.0.1:3137";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base))
  throw Error("LOCAL_ONLY");
const id = "11111111-1111-4111-8111-111111111111";
const assignmentId = "22222222-2222-4222-8222-222222222222";
const report = {
  role: "ADMIN",
  currentUserId: id,
  permissions: ["READ_ALL", "CALL_EXECUTE", "CALL_ASSIGN"],
  cards: [
    {
      id,
      name: "Synthetic agency",
      type: "АН",
      phone: null,
      callContacts: [],
      callContactsVersion: 1,
      periods: [],
      attempts: [],
      tasks: [],
      assignments: [
        {
          id: assignmentId,
          version: 1,
          status: "COMPLETED",
          assignedToId: id,
          assignedTo: { id, fullName: "Synthetic operator" },
          campaign: { id, name: "Synthetic campaign", status: "ACTIVE" },
        },
      ],
    },
  ],
  script: { current: false },
  source: { loadedAt: new Date().toISOString(), reviewCount: 0 },
  period: {},
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
};
(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  });
  try {
    const context = await browser.newContext();
    await context.addInitScript((id) => {
      localStorage.setItem("accessToken", "synthetic");
      localStorage.setItem("stm_onboarding_seen_" + id, "1");
    }, id);
    const history = [];
    let writes = 0;
    let conflict = false;
    await context.route("**/*", async (route) => {
      const u = new URL(route.request().url());
      if (u.origin !== base) return route.abort();
      if (!u.pathname.startsWith("/api/")) return route.continue();
      let data = {};
      if (u.pathname === "/api/auth/me")
        data = {
          id,
          role: "ADMIN",
          fullName: "Synthetic operator",
          agencies: [],
          status: "ACTIVE",
        };
      if (u.pathname === "/api/loyalty-workflow/agencies-v1-2") data = report;
      if (u.pathname.endsWith("/operators") || u.pathname.endsWith("/views"))
        data = [];
      if (u.pathname.endsWith("/outcomes")) {
        assert.ok(u.pathname.includes(assignmentId));
        if (route.request().method() === "POST") {
          writes++;
          const body = route.request().postDataJSON();
          assert.ok(body.submissionId && body.eventId);
          if (conflict)
            return route.fulfill({
              status: 409,
              json: { message: "Synthetic concurrent change" },
            });
          assert.ok(body.occurredAt.endsWith("+03:00"));
          data = {
            ...body,
            id: "revision-" + writes,
            version: body.expectedVersion + 1,
            actor: { id, fullName: "Synthetic operator" },
            createdAt: new Date().toISOString(),
          };
          history.unshift(data);
        } else data = { history };
      } else if (route.request().method() !== "GET")
        throw Error("UNEXPECTED_WRITE " + u.pathname);
      return route.fulfill({ json: data });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(base + "/admin/agencies-v1-2/workspace");
    await page
      .getByRole("button", { name: "Все доступные", exact: true })
      .click();
    await page
      .getByLabel("Основание результата кампании")
      .fill("Synthetic agreed meeting");
    await page.getByLabel("Дата результата кампании").fill("2026-10-27T12:00");
    page.once("dialog", (d) => d.accept());
    await page.reload();
    await page
      .getByRole("button", { name: "Все доступные", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Основание результата кампании").inputValue(),
      "Synthetic agreed meeting",
    );
    await page
      .getByRole("button", {
        name: "Сохранить результат кампании",
        exact: true,
      })
      .click();
    await page
      .getByText("Результат сохранён и проверен. Задачи не изменены.", {
        exact: true,
      })
      .waitFor();
    assert.equal(writes, 1);
    assert.equal(history[0].status, "PLANNED");
    await page
      .getByRole("button", { name: "Изменить статус / исправить", exact: true })
      .click();
    await page.getByLabel("Статус результата кампании").selectOption("HELD");
    await page
      .getByLabel("Причина изменения результата")
      .fill("Synthetic completed meeting");
    await page
      .getByRole("button", {
        name: "Сохранить результат кампании",
        exact: true,
      })
      .click();
    await page.getByText("версия 2", { exact: false }).first().waitFor();
    assert.equal(history.length, 2);
    assert.equal(history[0].eventId, history[1].eventId);
    await page
      .getByRole("button", { name: "Изменить статус / исправить", exact: true })
      .click();
    await page
      .getByLabel("Причина изменения результата")
      .fill("Preserve on conflict");
    conflict = true;
    await page
      .getByRole("button", {
        name: "Сохранить результат кампании",
        exact: true,
      })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Synthetic concurrent change" })
      .waitFor();
    assert.equal(
      await page.getByLabel("Причина изменения результата").inputValue(),
      "Preserve on conflict",
    );
    await page.screenshot({
      path: "work/agency-outcomes-ui.png",
      fullPage: true,
    });
    console.log(
      "PASS campaign result UI: tab draft, save+readback, plan→fact revision, Moscow datetime, conflict preserves draft; localhost only",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
