#!/usr/bin/env node
"use strict";

// Synthetic TEST only, never a valid recovery/login OTP. Reserve a run-bound
// journal id BEFORE sending: a duplicate/ambiguous request must not be retried.
const { randomInt } = require("node:crypto");
const SAMPLES = ["LOGIN_CODE", "REGISTER_CODE", "PASSWORD_RESET_CODE", "FIXATION_EXPIRY"];
const SETTING_KEYS = ["SMSC_LOGIN", "SMSC_API_KEY", "SMSC_SENDER", "SMS_ENABLED", "SMS_OTP_LOGIN", "SMS_OTP_REGISTER", "SMS_OTP_PASSWORD_RESET", "SMS_FIXATION_EXPIRY"];

function validateInput(env) {
  const phone = String(env.PHONE || "");
  const sample = String(env.SAMPLE || "LOGIN_CODE");
  const apply = String(env.APPLY || "0");
  const enable = String(env.CONFIRM_ENABLE_PASSWORD_RESET || "0");
  const statusId = String(env.STATUS_ID || "");
  if (!/^\+7\d{10}$/.test(phone)) throw new Error("Invalid PHONE");
  if (!SAMPLES.includes(sample)) throw new Error("Invalid SAMPLE");
  if (!["0", "1"].includes(apply) || !["0", "1"].includes(enable)) throw new Error("Invalid confirmation");
  if (statusId && !/^[1-9]\d{0,19}$/.test(statusId)) throw new Error("Invalid STATUS_ID");
  if (statusId && apply === "1") throw new Error("Status mode cannot send");
  if (enable === "1" && (!statusId || apply !== "0")) throw new Error("Enabling requires status-only delivery confirmation");
  const runId = String(env.GITHUB_RUN_ID || "");
  if (apply === "1" && (!/^[1-9]\d{0,19}$/.test(runId) || env.GITHUB_RUN_ATTEMPT !== "1")) {
    throw new Error("Apply requires a first workflow run attempt");
  }
  return { phone, sample, apply: apply === "1", enable: enable === "1", statusId, journalId: `sms-test-${runId}` };
}

function flag(value) {
  return ["1", "true", "yes", "on", "да"].includes(String(value || "").trim().toLowerCase());
}

async function readSettings(prisma, env) {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: SETTING_KEYS } }, select: { key: true, value: true },
  });
  const byKey = new Map(rows.filter((row) => row.value).map((row) => [row.key, row.value]));
  const get = (key) => String(byKey.get(key) || env[key] || "").trim();
  return { login: get("SMSC_LOGIN"), apiKey: get("SMSC_API_KEY"), sender: get("SMSC_SENDER"),
    enabled: flag(get("SMS_ENABLED")), loginFlag: flag(get("SMS_OTP_LOGIN")),
    registerFlag: flag(get("SMS_OTP_REGISTER")), resetFlag: flag(get("SMS_OTP_PASSWORD_RESET")),
    fixationFlag: flag(get("SMS_FIXATION_EXPIRY")) };
}

function sampleText(sample) {
  const code = String(randomInt(0, 1000000)).padStart(6, "0");
  return {
    LOGIN_CODE: `Код входа в кабинет брокера: ${code}. Никому не сообщайте.`,
    REGISTER_CODE: `Код подтверждения номера: ${code}. Действует 10 минут.`,
    PASSWORD_RESET_CODE: `Тест СМС: ${code}. Код недействителен для входа и смены пароля.`,
    FIXATION_EXPIRY: "Закрепление клиента Иванов А. истекает 20.10. Продлить — в кабинете.",
  }[sample];
}

function failureTag(error) {
  const tags = {
    "SMSC is not configured": "CONFIG_MISSING",
    "Provider balance check failed": "BALANCE_FAILED",
    "TEST journal entry not found": "TEST_NOT_FOUND",
    "TEST was failed or outcome unknown; recovery remains unchanged": "TEST_OUTCOME_UNKNOWN",
    "Provider status check failed": "STATUS_FAILED",
    "Delivery not confirmed; recovery remains unchanged": "DELIVERY_NOT_CONFIRMED",
    "Global enable would activate other SMS flows; recovery remains unchanged": "OTHER_FLOWS_WOULD_ENABLE",
    "SMSC settings changed after delivery check": "SETTINGS_CHANGED",
    "Provider send failed or outcome unknown": "SEND_FAILED_OR_UNKNOWN",
    "Invalid provider id; do not resend": "PROVIDER_ID_INVALID",
  };
  return tags[error && error.message] || "DIAGNOSTIC_FAILED";
}

function loadDependencies() {
  const { PrismaClient } = require("@st-michael/database");
  const { SmscAdapter, isSmscDelivered, isSmscFinalStatus } = require("@st-michael/integrations");
  return { prisma: new PrismaClient(), SmscAdapter, isSmscDelivered, isSmscFinalStatus };
}

async function run(env = process.env, load = loadDependencies, emit = (value) => console.log(JSON.stringify(value))) {
  const input = validateInput(env); // BEFORE loading DB or network clients
  const { prisma, SmscAdapter, isSmscDelivered, isSmscFinalStatus } = load();
  let phase = "settings";
  try {
    const settings = await readSettings(prisma, env);
    const configured = Boolean(settings.login && settings.apiKey);
    emit({ mode: input.statusId ? "status" : input.apply ? "apply" : "dry-run", configured,
      senderConfigured: Boolean(settings.sender), smsEnabled: settings.enabled,
      loginEnabled: configured && settings.enabled && settings.loginFlag,
      registrationEnabled: configured && settings.enabled && settings.registerFlag,
      recoveryEnabled: configured && settings.enabled && settings.resetFlag,
      syntheticCodeNotUsable: true });
    if (!configured) throw new Error("SMSC is not configured");
    const adapter = new SmscAdapter({ login: settings.login, apiKey: settings.apiKey, sender: settings.sender });
    if (input.statusId) {
      phase = "status";
      // No arbitrary message lookup: bind id to this phone's TEST journal row.
      const journal = await prisma.smsMessage.findFirst({
        where: { kind: "TEST", phone: input.phone, providerId: input.statusId },
        select: { id: true, status: true },
      });
      if (!journal) throw new Error("TEST journal entry not found");
      if (input.enable && !["SENT", "DELIVERED"].includes(journal.status)) {
        throw new Error("TEST was failed or outcome unknown; recovery remains unchanged");
      }
      const status = await adapter.getStatus(input.statusId, input.phone);
      const numericStatus = Number.isInteger(status.status) ? status.status : null;
      const delivered = Boolean(status.ok && numericStatus !== null && isSmscDelivered(numericStatus));
      const result = { statusChecked: Boolean(status.ok), providerId: input.statusId,
        providerStatus: numericStatus, delivered,
        final: Boolean(status.ok && numericStatus !== null && isSmscFinalStatus(numericStatus)), journalStatus: journal.status };
      emit(result);
      if (!status.ok) throw new Error("Provider status check failed");
      if (input.enable) {
        if (!delivered) throw new Error("Delivery not confirmed; recovery remains unchanged");
        phase = "enable";
        await prisma.$transaction(async (tx) => {
          const current = await readSettings(tx, env);
          if (!current.login || !current.apiKey) throw new Error("SMSC is not configured");
          if (current.login !== settings.login || current.apiKey !== settings.apiKey || current.sender !== settings.sender) {
            throw new Error("SMSC settings changed after delivery check");
          }
          if (!current.enabled && (current.loginFlag || current.registerFlag || current.fixationFlag)) {
            throw new Error("Global enable would activate other SMS flows; recovery remains unchanged");
          }
          for (const key of ["SMS_ENABLED", "SMS_OTP_PASSWORD_RESET"]) {
            await tx.systemSetting.upsert({ where: { key }, create: { key, value: "1" }, update: { value: "1" } });
          }
        }, { isolationLevel: "Serializable" });
        emit({ passwordResetEnabled: true, otherSmsFlowsUnchanged: true });
        return { ...result, passwordResetEnabled: true };
      }
      return result;
    }
    phase = "balance";
    const balance = await adapter.getBalance();
    emit({ balanceChecked: Boolean(balance.ok), balance: balance.ok && Number.isFinite(balance.balance) ? balance.balance : null });
    if (!balance.ok) throw new Error("Provider balance check failed");
    if (!input.apply) return { sent: false };

    const text = sampleText(input.sample);
    phase = "reserve";
    await prisma.smsMessage.create({ data: { id: input.journalId, phone: input.phone,
      kind: "TEST", text: text.replace(/\b\d{6}\b/g, "••••••"), status: "QUEUED" } });
    phase = "send";
    const sent = await adapter.send(input.phone, text); // ONE attempt, no retry
    if (!sent.ok) {
      const errorCode = Number.isInteger(sent.errorCode) && sent.errorCode >= 1 && sent.errorCode <= 9
        ? sent.errorCode : null;
      await prisma.smsMessage.update({ where: { id: input.journalId },
        data: { status: "FAILED", error: errorCode === null
          ? "Provider rejected or outcome unknown. Do not automatically resend."
          : `Provider error_code=${errorCode}. Do not automatically resend.` } });
      emit({ sent: false, errorCode, outcomeMayBeUnknown: errorCode === null, automaticRetry: false });
      throw new Error("Provider send failed or outcome unknown");
    }
    const providerId = String(sent.id || "");
    if (!/^[1-9]\d{0,19}$/.test(providerId)) throw new Error("Invalid provider id; do not resend");
    const parts = Number.isInteger(sent.parts) && sent.parts > 0 ? sent.parts : null;
    const cost = Number.isFinite(sent.cost) ? sent.cost : null;
    phase = "journal";
    await prisma.smsMessage.update({ where: { id: input.journalId }, data: {
      status: "SENT", providerId, parts, cost, sentAt: new Date(),
    } });
    const result = { sent: true, providerId, parts, cost, delivered: false, automaticRetry: false };
    emit(result);
    return result;
  } catch (error) {
    emit({ diagnosticFailed: true, phase, failureTag: failureTag(error), automaticRetry: false });
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { run, validateInput, sampleText };
if (require.main === module) {
  run().catch(() => { console.error("SMS test diagnostic failed. No automatic resend; inspect the TEST journal/provider status."); process.exitCode = 1; });
}
