// Actual fixation React components + real local HTTP/DB/Redis harness.
// Navigation and the auth context wrapper are isolated from the rest of Next.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const esbuild = require("esbuild");
const { chromium } = require(
  process.env.LOCAL_PLAYWRIGHT_MODULE || "playwright",
);
const config = JSON.parse(
  fs.readFileSync("tmp/fixation-local/browser-context.json", "utf8"),
);
assert.equal(new URL(config.origin).hostname, "127.0.0.1");
const root = path.resolve("apps/web/src");
const results = [];
async function main() {
  await esbuild.build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import FixationPage from '@/app/(cabinet)/fixation/page'; import {FixationRequests} from '@/components/FixationRequests'; import {apiGet} from '@/lib/api'; apiGet('/auth/me').then(profile=>{window.__LOCAL_PROFILE=profile; createRoot(document.getElementById('root')).render(location.pathname==='/fixation'?<FixationPage/>:<FixationRequests actorId={profile.id} asStaff={profile.role!=='BROKER'}/>);});`,
      loader: "tsx",
      resolveDir: process.cwd(),
    },
    bundle: true,
    jsx: "automatic",
    platform: "browser",
    outfile: "tmp/fixation-local/browser.js",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "local-shell",
        setup(build) {
          build.onResolve({ filter: /^next\/navigation$/ }, () => ({
            path: "navigation",
            namespace: "fixture",
          }));
          build.onResolve({ filter: /^@\/lib\/auth$/ }, () => ({
            path: "auth",
            namespace: "fixture",
          }));
          build.onResolve({ filter: /^@\// }, ({ path: name }) => ({
            path: [
              path.join(root, name.slice(2)) + ".tsx",
              path.join(root, name.slice(2)) + ".ts",
            ].find((p) => fs.existsSync(p)),
          }));
          build.onLoad(
            { filter: /.*/, namespace: "fixture" },
            ({ path: name }) => ({
              contents:
                name === "auth"
                  ? "export function useAuth(){return {broker:window.__LOCAL_PROFILE,loading:false};}"
                  : "export function useRouter(){return {push:(url)=>location.assign(url)};}",
              loader: "js",
            }),
          );
        },
      },
    ],
  });
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (pathname.startsWith("/api/")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const upstream = await fetch(`${config.origin}${req.url.slice(4)}`, {
        method: req.method,
        headers: {
          "Content-Type": "application/json",
          ...(req.headers.authorization
            ? { Authorization: req.headers.authorization }
            : {}),
        },
        ...(body ? { body } : {}),
      });
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(await upstream.text());
      return;
    }
    if (pathname === "/browser.js" || pathname === "/style.css") {
      res.setHeader(
        "Content-Type",
        pathname.endsWith(".js") ? "application/javascript" : "text/css",
      );
      res.end(fs.readFileSync(`tmp/fixation-local${pathname}`));
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      '<!doctype html><html lang="ru"><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body style="padding:24px"><div id="root"></div><script src="/browser.js"></script></body></html>',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  const blocked = [],
    errors = [];
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== "127.0.0.1") {
      blocked.push(u.hostname);
      return route.abort();
    }
    return route.continue();
  });
  await context.addInitScript((token) => {
    if (!localStorage.getItem("accessToken"))
      localStorage.setItem("accessToken", token);
  }, config.token);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const requests = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/api/clients/fix") && req.method() === "POST")
      requests.push(req.postDataJSON());
  });
  const counts = async () =>
    (await fetch(`${config.origin}/local-test/count`)).json();
  const fill = async (phone = "0000009091", name = "Local Browser") => {
    await page.getByPlaceholder("(999) 123-45-67").fill(phone);
    await page.locator('form input[type="text"]').nth(0).fill(name);
    await page.getByPlaceholder("45.5").fill("45");
    await page.getByPlaceholder("25 000 000").fill("25000000");
  };
  const submit = () => page.locator('form button[type="submit"]').click();
  const record = (name) => {
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  };
  try {
    await page.goto(`${origin}/fixation`);
    await fill();
    // Deliver the POST to the real API, then drop only the response to the browser.
    await page.route(
      "**/api/clients/fix",
      async (route) => {
        await route.fetch();
        await route.abort("failed");
      },
      { times: 1 },
    );
    await submit();
    await page.getByText("Failed to fetch", { exact: true }).waitFor();
    assert.equal((await counts()).requests, 1);
    const firstKey = requests[0].idempotencyKey;
    await page.reload();
    await fill();
    await submit();
    await page.getByRole("heading", { name: "Запрос отправлен" }).waitFor();
    assert.equal(requests.at(-1).idempotencyKey, firstKey);
    assert.equal((await counts()).requests, 1);
    assert(
      await page
        .getByText("Заявка принята. Проверка начнётся автоматически.", {
          exact: true,
        })
        .count(),
    );
    record("lost HTTP response + reload reuses the same request identity");

    await fetch(`${config.origin}/local-test/drain`);
    await page.goto(`${origin}/clients`);
    await page
      .getByText("Заявка обработана. Результат проверки: «Уникален».", {
        exact: true,
      })
      .waitFor();
    assert.equal((await counts()).leadPosts, 1);
    record("accepted request updates to confirmed result after processing");
    await fetch(
      `${config.origin}/local-test/close-latest?phone=${encodeURIComponent("+70000009091")}`,
    );
    await page
      .getByText("Заявка обработана. Результат проверки: «Не уникален».", {
        exact: true,
      })
      .waitFor({ timeout: 20_000 });
    await page.screenshot({
      path: "tmp/fixation-local/browser-current-status.png",
      fullPage: true,
    });
    record("polling replaces a previous result after a CRM status change");

    await page.goto(`${origin}/fixation`);
    await fill("0000009092", "Double click");
    const before = requests.length;
    await page.locator('form button[type="submit"]').dblclick();
    await page.getByRole("heading", { name: "Запрос отправлен" }).waitFor();
    assert.equal(requests.length - before, 1);
    assert.equal((await counts()).requests, 2);
    record("rapid double click produces one POST");

    await page.goto(`${origin}/fixation`);
    await fill("0000009093", "Storage blocked");
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("fixation-request:"))
          throw Error("local storage failure");
        return original.call(this, key, value);
      };
    });
    const beforeFailure = requests.length;
    await submit();
    await page
      .getByText(
        "Не удалось сохранить номер отправки. Проверьте доступность хранилища браузера.",
        { exact: true },
      )
      .waitFor();
    assert.equal(requests.length, beforeFailure);
    assert.equal((await counts()).requests, 2);
    record("unavailable browser storage stops submission before POST");
    assert.deepEqual(blocked, []);
    assert.deepEqual(errors, []);
  } finally {
    fs.writeFileSync(
      "tmp/fixation-local/browser-results.json",
      JSON.stringify(
        { results, blockedExternal: blocked, pageErrors: errors },
        null,
        2,
      ),
    );
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
