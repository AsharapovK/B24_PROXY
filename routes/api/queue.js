console.log("DEBUG queue.js loaded");
/**
 * Роут для работы с очередью запросов.
 * Экспортирует Express router с эндпоинтами для добавления и получения статуса очереди.
 */
import express from "express";
import { requestQueue, getQueuePositionById, getQueueStatusById } from "../../services/queueService.js";
import logService, { searchLogs } from "../../services/logService.js";
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
router.get("/", (req, res) => {
  // Получаем queued задачи из logGroups
  const logGroups = requestQueue._logGroups || {};
  const queueArr = Object.values(logGroups)
    .filter(g => g.status === 'queued')
    .map(g => ({
      id: g.id,
      dealId: g.dealId,
      invoceId: g.invoceId,
      status: g.status,
      timestamp: g.events?.find(e => e.type === 'queued')?.timestamp || null
    }));
  res.json({
    success: true,
    size: requestQueue.size,
    pending: requestQueue.pending,
    queue: queueArr,
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

/**
 * @openapi
 * /api/queue/position:
 *   get:
 *     summary: Получить позицию в очереди по ID сделки или счета
 *     parameters:
 *       - in: query
 *         name: dealId
 *         schema:
 *           type: string
 *         required: false
 *         description: ID сделки
 *       - in: query
 *         name: invoiceId
 *         schema:
 *           type: string
 *         required: false
 *         description: ID счета
 *     responses:
 *       200:
 *         description: Позиция в очереди
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 status:
 *                   type: string
 *                 position:
 *                   type: integer
 *                 message:
 *                   type: string
 */
/**
 * @openapi
 * /api/queue/position:
 *   get:
 *     summary: Получить позицию в очереди по ID сделки, счета или requestId
 *     parameters:
 *       - in: query
 *         name: dealId
 *         schema:
 *           type: string
 *         required: false
 *         description: ID сделки
 *       - in: query
 *         name: invoiceId
 *         schema:
 *           type: string
 *         required: false
 *         description: ID счета
 *       - in: query
 *         name: id
 *         schema:
 *           type: string
 *         required: false
 *         description: Request ID (если известен)
 *     responses:
 *       200:
 *         description: Информация о запросе
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 status:
 *                   type: string
 *                   enum: [queued, processing, completed, not_found]
 *                 position:
 *                   type: integer
 *                   nullable: true
 *                   description: Позиция в очереди (только для status=queued)
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   description: Время последнего события
 *                 message:
 *                   type: string
 *                   description: Дополнительная информация
 *       400:
 *         description: Не указаны параметры поиска
 *       404:
 *         description: Запись не найдена ни в очереди, ни в логах
 */
router.get("/position", (req, res) => {
  const { dealId, invoiceId, id } = req.query;
  
  // Валидация входных параметров
  if (!dealId && !invoiceId && !id) {
    return res.status(400).json({ 
      success: false, 
      message: "Нужно указать хотя бы один из параметров: id, dealId или invoiceId" 
    });
  }

  // Сначала проверяем активную очередь
  const queueResult = getQueueStatusById({ dealId, invoiceId, id });
  if (queueResult) {
    const { status, position, logGroup } = queueResult;
    return res.json({ 
      success: true, 
      status,
      position: status === 'queued' ? position : null,
      timestamp: logGroup?.timestamp || new Date().toISOString(),
      message: status === 'queued' ? `Запрос в очереди, позиция: ${position + 1}` : 'Запрос в обработке'
    });
  }

  // Если не нашли в активной очереди, ищем в логах
  const logEntries = searchLogs({ dealId, invoiceId, id });
  if (logEntries.length > 0) {
    // Сортируем по времени (новые записи первыми)
    const sortedLogs = logEntries.sort((a, b) => 
      new Date(b.timestamp) - new Date(a.timestamp)
    );
    
    // Берем самую свежую запись
    const latestLog = sortedLogs[0];
    
    return res.json({
      success: true,
      status: 'completed',
      position: null,
      timestamp: latestLog.timestamp,
      message: 'Запрос уже был обработан',
      lastEvent: latestLog.events?.[latestLog.events.length - 1]?.message || 'Завершено',
      completedAt: latestLog.timestamp
    });
  }

  // Если не нашли нигде
  return res.status(404).json({ 
    success: false, 
    status: 'not_found',
    message: `Запрос с ${id ? `ID=${id}` : dealId ? `dealId=${dealId}` : `invoiceId=${invoiceId}`} не найден` 
  });
});

export default router;
