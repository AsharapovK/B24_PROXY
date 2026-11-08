#!/usr/bin/env bash
# ==============================================================================
# cron-sync-invoices.sh - Периодический запуск синхронизации счетов Bitrix24
# Запуск каждые 10 минут через системный Cron:
# */10 * * * * /bin/bash "<path_to>/cron-sync-invoices.sh"
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOGS_DIR="${PROXY_DIR}/logs"
LOCK_FILE="/tmp/b24_invoice_sync.lock"
LOG_FILE="${LOGS_DIR}/invoice-sync.log"

mkdir -p "${LOGS_DIR}"

# 1. Защита от параллельного запуска нескольких инстансов (Mutex lock)
exec 200>"${LOCK_FILE}"
if ! flock -n 200 2>/dev/null && ! perl -e 'use Fcntl qw(:flock); open(my $f, ">", $ARGV[0]) or exit 1; flock($f, LOCK_EX|LOCK_NB) or exit 1;' "${LOCK_FILE}" 2>/dev/null; then
  # Простая проверка через PID-файл при отсутствии flock на macOS
  if [[ -f "${LOCK_FILE}.pid" ]]; then
    PID="$(cat "${LOCK_FILE}.pid" 2>/dev/null || echo "")"
    if [[ -n "${PID}" ]] && kill -0 "${PID}" 2>/dev/null; then
      echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [CronSync] Предыдущий процесс синхронизации (PID ${PID}) еще выполняется. Пропуск." >> "${LOG_FILE}"
      exit 0
    fi
  fi
fi

echo "$$" > "${LOCK_FILE}.pid"
trap 'rm -f "${LOCK_FILE}.pid"' EXIT

# 2. Определение пути к node
NODE_BIN="$(which node 2>/dev/null || echo "/usr/local/bin/node")"
if [[ ! -x "${NODE_BIN}" ]] && [[ -x "/opt/homebrew/bin/node" ]]; then
  NODE_BIN="/opt/homebrew/bin/node"
fi

if [[ ! -x "${NODE_BIN}" ]]; then
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [CronSync] Ошибка: Node.js не найден в PATH" >> "${LOG_FILE}"
  exit 1
fi

# 3. Запуск синхронизации счетов за сегодня и вчера (--days=2)
echo "================================================================================" >> "${LOG_FILE}"
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [CronSync] Старт синхронизации счетов раз в 10 минут..." >> "${LOG_FILE}"

cd "${PROXY_DIR}"
"${NODE_BIN}" "${SCRIPT_DIR}/sync-invoices.js" --days=2 >> "${LOG_FILE}" 2>&1

EXIT_CODE=$?
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [CronSync] Завершено с кодом ${EXIT_CODE}" >> "${LOG_FILE}"

# Дублирование статуса в общий каталог мониторинга (если существует /var/lib/b24-reporting)
if [[ -d "/var/lib/b24-reporting" ]] && [[ -f "/tmp/b24-invoice-sync-status.json" ]]; then
  cp -f "/tmp/b24-invoice-sync-status.json" "/var/lib/b24-reporting/invoice-sync-status.json" 2>/dev/null || true
fi

exit ${EXIT_CODE}

