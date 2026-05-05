# Настройка автодеплоя на production

**Цель:** после мерджа PR в master GitHub автоматически делает SSH на сервер, подтягивает свежий код, пересобирает Docker и рестартит. Заказчик (mefremov888-ai) может править контент через `/admin/content` и сразу видеть результат на https://72.56.241.199/ — больше не нужно вручную трогать сервер на каждое обновление.

**Время на разовую настройку:** ~5–10 минут.
**После настройки:** деплой полностью автономный.

---

## Что нужно от тебя (Сергей)

1. SSH-ключ от сервера 72.56.241.199 (тот, которым ты заходишь сам — или новый специально для GitHub)
2. Знание пути на сервере где лежит репо (например `/opt/st-michael` или `/root/st-michael-broker-platform`)
3. Доступ в **Settings → Secrets and variables → Actions** в репозитории `sereganikitin/st-michael-broker-platform`

---

## Шаг 1. (Рекомендую) Создать отдельный SSH-ключ для GitHub

Если уже есть ключ — пропускай шаг и используй его. Если нет — на твоём компе:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github-deploy -N "" -C "github-actions-deploy"
```

Создаст два файла:
- `~/.ssh/github-deploy` — приватный ключ (его в GitHub секрет)
- `~/.ssh/github-deploy.pub` — публичный (его на сервер)

## Шаг 2. Авторизовать ключ на сервере

```bash
# Скопировать публичный ключ на сервер 72.56.241.199
ssh-copy-id -i ~/.ssh/github-deploy.pub <user>@72.56.241.199
# Или вручную добавить содержимое github-deploy.pub в ~/.ssh/authorized_keys на сервере
```

Проверь что заходит:
```bash
ssh -i ~/.ssh/github-deploy <user>@72.56.241.199 "echo OK"
```
Должно вывести `OK`.

## Шаг 3. Добавить 4 секрета в GitHub

В репо `sereganikitin/st-michael-broker-platform` → **Settings → Secrets and variables → Actions → New repository secret**:

| Имя секрета | Значение | Пример |
|---|---|---|
| `DEPLOY_HOST` | IP или домен сервера | `72.56.241.199` |
| `DEPLOY_USER` | SSH-юзер | `root` или `deploy` или твой логин |
| `DEPLOY_SSH_KEY` | Содержимое **приватного** ключа `~/.ssh/github-deploy` (от `-----BEGIN ...` до `-----END ...` включительно) | `-----BEGIN OPENSSH PRIVATE KEY-----`<br>`...`<br>`-----END OPENSSH PRIVATE KEY-----` |
| `DEPLOY_PATH` | Путь к репо на сервере | `/opt/st-michael-broker-platform` |

Опционально — если SSH-порт не 22:
| `DEPLOY_PORT` | Порт | `2222` |

## Шаг 4. Убедиться что на сервере есть `deploy-update.sh`

Зайди на сервер, проверь:
```bash
cd /opt/st-michael-broker-platform   # подставь твой путь
ls -la deploy-update.sh
```

Если файла нет — это значит сервер ещё не подтягивал последний master. Запусти один раз вручную:
```bash
git pull origin master
chmod +x deploy-update.sh
```

## Шаг 5. Тест workflow

В GitHub: **Actions → Deploy to production → Run workflow → Run** (на ветке master).

Должен появиться запуск, и через 2–3 минуты статус `✓`. В логах увидишь шаги: pull, build, restart, health check, refresh-cms-content.

Если что-то падает — лог расскажет что именно. Чаще всего:
- неверный путь в `DEPLOY_PATH` → проверь
- нет прав на `~/.ssh/authorized_keys` на сервере → `chmod 600 ~/.ssh/authorized_keys`
- `docker compose` команда не работает → скрипт сам fallback-нет на `docker-compose`

---

## Что происходит при автодеплое

Workflow `.github/workflows/deploy.yml` срабатывает на:
- `push` в `master` (после мерджа PR)
- ручной запуск из GitHub Actions UI

GitHub Actions подключается к серверу по SSH и выполняет `bash deploy-update.sh`, который:

1. `git fetch + reset --hard origin/master` — подтягивает свежий код (без слияний)
2. `docker compose up -d --build` — пересобирает образы и перезапускает контейнеры
3. Ждёт пока API ответит на `/api/health`
4. `prisma db push` — применяет изменения схемы БД (если есть)
5. `refresh-cms-content.js` — обновляет блоки лендинга в БД из дефолтов

Время от мерджа до видимого обновления: ~2-3 минуты (большинство — Docker rebuild).

---

## Что меняется в твоём workflow после настройки

**Было:**
1. mefremov888-ai создаёт PR
2. Сергей ревьювит, мержит
3. Сергей идёт на сервер, делает `git pull && docker compose up -d --build`
4. Сергей запускает `refresh-cms-content.js` если нужно

**Стало:**
1. mefremov888-ai создаёт PR
2. Сергей ревьювит, мержит — **на этом всё**, остальное автоматически

Заказчик правит контент через админку (`/admin/content`, `/admin/promos`) — это вообще не требует мержей или деплоя, всё в БД.

---

## Безопасность

- Приватный ключ хранится **только** в GitHub Secrets — он зашифрован, виден только в момент запуска workflow, в логах не печатается.
- При угрозе компрометации — удали публичный ключ с сервера (`~/.ssh/authorized_keys`) и сгенерируй новый.
- Если хочешь ограничить ключ только этим действием, добавь в `authorized_keys` префикс `command="cd /opt/st-michael-broker-platform && bash deploy-update.sh"` — тогда ключом нельзя будет ничего другого выполнить.

---

## Откат при проблеме

Если деплой что-то сломал, на сервере:
```bash
cd /opt/st-michael-broker-platform
git reset --hard <предыдущий-хеш-коммита>
docker compose up -d --build
```

Или через GitHub: Actions → Deploy to production → Run workflow на нужном теге/коммите. Можно использовать заранее созданные backup-ветки `backup/colleague-master-2026-04-30`.

---

## Контакты при вопросах

Заказчик (mefremov888-ai) — https://github.com/mefremov888-ai
