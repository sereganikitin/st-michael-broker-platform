#!/usr/bin/env node
/**
 * 2026-09-09: ретранслятор запросов к Telegram Bot API.
 *
 * Зачем: с сервера api.telegram.org доступен только по IPv6 (IPv4 — таймаут),
 * а контейнеры compose-сети без IPv6 — поэтому ops-inbox (приём ответов из
 * бота), ops-alert и уведомления из контейнера api падали с ETIMEDOUT.
 * Этот процесс запускается в контейнере с network_mode: host (видит IPv6
 * хоста), слушает ТОЛЬКО адрес шлюза compose-сети (RELAY_BIND, по умолчанию
 * 172.18.0.1) и пересылает запросы как есть на https://api.telegram.org.
 * Контейнер api ходит на http://RELAY_BIND:RELAY_PORT (TELEGRAM_API_BASE).
 *
 * Только Telegram, только пути /bot<token>/... и /file/bot<token>/...;
 * тело и заголовки content-type проксируются без изменений, токены не
 * логируются. Без зависимостей — чистый node:http/https.
 */
const http = require("node:http");
const https = require("node:https");

const BIND = process.env.RELAY_BIND || "172.18.0.1";
const PORT = Number(process.env.RELAY_PORT || 8081);
const UPSTREAM_HOST = "api.telegram.org";
const MAX_BODY = 25 * 1024 * 1024;

const agent = new https.Agent({ keepAlive: true, maxSockets: 16 });

function maskPath(path) {
  return String(path).replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot***");
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";
  if (url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (!/^\/(bot\d+:[A-Za-z0-9_-]+|file\/bot\d+:[A-Za-z0-9_-]+)\//.test(url)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not a telegram bot api path");
    return;
  }
  const headers = {
    host: UPSTREAM_HOST,
    accept: req.headers.accept || "*/*",
  };
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
  const started = Date.now();
  const upstream = https.request(
    {
      host: UPSTREAM_HOST,
      port: 443,
      method: req.method,
      path: url,
      headers,
      agent,
      // IPv6 первым (IPv4 до Telegram с этого хоста не ходит); при отсутствии
      // IPv6 node сам вернётся к IPv4 благодаря autoSelectFamily.
      autoSelectFamily: true,
      timeout: 30000,
    },
    (up) => {
      const passthrough = {};
      for (const key of ["content-type", "content-length", "content-disposition"]) {
        if (up.headers[key]) passthrough[key] = up.headers[key];
      }
      res.writeHead(up.statusCode || 502, passthrough);
      up.pipe(res);
      up.on("end", () => {
        console.log(`${req.method} ${maskPath(url).slice(0, 80)} -> ${up.statusCode} ${Date.now() - started} ms`);
      });
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (error) => {
    console.warn(`${req.method} ${maskPath(url).slice(0, 80)} -> ошибка: ${error.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, description: `relay: ${error.message}` }));
  });
  let received = 0;
  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_BODY) {
      upstream.destroy(new Error("body too large"));
      req.destroy();
    }
  });
  req.pipe(upstream);
});

server.listen(PORT, BIND, () => {
  console.log(`tg-relay слушает http://${BIND}:${PORT} -> https://${UPSTREAM_HOST}`);
});
server.on("error", (error) => {
  console.error(`tg-relay не запустился: ${error.message}`);
  process.exit(1);
});
