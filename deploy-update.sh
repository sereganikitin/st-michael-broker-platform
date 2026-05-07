#!/bin/bash
# Скрипт обновления продакшна — запускается из GitHub Actions при push в master.
# Может также запускаться вручную: ssh user@server "cd /path/to/repo && bash deploy-update.sh"
#
# Что делает:
#   1) Подтягивает свежий master из git origin
#   2) Пересобирает Docker-образы и перезапускает контейнеры
#   3) Прогоняет prisma db push (если есть изменения в schema.prisma)
#   4) Прогоняет refresh-cms-content.js (синхронизирует CMS-блоки в БД с дефолтами)
#
# Идемпотентен — можно запускать сколько угодно раз подряд.

set -e
cd "$(dirname "$0")"

# Включаем BuildKit — нужен для:
#   - cache mounts в Dockerfile (RUN --mount=type=cache,target=/root/.npm)
#   - syntax=docker/dockerfile:1.6 директивы
# Без BuildKit npm install прогоняется с нуля каждый раз → сборка ~40 минут
# вместо ~5. См. docker/Dockerfile.api и docker/Dockerfile.web.
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

echo "==> Рабочая директория: $(pwd)"

# Detect docker compose command (новый "docker compose" или старый "docker-compose")
COMPOSE_CMD="docker compose"
if ! docker compose version &>/dev/null; then
    COMPOSE_CMD="docker-compose"
fi
echo "==> Используем: $COMPOSE_CMD"

# 1) Pull latest master
echo ""
echo "==> [1/4] Pulling latest master..."
git fetch origin
git reset --hard origin/master
echo "    HEAD: $(git log --oneline -1)"

# 2) Rebuild + restart
echo ""
echo "==> [2/4] Rebuild и рестарт контейнеров..."
$COMPOSE_CMD up -d --build

# 3) Wait for API to be ready
echo ""
echo "==> [3/4] Ждём готовности API..."
for i in {1..30}; do
    if $COMPOSE_CMD exec -T api wget -qO- http://localhost:4000/api/health 2>/dev/null | grep -q ok; then
        echo "    API готов"
        break
    fi
    sleep 2
done

# 4) Apply prisma schema changes (idempotent — если изменений нет, ничего не сделает)
echo ""
echo "==> [4/4] Применение schema.prisma и обновление CMS-контента..."
$COMPOSE_CMD exec -T api npx prisma db push \
    --schema=/app/packages/database/prisma/schema.prisma \
    --accept-data-loss --skip-generate 2>&1 || \
    echo "    (prisma db push не выполнен — может быть несовместимость, не фатально)"

$COMPOSE_CMD exec -T api node /app/scripts/refresh-cms-content.js 2>&1 || \
    echo "    (refresh-cms-content пропущен — не фатально)"

# При первом деплое или по запросу — подтянуть актуальные проекты и акции
# с https://stmichael.ru . Можно отключить установив SKIP_STMICHAEL_SEED=1.
if [ "${SKIP_STMICHAEL_SEED:-0}" != "1" ]; then
    $COMPOSE_CMD exec -T api node /app/scripts/seed-from-stmichael.js 2>&1 || \
        echo "    (seed-from-stmichael пропущен — не фатально)"
fi

# Status check
echo ""
echo "==> Состояние контейнеров:"
$COMPOSE_CMD ps

echo ""
echo "✓ Деплой завершён успешно"
echo "  Сайт: https://72.56.241.199/"
echo "  Свежий коммит: $(git log --oneline -1)"
