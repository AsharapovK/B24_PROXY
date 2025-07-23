/**
 * Сервис очереди запросов на основе p-queue.
 * Экспортирует requestQueue для управления асинхронными задачами с ограничением по concurrency.
 */
import PQueue from "p-queue";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { MAX_CONCURRENCY } = require("../config/proxy-config.cjs");

const queue = new PQueue({ concurrency: MAX_CONCURRENCY });

export const requestQueue = queue;

/**
 * Получить позицию в очереди по dealId или invoiceId
 * @param {Object} params - { dealId, invoiceId }
 * @returns {number|null} - позиция (0-based) или null, если не найдено
 */
export function getQueuePositionById({ dealId, invoiceId }) {
  const logGroups = requestQueue._logGroups || {};
  const queue = Object.values(logGroups).filter(g => g.status === 'queued');
  const idx = queue.findIndex(g => {
    if (dealId && g.dealId === dealId) return true;
    if (invoiceId && g.invoceId === invoiceId) return true;
    return false;
  });
  return idx >= 0 ? idx : null;
} 