"use strict";
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.AGENCY_UI_URL || "http://127.0.0.1:3137";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base))
  throw Error("LOCAL_ONLY");
const id = "11111111-1111-4111-8111-111111111111";
const operator = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const evidence = [{ agencyId: id, eventId: id, kind: "AGENCY" }];
const report = {
  currentUserId: id,
  permissions: ["READ_ALL", "CALL_ASSIGN", "CALL_REVIEW", "EXPORT"],
  role: "ADMIN",
  generatedAt: "2026-10-27T12:00:00Z",
  source: {
    loadedAt: "2026-10-27T11:00:00Z",
    stale: false,
    pendingReviewCount: 1,
    newCount: 2,
    reviewCount: 3,
  },
  period: { from: "2026-10-26T21:00:00Z", to: "2026-10-27T21:00:00Z" },
  cards: [
    {
      id,
      name: "Synthetic agency",
      type: "АН",
      attempts: [],
      tasks: [
        {
          id: taskId,
          title: "Synthetic callback",
          dueAt: "2026-10-26T12:00:00Z",
          status: "OPEN",
        },
      ],
    },
  ],
  filterOptions: {
    agencies: [{ id, name: "Synthetic agency" }],
    campaigns: [{ id: operator, name: "Synthetic campaign" }],
  },
  operators: [{ id: operator, name: "Synthetic operator" }],
  metrics: { attempts: 1, overdue: 1 },
  evidence: {
    attemptedAgencies: evidence,
    assignedAgencies: evidence,
    noPhone: evidence,
    attempts: evidence,
  },
  rates: [
    {
      key: "coverage",
      title: "Охват агентств",
      numerator: 1,
      denominator: 1,
      ratio: 1,
      numeratorKey: "attemptedAgencies",
      denominatorKey: "assignedAgencies",
      explanation: "Synthetic numerator and denominator evidence",
    },
  ],
  quality: {
    noPhone: [id],
    noOwner: [],
    invalidPhone: [],
    missingNextAction: [],
    scriptNotCurrent: [],
  },
  workload: [
    {
      id: operator,
      name: "Synthetic operator",
      open: 1,
      overdue: 1,
      attempts: 1,
      types: { АН: 1 },
      withoutPhone: 1,
    },
  ],
  overdue: [
    {
      id: taskId,
      version: 1,
      agencyId: id,
      agencyName: "Synthetic agency",
      title: "Synthetic callback",
      kind: "CALL",
      dueAt: "2026-10-26T12:00:00Z",
      assignedTo: { id: operator, fullName: "Synthetic operator" },
      overdueMinutes: 1440,
      reasons: [],
    },
  ],
  exclusions: { tasksWithoutDueDate: 2, cancelledTasksInPeriod: 1 },
  qaSample: [
    {
      agencyId: id,
      agencyName: "Synthetic agency",
      attemptId: operator,
      result: "INFORMED",
      comment: "Synthetic conversation",
      occurredAt: "2026-10-27T10:00:00Z",
      operator: { id: operator, fullName: "Synthetic operator" },
      review: null,
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
    for (const allowed of [true, false]) {
      const context = await browser.newContext();
      await context.addInitScript((id) => {
        localStorage.setItem("accessToken", "synthetic");
        localStorage.setItem("stm_onboarding_seen_" + id, "1");
      }, id);
      const queries = [];
      let writes = 0;
      await context.route("**/*", async (route) => {
        const u = new URL(route.request().url());
        if (u.origin !== base) return route.abort();
        if (!u.pathname.startsWith("/api/")) return route.continue();
        let body = {};
        if (u.pathname === "/api/auth/me")
          body = {
            id,
            role: "ADMIN",
            fullName: "Synthetic admin",
            agencies: [],
            status: "ACTIVE",
          };
        if (u.pathname.endsWith("/views")) body = [];
        if (u.pathname.endsWith("/reviews")) body = { reviews: [] };
        if (u.pathname.endsWith("/export")) {
          assert.equal(route.request().method(), "POST");
          assert.equal(u.searchParams.get("assigneeId"), operator);
          assert.equal(u.searchParams.get("agencyType"), "АН");
          return route.fulfill({
            contentType: "text/csv",
            headers: {
              "Content-Disposition": 'attachment; filename="synthetic.csv"',
            },
            body: "id\nsynthetic\n",
          });
        }
        if (u.pathname.endsWith("/supervisor")) {
          if (!allowed)
            return route.fulfill({
              status: 403,
              json: { message: "Insufficient permissions" },
            });
          queries.push(Object.fromEntries(u.searchParams));
          body = report;
        }
        if (u.pathname.endsWith("/delay-reason")) {
          writes++;
          const p = route.request().postDataJSON();
          assert.equal(p.expectedVersion, 1);
          assert.ok(p.submissionId);
          report.overdue[0].version = 2;
          report.overdue[0].reasons = [
            {
              id: "audit",
              version: 2,
              reason: p.reason,
              actor: { id, fullName: "Synthetic admin" },
              createdAt: report.generatedAt,
            },
          ];
          body = { version: 2 };
        }
        await route.fulfill({ json: body });
      });
      const page = await context.newPage();
      await page.goto(base + "/admin/agencies-v1-2/supervisor");
      if (!allowed) {
        await page
          .getByRole("alert")
          .filter({ hasText: "Insufficient permissions" })
          .waitFor();
        assert.equal(
          await page.getByText("Synthetic callback", { exact: true }).count(),
          0,
        );
        await context.close();
        continue;
      }
      await page
        .getByRole("heading", {
          name: "Показатели и основания расчёта",
          exact: true,
        })
        .waitFor();
      if (process.env.AGENCY_SCREENSHOT)
        await page.screenshot({
          path: process.env.AGENCY_SCREENSHOT,
          fullPage: false,
        });
      await page
        .getByRole("button", { name: "Числитель (1)", exact: true })
        .click();
      await page
        .getByRole("region", { name: "Расшифровка показателя", exact: true })
        .getByRole("link", { name: "Synthetic agency", exact: true })
        .waitFor();
      assert.ok(
        (
          await page
            .getByRole("region", {
              name: "Расшифровка показателя",
              exact: true,
            })
            .getByRole("link")
            .getAttribute("href")
        ).includes(`agencyId=${id}`),
      );
      await page
        .getByLabel("Начало периода", { exact: true })
        .fill("2026-10-25");
      await page
        .getByLabel("Конец периода", { exact: true })
        .fill("2026-10-27");
      await page
        .getByLabel("Фильтр сотрудника", { exact: true })
        .selectOption(operator);
      await page
        .getByLabel("Фильтр типа агентства", { exact: true })
        .selectOption("АН");
      await page
        .getByRole("button", { name: "Применить фильтры", exact: true })
        .click();
      await page.getByText(/Применённый период: 2026-10-25/).waitFor();
      assert.equal(queries.at(-1).assigneeId, operator);
      assert.equal(queries.at(-1).agencyType, "АН");
      assert.equal(queries.at(-1).from, "2026-10-25T00:00:00+03:00");
      await page
        .getByLabel("Фильтр типа агентства", { exact: true })
        .selectOption("Ключевой");
      await page.getByText(/Параметры изменены, но ещё не применены/).waitFor();
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", {
          name: "CSV событий применённой выборки",
          exact: true,
        })
        .click();
      assert.equal((await download).suggestedFilename(), "synthetic.csv");
      await page
        .getByText("Причина задержки и история", { exact: true })
        .click();
      await page
        .getByLabel("Причина задержки: Synthetic callback", { exact: true })
        .fill("Synthetic reason");
      await page
        .getByRole("button", { name: "Зафиксировать причину", exact: true })
        .click();
      await page.getByText(/Synthetic reason · Synthetic admin/).waitFor();
      assert.equal(writes, 1);
      assert.equal(
        await page
          .getByRole("link", {
            name: "Рабочее место и назначения",
            exact: true,
          })
          .getAttribute("href"),
        "/admin/agencies-v1-2/workspace",
      );
      await page
        .getByRole("button", { name: "Без телефона: 1", exact: true })
        .click();
      await page
        .getByRole("region", { name: "Расшифровка показателя", exact: true })
        .waitFor();
      await context.close();
    }
    console.log(
      "PASS supervisor UI: distinct screen, metric evidence links, applied filters, audited delay reason, quality drilldown and denied access",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
