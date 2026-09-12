#!/usr/bin/env node
/**
 * 2026-09-12: планировщик каждый день в 08:00 падает на синке новостей —
 * `[stm-news] failed: certificate has expired`, при этом снаружи сертификат
 * stmichael.ru валиден (Let's Encrypt, до 15.11.2026). Смотрим, что видит
 * контейнер api: своё время, версию node, цепочку сертификатов и результат
 * запроса. Только чтение, никаких изменений.
 */
const https = require("https");
const tls = require("tls");
const dns = require("dns");

const HOST = "stmichael.ru";

function chain() {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: HOST, port: 443, servername: HOST, rejectUnauthorized: false, timeout: 15000 },
      () => {
        const out = [{ note: `подключились к ${socket.remoteAddress}` }];
        let cert = socket.getPeerCertificate(true);
        const seen = new Set();
        while (cert && cert.subject && !seen.has(cert.fingerprint)) {
          seen.add(cert.fingerprint);
          out.push({
            subject: cert.subject?.CN || JSON.stringify(cert.subject),
            issuer: cert.issuer?.CN || JSON.stringify(cert.issuer),
            valid_from: cert.valid_from,
            valid_to: cert.valid_to,
          });
          cert = cert.issuerCertificate && cert.issuerCertificate !== cert ? cert.issuerCertificate : null;
        }
        socket.end();
        resolve(out);
      },
    );
    socket.on("timeout", () => { socket.destroy(); resolve([{ error: "timeout" }]); });
    socket.on("error", (e) => resolve([{ error: e.message }]));
  });
}

function request(rejectUnauthorized) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://${HOST}/news`,
      { rejectUnauthorized, timeout: 15000, headers: { "User-Agent": "STMBrokerBot/1.0" } },
      (res) => {
        let size = 0;
        res.on("data", (c) => { size += c.length; });
        res.on("end", () => resolve({ ok: true, status: res.statusCode, bytes: size }));
      },
    );
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, error: e.message, code: e.code }));
  });
}

async function main() {
  console.log("=== окружение контейнера ===");
  console.log("время контейнера:", new Date().toISOString());
  console.log("node:", process.version);
  console.log("NODE_EXTRA_CA_CERTS:", process.env.NODE_EXTRA_CA_CERTS || "— не задан");
  console.log("NODE_TLS_REJECT_UNAUTHORIZED:", process.env.NODE_TLS_REJECT_UNAUTHORIZED || "— не задан");
  console.log("встроенных корневых сертификатов:", (tls.rootCertificates || []).length);
  const isrg = (tls.rootCertificates || []).filter((c) => c.includes("MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAw")).length;
  console.log("ISRG Root X1 во встроенном наборе:", isrg ? "есть" : "НЕТ");

  console.log("\n=== цепочка сертификатов, как её видит контейнер ===");
  for (const c of await chain()) {
    if (c.note) console.log(" ", c.note);
    else if (c.error) console.log("  ошибка:", c.error);
    else console.log(`  ${c.subject} ← ${c.issuer} | с ${c.valid_from} по ${c.valid_to}`);
  }

  console.log("\n=== запрос новостей ===");
  console.log("  с проверкой сертификата:", JSON.stringify(await request(true)));
  console.log("  без проверки (для сравнения):", JSON.stringify(await request(false)));
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
