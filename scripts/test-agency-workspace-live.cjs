/* Local browser -> real HTTP/JWT controllers -> disposable PostgreSQL. No API mocks. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(
  fs.readFileSync(path.resolve("work/api-fixture.json"), "utf8"),
);
const attemptComment = "UI actual PostgreSQL attempt " + Date.now();
const correctionComment = "UI corrected result " + Date.now();
const base = process.env.AGENCY_UI_URL || "http://127.0.0.1:3140";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base))
  throw Error("LOCAL_ONLY");
const api = async (actor, p, method = "GET", body) => {
  const r = await fetch("http://127.0.0.1:55440/api/loyalty-workflow/" + p, {
    method,
    headers: {
      Authorization: "Bearer " + fixture.users[actor].token,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  assert.ok(r.ok, `HTTP ${r.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH,
  });
  let checks = 0;
  const open = async (actor) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
    });
    await context.addInitScript((user) => {
      localStorage.setItem("accessToken", user.token);
      localStorage.setItem("stm_onboarding_seen_" + user.id, "1");
    }, fixture.users[actor]);
    await context.route("**/*", (r) =>
      new URL(r.request().url()).origin === base ? r.continue() : r.abort(),
    );
    const page = await context.newPage();
    page.on("response", async (response) => {
      if (
        response.status() >= 400 &&
        new URL(response.url()).pathname.startsWith("/api/loyalty-workflow/")
      ) {
        console.log(
          "LOCAL_API_ERROR",
          response.status(),
          new URL(response.url()).pathname,
          (await response.text()).slice(0, 300),
        );
      }
    });
    page.setDefaultTimeout(30000);
    await page.goto(base + "/admin/agencies-v1-2/workspace", {
      waitUntil: "domcontentloaded",
    });
    console.log("OPEN", actor);
    await page
      .getByRole("heading", { name: "Агентства v1/2 · Мой обзвон" })
      .waitFor();
    console.log("READY", actor);
    return { page, context };
  };
  try {
    const setup = await api("admin", "agencies-v1-2");
    for (const task of setup.cards.find((c) => c.id === fixture.agencies[0].id)
      .tasks)
      if (task.title === "Send materials" && task.status !== "OPEN")
        await api("a", `tasks/${task.id}`, "PATCH", {
          expectedVersion: task.version,
          status: "OPEN",
        });
    const seedCard = setup.cards.find((c) => c.id === fixture.agencies[2].id);
    const openAssignment = seedCard.assignments.find((a) =>
      ["PENDING", "IN_PROGRESS"].includes(a.status),
    );
    if (openAssignment)
      await api(
        "admin",
        `agencies-v1-2/assignments/${openAssignment.id}/reassign`,
        "PATCH",
        {
          expectedVersion: openAssignment.version,
          assigneeId: fixture.users.a.id,
        },
      );
    else {
      const draft = await api("admin", "agencies-v1-2/pilot", "POST", {
        submissionId: require("node:crypto").randomUUID(),
        name: "Repeatable live test",
        agencyIds: [seedCard.id],
        assigneeId: fixture.users.a.id,
        sourceHash: setup.source.sourceHash,
      });
      await api("admin", `campaigns/${draft.id}/activate`, "POST", {
        expectedVersion: draft.version,
      });
    }
    await api("admin", `agencies-v1-2/${seedCard.id}/contacts`, "PATCH", {
      expectedVersion: seedCard.callContactsVersion,
      contacts: seedCard.callContacts.filter((c) => c.name !== "UI contact"),
    });
    const { page: admin } = await open("admin");
    await admin
      .getByRole("button", { name: "Все доступные", exact: true })
      .click();
    await admin.getByLabel("Фильтр типа агентства").selectOption("Ключевой");
    await admin
      .getByRole("heading", { name: "Synthetic agency 2", exact: true })
      .waitFor();
    checks++;
    await admin.getByLabel("Фильтр типа агентства").selectOption("");
    await admin
      .getByLabel("Фильтр агентства", { exact: true })
      .selectOption(fixture.agencies[0].id);
    await admin
      .getByRole("heading", { name: "Synthetic agency 0", exact: true })
      .waitFor();
    checks++;
    await admin
      .getByLabel("Фильтр агентства", { exact: true })
      .selectOption("");
    await admin
      .getByLabel("Фильтр сотрудника")
      .selectOption(fixture.users.b.id);
    await admin.waitForTimeout(150);
    await admin.getByLabel("Фильтр сотрудника").selectOption("");
    checks++;
    await admin.getByLabel("Начало периода").fill("2026-01-01");
    await admin.getByLabel("Конец периода").fill("2027-12-31");
    await admin
      .getByLabel("Поиск агентства", { exact: true })
      .fill("Synthetic agency 0");
    await admin
      .getByRole("heading", { name: "Synthetic agency 0", exact: true })
      .waitFor();
    await admin.getByLabel("Поиск агентства", { exact: true }).fill("");
    const campaignOption = await admin
      .getByLabel("Фильтр кампании")
      .locator("option")
      .nth(1)
      .getAttribute("value");
    await admin.getByLabel("Фильтр кампании").selectOption(campaignOption);
    await admin.getByLabel("Фильтр кампании").selectOption("");
    checks += 3;
    console.log("FILTERS_DONE");
    const download = admin.waitForEvent("download", { timeout: 10000 });
    await admin.getByRole("button", { name: "CSV событий периода" }).click();
    const csv = await download;
    assert.match(csv.suggestedFilename(), /\.csv$/);
    checks++;
    await admin
      .getByRole("button", { name: "Сохранить мой фильтр", exact: true })
      .click();
    await admin.getByRole("button", { name: "Сегодня", exact: true }).click();
    await admin
      .getByRole("button", { name: "Восстановить мой фильтр" })
      .click();
    checks++;
    console.log("EXPORT_DONE");
    const { page: a, context } = await open("a");
    assert.equal(
      await a
        .getByRole("link", { name: "Исходная таблица", exact: true })
        .count(),
      0,
    );
    await a.getByLabel("Поиск агентства", { exact: true }).fill(seedCard.name);
    await a
      .getByRole("heading", { name: seedCard.name, exact: true })
      .waitFor();
    await a.getByRole("button", { name: "Взять в работу" }).click();
    await a
      .getByText("Карточка закреплена за текущим сеансом", { exact: true })
      .waitFor();
    checks++;
    console.log("CLAIMED");
    const other = await context.newPage();
    await other.goto(base + "/admin/agencies-v1-2/workspace", {
      waitUntil: "domcontentloaded",
    });
    await other.getByRole("button", { name: "Взять в работу" }).click();
    await other.getByText(/Карточка уже открыта в другой вкладке/).waitFor();
    await other.close();
    checks++;
    console.log("TWO_TABS");
    await a.getByText("Добавить проверенный контакт", { exact: true }).click();
    await a.getByLabel("Имя контакта", { exact: true }).fill("UI contact");
    await a
      .getByLabel("Источник контакта", { exact: true })
      .fill("Local UI integration");
    await a
      .getByLabel("Дата проверки", { exact: true })
      .fill("2026-10-26T10:00");
    await a
      .getByRole("button", { name: "Сохранить контакт", exact: true })
      .click();
    await a.getByText("UI contact", { exact: true }).waitFor();
    checks++;
    console.log("CONTACT");
    await a
      .getByLabel("Результат звонка", { exact: true })
      .selectOption("NO_ANSWER");
    await a
      .getByLabel("Комментарий / договорённость", { exact: true })
      .fill(attemptComment);
    await a.getByRole("button", { name: "Сохранить и следующий" }).click();
    await a
      .getByText(
        "Результат сохранён. Выполнение обещанных задач отмечается отдельно.",
        { exact: true },
      )
      .waitFor();
    checks++;
    console.log("SAVED");
    const data = await api("a", "agencies-v1-2");
    const card = data.cards.find((c) => c.id === fixture.agencies[2].id);
    assert.ok(card.attempts.some((t) => t.comment === attemptComment));
    assert.equal(card.callContacts.length, 2);
    checks++;
    await a.getByRole("button", { name: "Все доступные", exact: true }).click();
    await a
      .getByLabel("Поиск агентства", { exact: true })
      .fill("Synthetic agency 2");
    await a.getByText(/Журнал попыток/).click();
    console.log("HISTORY");
    const event = a
      .getByText(attemptComment, { exact: true })
      .first()
      .locator("..");
    await event
      .getByText("Исправить с сохранением истории", { exact: true })
      .click();
    await event
      .getByLabel("Комментарий исправления", { exact: true })
      .fill(correctionComment);
    await event
      .getByLabel("Причина исправления", { exact: true })
      .fill("Local audit correction");
    await event
      .getByRole("button", { name: "Сохранить исправление", exact: true })
      .click();
    console.log("CORRECTED_CLICK");
    for (let i = 0; i < 40; i++) {
      const state = await api("a", "agencies-v1-2");
      if (
        state.cards
          .find((c) => c.id === card.id)
          .attempts.some((t) => t.comment === correctionComment)
      ) {
        checks++;
        break;
      }
      await a.waitForTimeout(50);
      if (i === 39) throw Error("Correction not persisted");
    }
    await a
      .getByLabel("Поиск агентства", { exact: true })
      .fill("Synthetic agency 0");
    await a
      .getByRole("button", { name: "Отметить выполненной", exact: true })
      .click();
    await a.getByText("Задача выполнена", { exact: true }).waitFor();
    const completedState = await api("a", "agencies-v1-2");
    assert.equal(
      completedState.cards
        .find((c) => c.id === fixture.agencies[0].id)
        .tasks.some(
          (t) => t.title === "Send materials" && t.status === "COMPLETED",
        ),
      true,
    );
    checks++;
    // Exercise the real saved-view, script and campaign controls as a manager.
    await admin.getByRole("button", { name: "Обновить", exact: true }).click();
    const viewName = "Local view " + Date.now();
    admin.once("dialog", (d) => d.accept(viewName));
    await admin.getByRole("button", { name: "Сохранить", exact: true }).click();
    await admin
      .getByLabel("Сохранённое представление")
      .selectOption({ label: "Моё · " + viewName });
    await admin.getByRole("button", { name: "Применить", exact: true }).click();
    checks++;
    admin.once("dialog", (d) => d.accept());
    await admin.getByRole("button", { name: "Удалить", exact: true }).click();
    checks++;
    await admin
      .getByText("Утвердить условия и скрипт", { exact: true })
      .click();
    await admin.getByLabel("Текст скрипта").fill("Reviewed synthetic script");
    await admin.getByLabel("Владелец скрипта").fill("Local reviewer");
    await admin.getByLabel("Действует до, МСК").fill("2030-01-01T10:00");
    await admin.getByRole("button", { name: "Утвердить", exact: true }).click();
    await admin
      .getByText("Скрипт утверждён; предыдущая версия сохранена в аудите", {
        exact: true,
      })
      .waitFor();
    checks++;
    await admin
      .getByRole("button", { name: "Все доступные", exact: true })
      .click();
    await admin
      .getByLabel("Выбрать Synthetic agency 1", { exact: true })
      .check();
    const pilotName = "Local UI pilot " + Date.now();
    await admin.getByLabel("Название пилота").fill(pilotName);
    await admin.getByLabel("Оператор пилота").selectOption(fixture.users.a.id);
    await admin
      .getByRole("button", { name: "Подготовить черновик", exact: true })
      .click();
    await admin
      .getByText(
        "Черновик пилота подготовлен. Проверьте его в разделе кампаний",
        { exact: true },
      )
      .waitFor();
    checks++;
    await admin
      .getByRole("button", { name: "Кампании и назначения", exact: true })
      .click();
    await admin.getByRole("button", { name: new RegExp(pilotName) }).click();
    assert.equal(
      await admin
        .getByRole("button", {
          name: "Назначить недостающее и активировать",
          exact: true,
        })
        .isEnabled(),
      false,
    );
    await admin
      .getByLabel("Сотрудник для назначений кампании", { exact: true })
      .selectOption(fixture.users.a.id);
    await admin
      .getByRole("button", {
        name: "Назначить недостающее и активировать",
        exact: true,
      })
      .click();
    for (let i = 0; i < 40; i++) {
      const campaigns = await api(
        "admin",
        "campaigns?base=ours&entityType=agencies",
      );
      const rows = Array.isArray(campaigns) ? campaigns : campaigns.items;
      if (rows.some((c) => c.name === pilotName && c.status === "ACTIVE")) {
        checks++;
        break;
      }
      await admin.waitForTimeout(100);
      if (i === 39) throw Error("UI campaign activation failed");
    }
    admin.once("dialog", (d) => d.accept());
    await admin
      .getByRole("button", { name: "Архивировать", exact: true })
      .click();
    checks++;
    await admin.getByRole("button", { name: "Закрыть", exact: true }).click();
    await admin
      .getByRole("link", { name: "Исходная таблица", exact: true })
      .click();
    await admin
      .getByRole("heading", { name: "Агентства v1/2", exact: true })
      .waitFor();
    const sourceDownload = admin.waitForEvent("download", { timeout: 10000 });
    await admin
      .getByRole("button", { name: "Выгрузить всё CSV", exact: true })
      .click();
    await sourceDownload;
    checks++;
    await admin.getByRole("link", { name: "Мой обзвон", exact: true }).click();
    await admin
      .getByRole("heading", { name: "Контроль команды", exact: true })
      .waitFor();
    await admin
      .getByRole("button", { name: "Все доступные", exact: true })
      .click();
    await admin
      .getByLabel("Поиск агентства", { exact: true })
      .fill("Synthetic agency 0");
    await admin
      .getByRole("heading", { name: "Synthetic agency 0", exact: true })
      .waitFor();
    if (process.env.AGENCY_SCREENSHOT_DIR) {
      await admin.screenshot({
        path: path.join(
          process.env.AGENCY_SCREENSHOT_DIR,
          "agency-real-api-desktop.png",
        ),
        fullPage: true,
      });
      await admin.setViewportSize({ width: 390, height: 844 });
      await admin.waitForTimeout(350);
      await admin.screenshot({
        path: path.join(
          process.env.AGENCY_SCREENSHOT_DIR,
          "agency-real-api-mobile.png",
        ),
        fullPage: true,
      });
    }
    console.log(`PASS live browser + HTTP/JWT + PostgreSQL: ${checks} checks`);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
