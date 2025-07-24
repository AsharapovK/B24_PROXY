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
export function getQueuePositionById({ dealId, invoiceId, id }) {
  const logGroups = requestQueue._logGroups || {};
  const queue = Object.values(logGroups).filter(g => g.status === 'queued');
  const idx = queue.findIndex(g => {
    if (id && g.id === id) return true;
    if (dealId && g.dealId === dealId) return true;
    if (invoiceId && g.invoceId === invoiceId) return true;
    return false;
  });
  return idx >= 0 ? idx : null;
}

/**
 * Получить статус и позицию в очереди по dealId, invoiceId или id (requestId)
 * @param {Object} params - { dealId, invoiceId, id }
 * @returns {Object|null} - {status, position|null, logGroup} или null, если не найдено
 */
export function getQueueStatusById({ dealId, invoiceId, id }) {
  const logGroups = requestQueue._logGroups || {};
  const all = Object.values(logGroups);
  const idx = all.findIndex(g => {
    if (id && g.id === id) return true;
    if (dealId && g.dealId === dealId) return true;
    if (invoiceId && g.invoceId === invoiceId) return true;
    return false;
  });
  if (idx === -1) return null;
  const logGroup = all[idx];
  let position = null;
  if (logGroup.status === 'queued') {
    // позиция среди queued
    const queue = all.filter(g => g.status === 'queued');
    position = queue.findIndex(g => g === logGroup);
  }
  return { status: logGroup.status, position, logGroup };
} 