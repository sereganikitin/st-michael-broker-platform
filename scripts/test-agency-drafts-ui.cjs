"use strict";
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.AGENCY_UI_URL || "http://127.0.0.1:3137";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base))
  throw Error("LOCAL_ONLY");
const id = "11111111-1111-4111-8111-111111111111";
const attempt = {
  id: "attempt",
  assignmentId: "assignment",
  result: "INFORMED",
  comment: "Initial call",
  nextStep: "",
  nextActionAt: "",
  occurredAt: "2026-10-27T08:00:00Z",
  operator: { id, fullName: "Synthetic user" },
};
const card = (name, key) => ({
  id: key,
  name,
  type: "АН",
  assignments:
    key === id
      ? [
          {
            id: "assignment",
            claimed: true,
            version: 1,
            status: "IN_PROGRESS",
            assignedToId: id,
            assignedTo: { id, fullName: "Synthetic user" },
            campaign: {
              id: "campaign",
              name: "Synthetic campaign",
              status: "ACTIVE",
            },
          },
        ]
      : [],
  attempts: key === id ? [attempt] : [],
  tasks: [],
  periods: [],
  callContacts: [],
  callContactsVersion: 1,
});
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
    let writes = 0;
    await context.route("**/*", async (route) => {
      const u = new URL(route.request().url());
      if (u.origin !== base) return route.abort();
      if (!u.pathname.startsWith("/api/")) return route.continue();
      if (route.request().method() !== "GET" && !u.pathname.endsWith("/claim"))
        writes++;
      let body = {};
      if (u.pathname === "/api/auth/me")
        body = {
          id,
          role: "ADMIN",
          fullName: "Synthetic user",
          agencies: [],
          status: "ACTIVE",
        };
      if (u.pathname.endsWith("/operators")) body = [];
      if (u.pathname.endsWith("/reviews")) body = { reviews: [] };
      if (u.pathname.endsWith("/claim")) body = { version: 1 };
      if (u.pathname === "/api/loyalty-workflow/agencies-v1-2")
        body = {
          role: "ADMIN",
          currentUserId: id,
          permissions: [
            "READ_ALL",
            "CALL_EXECUTE",
            "CALL_REVIEW",
            "ENTITY_EDIT",
            "REFERENCE_MANAGE",
          ],
          cards: [
            card("Agency A", id),
            card("Agency B", "22222222-2222-4222-8222-222222222222"),
          ],
          script: {
            current: true,
            version: 1,
            text: "Synthetic script",
            owner: "Synthetic manager",
            validUntil: "2027-01-01T00:00:00Z",
          },
          metrics: {
            assignedAgencies: 1,
            attemptedAgencies: 1,
            attempts: 1,
            conversationAgencies: 1,
            agreements: 0,
            tasksDue: 0,
            tasksOnTime: 0,
            overdue: 0,
          },
          source: {
            loadedAt: new Date().toISOString(),
            stale: false,
            reviewCount: 0,
          },
          period: {},
        };
      await route.fulfill({ json: body });
    });
    const page = await context.newPage();
    const openDetails = async (text) => {
      const summary = page.getByText(text, { exact: true });
      if (!(await summary.evaluate((el) => el.parentElement.open)))
        await summary.click();
    };
    page.setDefaultTimeout(15000);
    await page.goto(base + "/admin/agencies-v1-2/workspace");
    await page
      .getByRole("button", { name: "Все доступные", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Взять в работу", exact: true })
      .click();
    await page
      .getByLabel("Комментарий / договорённость", { exact: true })
      .fill("Unsent call result");
    await page
      .getByText("Добавить проверенный контакт", { exact: true })
      .click();
    await page
      .getByLabel("Имя контакта", { exact: true })
      .fill("Unsent contact");
    await page
      .getByLabel("Основной телефон контакта", { exact: true })
      .fill("+70000000000");
    await openDetails("Журнал попыток (1) и задач");
    await openDetails("Ручная проверка качества");
    await page
      .getByLabel("Обоснование проверки", { exact: true })
      .fill("Unsent review");
    await openDetails("Исправить с сохранением истории");
    await page
      .getByLabel("Комментарий исправления", { exact: true })
      .fill("Unsent correction");
    await openDetails("Утвердить условия и скрипт");
    await page
      .getByLabel("Текст скрипта", { exact: true })
      .fill("Unsent script");
    await page
      .getByRole("textbox", { name: "Поиск агентства", exact: true })
      .fill("Agency B");
    await page
      .getByRole("heading", { name: "Agency B", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("Имя контакта", { exact: true }).inputValue(),
      "",
    );
    await page
      .getByRole("textbox", { name: "Поиск агентства", exact: true })
      .fill("Agency A");
    await page
      .getByRole("heading", { name: "Agency A", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("Имя контакта", { exact: true }).inputValue(),
      "Unsent contact",
    );
    assert.equal(
      await page
        .getByLabel("Комментарий / договорённость", { exact: true })
        .inputValue(),
      "Unsent call result",
    );
    await openDetails("Журнал попыток (1) и задач");
    await page.getByLabel("Обоснование проверки", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByLabel("Обоснование проверки", { exact: true })
        .inputValue(),
      "Unsent review",
    );
    assert.equal(
      await page
        .getByLabel("Комментарий исправления", { exact: true })
        .inputValue(),
      "Unsent correction",
    );
    let dialogs = 0;
    const dismiss = async (dialog) => {
      dialogs++;
      await dialog.dismiss();
    };
    page.on("dialog", dismiss);
    const sourceLink = page.locator('a[href="/admin/agencies-v1-2"]').first();
    await sourceLink.click();
    assert.equal(dialogs, 1);
    assert.ok(page.url().includes("/workspace"));
    assert.equal(await page.evaluate(() => !!window.navigation), true);
    await page.evaluate(() => history.pushState(null, "", "?draft-test=2"));
    const backDialog = page.waitForEvent("dialog");
    await page.evaluate(() => history.back());
    await backDialog;
    await page.waitForFunction(() => location.search === "?draft-test=2");
    assert.equal(dialogs, 2);
    page.off("dialog", dismiss);
    const accept = (dialog) => dialog.accept();
    page.on("dialog", accept);
    await page.reload();
    await page
      .getByRole("button", { name: "Все доступные", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Имя контакта", { exact: true }).inputValue(),
      "Unsent contact",
    );
    assert.equal(
      await page
        .getByLabel("Комментарий / договорённость", { exact: true })
        .inputValue(),
      "Unsent call result",
    );
    await openDetails("Утвердить условия и скрипт");
    assert.equal(
      await page.getByLabel("Текст скрипта", { exact: true }).inputValue(),
      "Unsent script",
    );
    await openDetails("Журнал попыток (1) и задач");
    await page.getByLabel("Обоснование проверки", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByLabel("Обоснование проверки", { exact: true })
        .inputValue(),
      "Unsent review",
    );
    assert.equal(
      await page
        .getByLabel("Комментарий исправления", { exact: true })
        .inputValue(),
      "Unsent correction",
    );
    assert.equal(writes, 0);
    let conflicts = 0;
    await context.route("**/contacts", async (route) => {
      conflicts++;
      assert.equal(route.request().postDataJSON().expectedVersion, 1);
      await route.fulfill({
        status: 409,
        json: { message: "Synthetic contact version conflict" },
      });
    });
    await page
      .getByLabel("Источник контакта", { exact: true })
      .fill("Synthetic source");
    await page
      .getByLabel("Дата проверки", { exact: true })
      .fill("2026-10-27T09:00");
    await page
      .getByRole("button", { name: "Сохранить контакт", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Synthetic contact version conflict" })
      .waitFor();
    assert.equal(
      await page.getByLabel("Имя контакта", { exact: true }).inputValue(),
      "Unsent contact",
    );
    assert.equal(conflicts, 1);
    await page.getByText("Поля очереди", { exact: true }).click();
    await page.getByLabel("Поле очереди: Приоритет", { exact: true }).uncheck();
    assert.equal(
      await page
        .getByRole("complementary")
        .getByText(/Приоритет источника/)
        .count(),
      0,
    );
    await page
      .getByRole("button", { name: "Сохранить мой фильтр", exact: true })
      .click();
    await page.getByRole("button", { name: "Все поля", exact: true }).click();
    assert.ok(
      await page
        .getByRole("complementary")
        .getByText(/Приоритет источника/)
        .count(),
    );
    await page
      .getByRole("button", { name: "Восстановить мой фильтр", exact: true })
      .click();
    assert.equal(
      await page
        .getByLabel("Поле очереди: Приоритет", { exact: true })
        .isChecked(),
      false,
    );
    assert.equal(
      await page
        .getByRole("complementary")
        .getByRole("heading")
        .evaluate((el) => getComputedStyle(el.parentElement).position),
      "sticky",
    );
    assert.equal(
      await page
        .getByRole("article")
        .getByRole("heading", { name: "Agency A", exact: true })
        .evaluate((el) => getComputedStyle(el).position),
      "sticky",
    );
    await page
      .getByRole("button", { name: "Отменить изменения контакта", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Имя контакта", { exact: true }).inputValue(),
      "",
    );
    assert.equal(writes, 0);
    await page
      .getByRole("button", {
        name: "Удалить все черновики вкладки",
        exact: true,
      })
      .click();
    assert.equal(
      await page.getByLabel("Текст скрипта", { exact: true }).inputValue(),
      "",
    );
    assert.equal(
      await page
        .getByLabel("Комментарий исправления", { exact: true })
        .inputValue(),
      "Initial call",
    );
    assert.equal(
      await page
        .getByRole("button", {
          name: "Удалить все черновики вкладки",
          exact: true,
        })
        .count(),
      0,
    );
    console.log(
      "PASS tab drafts: result/contact/QA/correction/script restore, card isolation, link/back cancellation, reload, conflict preservation and explicit discard; no real business writes",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
