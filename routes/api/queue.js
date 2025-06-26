console.log("DEBUG queue.js loaded");
/**
 * Роут для работы с очередью запросов.
 * Экспортирует Express router с эндпоинтами для добавления и получения статуса очереди.
 */
import express from "express";
import { requestQueue } from "../../services/queueService.js";
import logService from "../../services/logService.js";
import { createRequire } from "module";
import axios from "axios";
const require = createRequire(import.meta.url);
const { TARGET_BASE_URL, TARGET_BASE_URL_INVOICE, MAX_RETRIES, REQUEST_TIMEOUT } = require("../../config/proxy-config.cjs");

const router = express.Router();

// Функция с повторами и таймаутом
async function sendWithRetries(url, retries = MAX_RETRIES) {
  const urlObj = new URL(url);
  const dealIdParam = urlObj.searchParams.get("DealID") || null;
  const dealId = dealIdParam;
  const s5idParam = urlObj.searchParams.get("s5") || null;
  const invoceId = s5idParam;
  const requestId = `${dealId}${invoceId}-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  const logGroup = {
    id: requestId,
    dealId,
    invoceId: invoceId || null,
    events: [],
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    const eventBase = { attempt, timestamp: new Date().toLocaleString("ru-RU", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(",", ""), dealId };
    try {
      logGroup.events.push({ ...eventBase, type: "request", message: `Отправка №${attempt}` });
      const source = axios.CancelToken.source();
      const timeout = setTimeout(() => {
        source.cancel(`Timeout after ${REQUEST_TIMEOUT} seconds`);
      }, REQUEST_TIMEOUT);
      const response = await axios.post(
        url,
        {},
        {
          cancelToken: source.token,
        }
      );
      clearTimeout(timeout);
      logGroup.events.push({ ...eventBase, type: "response", message: `Ответ`, status: response.status, data: response.data });
      if (response.status === 200) {
        logGroup.success = true;
        break;
      } else {
        logGroup.events.push({ ...eventBase, type: "warn", message: `Попытка #${attempt}. Очередь: ${requestQueue.size}. Статус: ${response.status}` });
      }
    } catch (err) {
      logGroup.events.push({ ...eventBase, type: "error", message: `Ошибка: ${err.message}` });
    }
  }
  if (!logGroup.success) {
    logGroup.success = false;
    logGroup.events.push({
      type: "error",
      message: `Лимит попыток превышен | Очередь: ${requestQueue.size} | Запрос не будет отправлен`,
      timestamp: new Date().toLocaleString("ru-RU", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(",", ""),
      dealId,
    });
  }
  logService("info", "grouped_request", logGroup);
}

/**
 * @openapi
 * /api/queue:
 *   get:
 *     summary: Получить статус очереди
 *     description: Возвращает размер очереди и количество активных запросов
 *     responses:
 *       200:
 *         description: Успешный ответ
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 size:
 *                   type: integer
 *                 pending:
 *                   type: integer
 *                 queue:
 *                   type: array
 */
router.get("/queue", (req, res) => {
  res.json({
    success: true,
    size: requestQueue.size,
    pending: requestQueue.pending,
    queue: [], // Можно добавить детали очереди, если нужно
  });
});

/**
 * @openapi
 * /api/proxy:
 *   post:
 *     summary: Добавить запрос в очередь
 *     description: Добавляет запрос в очередь для дальнейшей обработки
 *     parameters:
 *       - in: query
 *         name: DealID
 *         schema:
 *           type: string
 *         description: ID сделки (опционально)
 *       - in: query
 *         name: s5
 *         schema:
 *           type: string
 *         description: Альтернативный идентификатор (опционально)
 *     responses:
 *       202:
 *         description: Запрос добавлен в очередь
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 dealId:
 *                   type: string
 *                 queuePosition:
 *                   type: integer
 *                 activeRequests:
 *                   type: integer
 *                 target:
 *                   type: string
 *                 requestId:
 *                   type: string
 */
router.post("/proxy", (req, res) => {
  const fullQuery = req.originalUrl.split("?")[1] || "";
  const urlObj = new URL(`http://dummy?${fullQuery}`);
  const invoceId = urlObj.searchParams.get("s5");
  const dealId = urlObj.searchParams.get("DealID");

  // Выбираем целевой URL на основе параметров
  const baseUrl = invoceId ? TARGET_BASE_URL_INVOICE : TARGET_BASE_URL;
  const targetUrl = `${baseUrl}?${fullQuery}`;

  // Добавляем событие "В очереди"
  const requestId = `${dealId || ""}${invoceId || ""}-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  const queuedEvent = {
    type: "queued",
    message: `Запрос добавлен в очередь.`,
    timestamp: new Date().toLocaleString("ru-RU", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(",", ""),
    dealId,
    invoceId: invoceId || null,
    requestId,
  };
  const logGroup = {
    id: requestId,
    dealId,
    invoceId: invoceId || null,
    status: "queued",
    events: [queuedEvent],
  };

  // Сохраняем группу в памяти (можно вынести в отдельный стор)
  requestQueue._logGroups = requestQueue._logGroups || {};
  requestQueue._logGroups[requestId] = logGroup;

  // Сразу отправляем событие о новой группе (queued)
  console.log("logGroup for logService:", logGroup); // DEBUG
  logService("info", "grouped_request", logGroup);

  requestQueue.add(async () => {
    logGroup.inProgress = true;
    logGroup.events.push({
      type: "processing",
      message: "Запрос взят в работу",
      timestamp: new Date().toLocaleString("ru-RU", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(",", ""),
      dealId,
      invoceId: invoceId || null,
      requestId,
    });
    logService("info", "grouped_request", logGroup);
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const eventBase = {
        attempt,
        timestamp: new Date().toLocaleString("ru-RU", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(",", ""),
        dealId,
        invoceId: invoceId || null,
        requestId,
      };
      try {
        logGroup.events.push({ ...eventBase, type: "request", message: `Отправка №${attempt}` });
        // === duration между queued и последним событием ===
        const queuedEvent = logGroup.events.find((e) => e.type === "queued");
        const lastEvent = logGroup.events[logGroup.events.length - 1];
        if (queuedEvent && lastEvent) {
          const t1 = new Date(queuedEvent.timestamp).getTime();
          const t2 = new Date(lastEvent.timestamp).getTime();
          if (!isNaN(t1) && !isNaN(t2) && t2 > t1) {
            logGroup.duration = ((t2 - t1) / 1000).toFixed(1);
          }
        }
        // === END ===
        logService("info", "grouped_request", logGroup);
        const source = axios.CancelToken.source();
        const timeout = setTimeout(() => {
          source.cancel(`Timeout after ${REQUEST_TIMEOUT} seconds`);
        }, REQUEST_TIMEOUT);
        const response = await axios.post(
          targetUrl,
          {},
          {
            cancelToken: source.token,
          }
        );
        clearTimeout(timeout);
        logGroup.events.push({ ...eventBase, type: "response", message: `Ответ`, status: response.status, data: response.data });
        logService("info", "grouped_request", logGroup);
        if (response.status === 200) {
          break;
        } else {
          logGroup.events.push({ ...eventBase, type: "warn", message: `Попытка #${attempt}. Очередь: ${requestQueue.size}. Статус: ${response.status}` });
          logService("info", "grouped_request", logGroup);
        }
      } catch (err) {
        logGroup.events.push({ ...eventBase, type: "error", message: `Ошибка: ${err.message}` });
        logService("info", "grouped_request", logGroup);
      }
    }
    // Если не было успешного ответа, добавляем финальную ошибку
    const hasSuccess = logGroup.events.some((e) => e.type === "response" && e.status === 200);
    if (!hasSuccess) {
      logGroup.events.push({
        type: "error",
        message: `Лимит попыток превышен | Очередь: ${requestQueue.size} | Запрос не будет отправлен`,
        timestamp: new Date().toLocaleString("ru-RU", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(",", ""),
        dealId,
        invoceId: invoceId || null,
        requestId,
      });
      logService("info", "grouped_request", logGroup);
    }
    logGroup.inProgress = false;
    logService("info", "grouped_request", logGroup);
  });

  // Возвращаем ответ с указанием целевого адреса
  res.status(202).json({
    success: true,
    message: "Запрос добавлен в очередь.",
    dealId,
    queuePosition: requestQueue.size,
    activeRequests: requestQueue.pending,
    target: targetUrl,
    requestId,
  });
});

export default router;
