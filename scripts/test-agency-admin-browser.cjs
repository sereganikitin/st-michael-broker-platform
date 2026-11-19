const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
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
const errors = [];
const blocked = [];

async function main() {
  const permissionPath = `/admin/brokers/${config.brokerId}/agencies/${config.agencyId}/admin`;
  const initialGrant = await fetch(config.origin + permissionPath, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${config.adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ isAgencyAdmin: true }),
  });
  assert.equal(initialGrant.status, 200);
  await esbuild.build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Clients from '@/app/(cabinet)/clients/page'; import AdminBroker from '@/app/(cabinet)/admin/brokers/[id]/page'; import {apiGet} from '@/lib/api'; apiGet('/auth/me').then(profile=>{window.__LOCAL_PROFILE=profile; createRoot(document.getElementById('root')).render(location.pathname.startsWith('/admin/')?<AdminBroker/>:<Clients/>);});`,
      loader: "tsx",
      resolveDir: process.cwd(),
    },
    bundle: true,
    jsx: "automatic",
    platform: "browser",
    outfile: "tmp/agency-admin/browser.js",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "isolated-next-shell",
        setup(build) {
          build.onResolve({ filter: /^next\/navigation$/ }, () => ({
            path: "navigation",
            namespace: "fixture",
          }));
          build.onResolve({ filter: /^@\/lib\/auth$/ }, () => ({
            path: "auth",
            namespace: "fixture",
          }));
          build.onResolve({ filter: /^next\/link$/ }, () => ({
            path: "link",
            namespace: "fixture",
          }));
          build.onResolve({ filter: /^@\// }, ({ path: name }) => ({
            path: [".tsx", ".ts"]
              .map((ext) => path.join(root, name.slice(2)) + ext)
              .find((file) => fs.existsSync(file)),
          }));
          build.onLoad(
            { filter: /.*/, namespace: "fixture" },
            ({ path: name }) => ({
              contents:
                name === "auth"
                  ? "export function useAuth(){return {broker:window.__LOCAL_PROFILE,loading:false};}"
                  : name === "link"
                    ? 'import React from "react"; export default function Link({children,...props}){return React.createElement("a",props,children);}'
                    : 'export function useRouter(){return {push:(url)=>location.assign(url)};} export function useParams(){return {id:location.pathname.split("/").pop()};}',
              loader: "js",
            }),
          );
        },
      },
    ],
  });
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/api/")) {
      let body = "";
      for await (const part of req) body += part;
      const response = await fetch(config.origin + req.url.slice(4), {
        method: req.method,
        headers: {
          "Content-Type": "application/json",
          ...(req.headers.authorization
            ? { Authorization: req.headers.authorization }
            : {}),
        },
        ...(body ? { body } : {}),
      });
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(await response.text());
      return;
    }
    if (req.url === "/browser.js" || req.url === "/style.css") {
      res.setHeader(
        "Content-Type",
        req.url.endsWith(".js") ? "application/javascript" : "text/css",
      );
      res.end(
        fs.readFileSync(
          req.url === "/browser.js"
            ? "tmp/agency-admin/browser.js"
            : "tmp/agency-admin/style.css",
        ),
      );
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
  const record = (name) => {
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  };
  const contextFor = async (token) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
    });
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).hostname !== "127.0.0.1") {
        blocked.push("external");
        return route.abort();
      }
      return route.continue();
    });
    await context.addInitScript(
      (value) => { if (location.hostname === "127.0.0.1") localStorage.setItem("accessToken", value); },
      token,
    );
    context.on("page", (page) =>
      page.on("pageerror", (error) => errors.push(error.message)),
    );
    return context;
  };
  try {
    const author = await contextFor(config.token),
      recipient = await contextFor(config.otherBrokerToken),
      admin = await contextFor(config.adminToken);
    const authorPage = await author.newPage(),
      recipientPage = await recipient.newPage(),
      adminPage = await admin.newPage();
    await authorPage.goto(origin + "/clients");
    await recipientPage.goto(origin + "/clients");
    await authorPage
      .getByRole("combobox", { name: "Кто подал заявку" })
      .waitFor();
    assert.equal(
      await recipientPage
        .getByRole("combobox", { name: "Кто подал заявку" })
        .count(),
      0,
    );
    record(
      "agency administrator receives the delegated filter while remaining a BROKER",
    );

    const data = {
      phone: "+7" + Date.now().toString().slice(-10),
      fullName: `Синтетический клиент ${Date.now()}`,
      project: "SILVER_BOR",
      agencyInn: "7700000000",
      responsibleBrokerId: config.otherBrokerId,
      idempotencyKey: randomUUID(),
    };
    const response = await author.request.post(origin + "/api/clients/fix", {
      headers: { Authorization: `Bearer ${config.token}` },
      data,
    });
    assert.equal(response.status(), 201);
    const accepted = await response.json();
    await Promise.all([
      authorPage
        .getByRole("region", { name: "Заявки на фиксацию" })
        .getByText(data.fullName, { exact: false })
        .waitFor(),
      recipientPage
        .getByRole("region", { name: "Заявки на фиксацию" })
        .getByText(data.fullName, { exact: false })
        .waitFor(),
    ]);
    await authorPage
      .getByRole("combobox", { name: "Кто подал заявку" })
      .selectOption("delegated");
    await authorPage.getByText(data.fullName, { exact: false }).waitFor();
    record("pending request is visible to both users before creating a Client");

    await fetch(config.origin + "/local-test/drain");
    const authorRow = authorPage
      .getByRole("row")
      .filter({ hasText: data.fullName });
    const recipientRow = recipientPage
      .getByRole("row")
      .filter({ hasText: data.fullName });
    await Promise.all([authorRow.waitFor(), recipientRow.waitFor()]);
    await fetch(
      config.origin +
        "/local-test/close-latest?phone=" +
        encodeURIComponent(data.phone),
    );
    await Promise.all([
      authorRow.getByText("Не уникален", { exact: false }).waitFor(),
      recipientRow.getByText("Не уникален", { exact: false }).waitFor(),
    ]);
    record(
      "client rows and status refresh for author and recipient without reloading",
    );
    await recipientPage.screenshot({
      path: "tmp/agency-admin/recipient-client.png",
      fullPage: true,
    });

    await adminPage.goto(origin + "/admin/brokers/" + config.brokerId);
    const permission = adminPage
      .getByRole("region", { name: "Администратор агентства" })
      .getByRole("checkbox");
    await permission.waitFor();
    assert.equal(await permission.isChecked(), true);
    await permission.click();
    await adminPage
      .getByText("Право администратора агентства снято", { exact: true })
      .waitFor();
    await authorPage.reload();
    await authorPage
      .getByRole("heading", { name: "Клиенты", exact: true })
      .waitFor();
    assert.equal(
      await authorPage
        .getByRole("combobox", { name: "Кто подал заявку" })
        .count(),
      0,
    );
    await permission.click();
    await adminPage
      .getByText("Администратор агентства назначен", { exact: true })
      .waitFor();
    record(
      "system administrator grants and revokes the agency permission through the real form",
    );
    await adminPage.screenshot({
      path: "tmp/agency-admin/permission-form.png",
      fullPage: true,
    });
    assert(accepted.requestId);
    assert.deepEqual(blocked, []);
    assert.deepEqual(errors, []);
  } finally {
    fs.writeFileSync(
      "tmp/agency-admin/browser-results.json",
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
