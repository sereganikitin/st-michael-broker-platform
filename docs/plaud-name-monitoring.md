# Ежедневная проверка названий PLAUD

Workflow `Monitor PLAUD file names` ежедневно в 09:00 по Москве проверяет
записи PLAUD за последние 7 дней и отправляет результат в существующий чат
техподдержки кабинета брокера.

Корректное название:

```text
ГГГГ-ММ-ДД ЧЧ:ММ:СС Имя клиента
```

Пример: `2026-09-20 15:37:59 Иван Иванович`.

Проверка использует официальный PLAUD CLI и уже настроенные secrets
технического Telegram-бота:

- `OPS_TELEGRAM_BOT_TOKEN` (или резервный `TELEGRAM_BOT_TOKEN`);
- `OPS_ALERT_CHAT_ID` и/или `OPS_ALERT_CHAT_IDS`.

## Однократная настройка PLAUD

На доверенном компьютере установить CLI и войти:

```powershell
npm install -g @plaud-ai/cli@0.3.14
plaud login
plaud recent --days 7
```

После успешного входа файл `%USERPROFILE%\.plaud\tokens.json` нужно
закодировать в base64 и сохранить в GitHub Actions secret
`PLAUD_CLI_TOKENS_B64`. Сам файл и его содержимое нельзя добавлять в git,
переписку или логи.

Безопасная команда PowerShell, которая передаёт значение прямо в GitHub CLI:

```powershell
$bytes = [IO.File]::ReadAllBytes("$env:USERPROFILE\.plaud\tokens.json")
$value = [Convert]::ToBase64String($bytes)
$value | gh secret set PLAUD_CLI_TOKENS_B64 --repo sereganikitin/st-michael-broker-platform
Remove-Variable value,bytes
```

Затем открыть GitHub Actions, вручную запустить `Monitor PLAUD file names` и
проверить сообщение в чате техподдержки. При ошибке авторизации выполнить
`plaud login` повторно и обновить secret тем же способом.

Локальная проверка без отправки в Telegram:

```powershell
node scripts/monitor-plaud-file-names.mjs --days 7 --dry-run
```

