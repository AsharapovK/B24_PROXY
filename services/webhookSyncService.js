import fs from "fs";
import { syncInvoicesBatch, handleDealDelete, handleInvoiceDelete } from "./invoiceSync.js";

const pendingInvoiceIds = new Set();
let batchTimer = null;
let lastWebhookAt = null;
let webhookCountSinceReset = 0;

/**
 * Извлекает ожидаемый токен из переменной окружения B24_WEBHOOK_APP_TOKEN
 * или из файла секрета B24_WEBHOOK_APP_TOKEN_FILE.
 * @param {string} [explicitToken]
 * @returns {string|null}
 */
export function resolveExpectedToken(explicitToken) {
  if (explicitToken !== undefined && explicitToken !== null) {
    return String(explicitToken).trim();
  }
  if (process.env.B24_WEBHOOK_APP_TOKEN) {
    return process.env.B24_WEBHOOK_APP_TOKEN.trim();
  }
  if (process.env.B24_WEBHOOK_APP_TOKEN_FILE) {
    try {
      return fs.readFileSync(process.env.B24_WEBHOOK_APP_TOKEN_FILE, "utf8").trim();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Проверяет подлинность входящего вебхука от Bitrix24.
 * Токен может передаваться:
 * 1) В auth.application_token (исходящие вебхуки Б24, например ONCRMDEALDELETE)
 * 2) В query-параметре ?token=... (настройка URL в БП)
 * 3) В заголовке X-Webhook-Token
 *
 * @param {import('express').Request} req
 * @param {string} [explicitToken]
 * @returns {boolean}
 */
export function verifyWebhookToken(req, explicitToken) {
  const expectedToken = resolveExpectedToken(explicitToken);
  if (!expectedToken) {
    // Если токен не задан в окружении: в production строго fail-closed
    if (process.env.NODE_ENV === "production") return false;
    return true;
  }

  const tokenCandidate =
    req.body?.auth?.application_token ||
    req.query?.token ||
    req.headers?.["x-webhook-token"] ||
    null;

  if (!tokenCandidate || typeof tokenCandidate !== "string") {
    return false;
  }

  return tokenCandidate === expectedToken;
}

/**
 * Планирует пакетную синхронизацию счетов с debounce (по умолчанию 1.5 сек).
 * Все приходящие за окно debounce ID счетов накапливаются в Set.
 * Когда таймер срабатывает, все накопленные ID запрашиваются одним пакетным запросом (batch),
 * что защищает от превышения лимитов API Битрикс24 (2 req/sec).
 *
 * @param {string | number} invoiceId
 * @param {object} [options]
 * @param {number} [options.debounceMs=1500]
 * @param {Function} [options.syncBatchFn=syncInvoicesBatch]
 * @param {Function} [options.onSuccess]
 * @param {Function} [options.onError]
 * @returns {NodeJS.Timeout}
 */
export function scheduleInvoiceSync(invoiceId, {
  debounceMs = 1500,
  syncBatchFn = syncInvoicesBatch,
  onSuccess,
  onError,
} = {}) {
  const idStr = String(invoiceId).trim();
  if (idStr) {
    pendingInvoiceIds.add(idStr);
  }
  lastWebhookAt = new Date().toISOString();
  webhookCountSinceReset++;

  if (batchTimer) {
    clearTimeout(batchTimer);
  }

  batchTimer = setTimeout(async () => {
    batchTimer = null;
    const idsToSync = Array.from(pendingInvoiceIds);
    pendingInvoiceIds.clear();

    if (idsToSync.length === 0) return;

    try {
      const res = await syncBatchFn(idsToSync);
      if (onSuccess) onSuccess(res);
    } catch (err) {
      if (onError) onError(err);
      else {
        console.error(`[WebhookSync] Ошибка пакетной синхронизации счетов (${idsToSync.join(",")}):`, err?.message || err);
      }
    }
  }, debounceMs);

  return batchTimer;
}

/**
 * Возвращает статистику работы обработчика вебхуков.
 */
export function getWebhookStatus() {
  return {
    lastWebhookAt,
    webhookCountSinceReset,
    pendingCount: pendingInvoiceIds.size,
  };
}

/**
 * Очищает все запланированные таймеры и буфер (используется при остановке или в тестах).
 */
export function clearPendingSyncs() {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  pendingInvoiceIds.clear();
}

/**
 * Сбрасывает счетчики статистики.
 */
export function resetWebhookStatus() {
  lastWebhookAt = null;
  webhookCountSinceReset = 0;
  clearPendingSyncs();
}

export { handleDealDelete, handleInvoiceDelete, syncInvoicesBatch };
