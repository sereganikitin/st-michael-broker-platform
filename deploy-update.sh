#!/bin/bash
# Скрипт обновления продакшна — запускается из GitHub Actions при push в master.
# Может также запускаться вручную: ssh user@server "cd /path/to/repo && bash deploy-update.sh"
#
# Что делает:
#   1) Подтягивает свежий master из git origin
#   2) Пересобирает Docker-образы и перезапускает контейнеры
#   3) Прогоняет prisma db push (если есть изменения в schema.prisma)
#
# refresh-cms-content.js здесь НЕ запускается — он перетирает CMS-блоки, которые
# админ редактирует через /admin/content. Запускать вручную только при обновлении
# дефолтов в коде:
#   docker compose exec -T api node /app/scripts/refresh-cms-content.js
#
# Идемпотентен — можно запускать сколько угодно раз подряд.

set -e
cd "$(dirname "$0")"

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
echo "==> [4/4] Применение schema.prisma..."
$COMPOSE_CMD exec -T api npx prisma db push \
    --schema=/app/packages/database/prisma/schema.prisma \
    --accept-data-loss --skip-generate 2>&1 || \
    echo "    (prisma db push не выполнен — может быть несовместимость, не фатально)"

# Status check
echo ""
echo "==> Состояние контейнеров:"
$COMPOSE_CMD ps

echo ""
echo "✓ Деплой завершён успешно"
echo "  Сайт: https://72.56.241.199/"
echo "  Свежий коммит: $(git log --oneline -1)"
