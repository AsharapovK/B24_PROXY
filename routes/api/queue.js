console.log("DEBUG queue.js loaded");
/**
 * Роут для работы с очередью запросов.
 * Экспортирует Express router с эндпоинтами для добавления и получения статуса очереди.
 */
import express from "express";
import {
  requestQueue,
  getQueuePositionById,
  getQueueStatusById,
} from "../../services/queueService.js";
import logService, { searchLogs } from "../../services/logService.js";
import { createRequire } from "module";
import axios from "axios";
const require = createRequire(import.meta.url);
const {
  TARGET_BASE_URL,
  TARGET_BASE_URL_INVOICE,
  MAX_RETRIES,
  REQUEST_TIMEOUT,
} = require("../../config/proxy-config.cjs");

const router = express.Router();

// Функция с повторами и таймаутом
async function sendWithRetries(url, retries = MAX_RETRIES) {
  const urlObj = new URL(url);
  const dealIdParam = urlObj.searchParams.get("DealID") || null;
  const dealId = dealIdParam;
  const s5idParam = urlObj.searchParams.get("s5") || null;
  const invoceId = s5idParam;
  const requestId = `${dealId}${invoceId}-${Date.now()}-${Math.random()
    .toString(36)
    .substr(2, 6)}`;
  const logGroup = {
    id: requestId,
    dealId,
    invoceId: invoceId || null,
    events: [],
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    const eventBase = {
      attempt,
      timestamp: new Date()
        .toLocaleString("ru-RU", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
        .replace(",", ""),
      dealId,
    };
    try {
      logGroup.events.push({
        ...eventBase,
        type: "request",
        message: `Отправка №${attempt}`,
      });
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
      logGroup.events.push({
        ...eventBase,
        type: "response",
        message: `Ответ`,
        status: response.status,
        data: response.data,
      });
      if (response.status === 200) {
        logGroup.success = true;
        break;
      } else {
        logGroup.events.push({
          ...eventBase,
          type: "warn",
          message: `Попытка #${attempt}. Очередь: ${requestQueue.size}. Статус: ${response.status}`,
        });
      }
    } catch (err) {
      logGroup.events.push({
        ...eventBase,
        type: "error",
        message: `Ошибка: ${err.message}`,
      });
    }
  }
  if (!logGroup.success) {
    logGroup.success = false;
    logGroup.events.push({
      type: "error",
      message: `Лимит попыток превышен | Очередь: ${requestQueue.size} | Запрос не будет отправлен`,
      timestamp: new Date()
        .toLocaleString("ru-RU", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
        .replace(",", ""),
      dealId,
    });
  }
  logService("info", "grouped_request", logGroup);
}

// /**
//  * @openapi
//  * /api/queue:
//  *   get:
//  *     summary: Получить статус очереди
//  *     description: Возвращает размер очереди, количество активных запросов и список элементов в очереди
//  *     responses:
//  *       200:
//  *         description: Успешный ответ
//  *         content:
//  *           application/json:
//  *             schema:
//  *               type: object
//  *               properties:
//  *                 success:
//  *                   type: boolean
//  *                   description: Статус операции
//  *                 size:
//  *                   type: integer
//  *                   description: Размер очереди
//  *                 pending:
//  *                   type: integer
//  *                   description: Количество активных запросов
//  *                 queue:
//  *                   type: array
//  *                   description: Массив элементов в очереди
//  *                   items:
//  *                     type: object
//  *                     properties:
//  *                       id:
//  *                         type: string
//  *                         description: Уникальный идентификатор запроса
//  *                       dealId:
//  *                         type: string
//  *                         description: ID сделки
//  *                       invoceId:
//  *                         type: string
//  *                         description: ID счета
//  *                       status:
//  *                         type: string
//  *                         description: Статус запроса
//  *                       timestamp:
//  *                         type: string
//  *                         description: Время добавления в очередь
//  */
// router.get("/", (req, res) => {
//   // Получаем queued задачи из logGroups
//   const logGroups = requestQueue._logGroups || {};
//   const queueArr = Object.values(logGroups)
//     .filter((g) => g.status === "queued")
//     .map((g) => ({
//       id: g.id,
//       dealId: g.dealId,
//       invoceId: g.invoceId,
//       status: g.status,
//       timestamp: g.events?.find((e) => e.type === "queued")?.timestamp || null,
//     }));
//   res.json({
//     success: true,
//     size: requestQueue.size,
//     pending: requestQueue.pending,
//     queue: queueArr,
//   });
// });

/**
 * @openapi
 * /api/proxy:
 *   post:
 *     summary: Добавить запрос в очередь
 *     description: Добавляет запрос в очередь для дальнейшей обработки с автоматическими повторами при ошибках
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
 *         description: ID счета (опционально)
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
 *                   description: Статус операции
 *                 message:
 *                   type: string
 *                   description: Сообщение о результате
 *                 dealId:
 *                   type: string
 *                   description: ID сделки
 *                 queuePosition:
 *                   type: integer
 *                   description: Позиция в очереди
 *                 activeRequests:
 *                   type: integer
 *                   description: Количество активных запросов
 *                 target:
 *                   type: string
 *                   description: Целевой URL для запроса
 *                 requestId:
 *                   type: string
 *                   description: Уникальный идентификатор запроса
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
  const requestId = `${dealId || ""}${
    invoceId || ""
  }-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  const queuedEvent = {
    type: "queued",
    message: `Запрос добавлен в очередь.`,
    timestamp: new Date()
      .toLocaleString("ru-RU", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
      .replace(",", ""),
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
      timestamp: new Date()
        .toLocaleString("ru-RU", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
        .replace(",", ""),
      dealId,
      invoceId: invoceId || null,
      requestId,
    });
    logService("info", "grouped_request", logGroup);
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const eventBase = {
        attempt,
        timestamp: new Date()
          .toLocaleString("ru-RU", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })
          .replace(",", ""),
        dealId,
        invoceId: invoceId || null,
        requestId,
      };
      try {
        logGroup.events.push({
          ...eventBase,
          type: "request",
          message: `Отправка №${attempt}`,
        });
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
        logGroup.events.push({
          ...eventBase,
          type: "response",
          message: `Ответ`,
          status: response.status,
          data: response.data,
        });
        logService("info", "grouped_request", logGroup);
        if (response.status === 200) {
          break;
        } else {
          logGroup.events.push({
            ...eventBase,
            type: "warn",
            message: `Попытка #${attempt}. Очередь: ${requestQueue.size}. Статус: ${response.status}`,
          });
          logService("info", "grouped_request", logGroup);
        }
      } catch (err) {
        logGroup.events.push({
          ...eventBase,
          type: "error",
          message: `Ошибка: ${err.message}`,
        });
        logService("info", "grouped_request", logGroup);
      }
    }
    // Если не было успешного ответа, добавляем финальную ошибку
    const hasSuccess = logGroup.events.some(
      (e) => e.type === "response" && e.status === 200
    );
    if (!hasSuccess) {
      logGroup.events.push({
        type: "error",
        message: `Лимит попыток превышен | Очередь: ${requestQueue.size} | Запрос не будет отправлен`,
        timestamp: new Date()
          .toLocaleString("ru-RU", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })
          .replace(",", ""),
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
 *     summary: Получить статус запроса по ID сделки, счета или requestId
 *     description: Возвращает полную информацию о запросе включая статус, позицию в очереди, события и детали выполнения
 *     parameters:
 *       - in: query
 *         name: dealId
 *         schema:
 *           type: string
 *         required: false
 *         description: ID сделки для поиска
 *       - in: query
 *         name: invoiceId
 *         schema:
 *           type: string
 *         required: false
 *         description: ID счета для поиска
 *       - in: query
 *         name: id
 *         schema:
 *           type: string
 *         required: false
 *         description: Request ID для поиска
 *     responses:
 *       200:
 *         description: Информация о запросе найдена
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Статус операции
 *                 requestId:
 *                   type: string
 *                   description: Уникальный идентификатор запроса
 *                 dealId:
 *                   type: string
 *                   description: ID сделки
 *                 invoiceId:
 *                   type: string
 *                   description: ID счета
 *                 status:
 *                   type: string
 *                   enum: [queued, processing, completed, not_found]
 *                   description: Статус запроса
 *                 position:
 *                   type: integer
 *                   nullable: true
 *                   description: Позиция в очереди (только для status=queued)
 *                 totalInQueue:
 *                   type: integer
 *                   description: Общее количество элементов в очереди
 *                 activeRequests:
 *                   type: integer
 *                   description: Количество активных запросов
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   description: Время последнего события
 *                 events:
 *                   type: array
 *                   description: Массив событий запроса
 *                   items:
 *                     type: object
 *                     properties:
 *                       type:
 *                         type: string
 *                         description: Тип события
 *                       message:
 *                         type: string
 *                         description: Сообщение события
 *                       timestamp:
 *                         type: string
 *                         description: Время события
 *                       status:
 *                         type: integer
 *                         description: HTTP статус (для ответов)
 *                       data:
 *                         type: object
 *                         description: Данные ответа
 *                 lastEvent:
 *                   type: object
 *                   description: Последнее событие
 *                 duration:
 *                   type: integer
 *                   description: Длительность выполнения в миллисекундах
 *                 completedAt:
 *                   type: string
 *                   format: date-time
 *                   description: Время завершения (для завершенных запросов)
 *                 message:
 *                   type: string
 *                   description: Дополнительная информация
 *                 details:
 *                   type: object
 *                   description: Дополнительные детали
 *                   properties:
 *                     inProgress:
 *                       type: boolean
 *                       description: Флаг выполнения
 *                     success:
 *                       type: boolean
 *                       description: Успешность выполнения
 *                     attemptCount:
 *                       type: integer
 *                       description: Количество попыток
 *                     lastUpdated:
 *                       type: string
 *                       description: Время последнего обновления
 *                     hasErrors:
 *                       type: boolean
 *                       description: Наличие ошибок
 *       400:
 *         description: Не указаны параметры поиска
 *       404:
 *         description: Запись не найдена ни в очереди, ни в логах
 */

/**
 * @openapi
 * /api/queue/in-progress:
 *   get:
 *     summary: Получить список элементов в процессе обработки
 *     description: Возвращает количество и массив элементов, которые находятся в процессе обработки, из лог-файла
 *     parameters:
 *       - in: query
 *         name: dealId
 *         schema:
 *           type: string
 *         required: false
 *         description: ID сделки для поиска позиции
 *       - in: query
 *         name: invoceId
 *         schema:
 *           type: string
 *         required: false
 *         description: ID счета для поиска позиции
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
 *                   description: Статус операции
 *                 count:
 *                   type: integer
 *                   description: Количество элементов в процессе обработки
 *                 items:
 *                   type: array
 *                   description: Массив элементов в процессе обработки
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         description: Уникальный идентификатор запроса
 *                       dealId:
 *                         type: string
 *                         description: ID сделки
 *                       invoceId:
 *                         type: string
 *                         description: ID счета
 *                       status:
 *                         type: string
 *                         description: Статус запроса
 *                       inProgress:
 *                         type: boolean
 *                         description: Флаг выполнения
 *                       timestamp:
 *                         type: string
 *                         description: Время последнего события
 *                       queuePosition:
 *                         type: integer
 *                         nullable: true
 *                         description: Позиция в очереди
 *                 queuePosition:
 *                   type: integer
 *                   nullable: true
 *                   description: Позиция найденного элемента в списке
 *       500:
 *         description: Ошибка чтения лог-файла
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Статус операции
 *                 error:
 *                   type: string
 *                   description: Описание ошибки
 *                 details:
 *                   type: string
 *                   description: Детали ошибки
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_FILE_PATH = join(__dirname, "../../app.log");

router.get("/in-progress", (req, res) => {
  try {
    const { id } = req.query;

    // Читаем и парсим лог-файл
    const logContent = readFileSync(LOG_FILE_PATH, "utf-8");
    const lines = logContent.split("\n").filter((line) => line.trim());

    // Фильтруем строки с inProgress:true и парсим их в объекты
    let inProgressItems = lines
      .filter((line) => line.includes('"inProgress":true'))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (e) {
          console.error("Error parsing log line:", e);
          return null;
        }
      })
      .filter(Boolean) // Удаляем null (невалидные JSON)
      .map((entry) => {
        return {
          id: entry.id,
          dealId: entry.dealId,
          invoceId: entry.invoceId,
          status: entry.status,
          inProgress: true,
          timestamp: entry.timestamp || null,
          queuePosition: null,
        };
      });

    let queuePosition = null;
    for (let i = 0; i < inProgressItems.length; i++) {
      if (id && inProgressItems[i].dealId === id) {
        queuePosition = i;
      }
      if (id && inProgressItems[i].invoceId === id) {
        queuePosition = i;
      }
    }

    res.json({
      success: true,
      count: inProgressItems.length,
      items: inProgressItems,
      queuePosition: queuePosition,
    });
  } catch (error) {
    console.error("Error reading log file:", error);
    res.status(500).json({
      success: false,
      error: "Failed to read log file",
      details: error.message,
    });
  }
});

router.get("/position", (req, res) => {
  const { dealId, invoiceId, id } = req.query;
  const searchParams = { dealId, invoiceId, id };

  // Валидация входных параметров
  if (!dealId && !invoiceId && !id) {
    return res.status(400).json({
      success: false,
      message:
        "Нужно указать хотя бы один из параметров: id, dealId или invoiceId",
    });
  }

  // Собираем полную информацию о запросе
  const responseData = {
    success: true,
    requestId: id || null,
    dealId: dealId || null,
    invoiceId: invoiceId || null,
    status: "not_found",
    position: null,
    totalInQueue: requestQueue.size,
    activeRequests: requestQueue.pending,
    timestamp: new Date().toISOString(),
    events: [],
    lastEvent: null,
    duration: null,
    details: {},
  };

  // Проверяем активную очередь
  const queueResult = getQueueStatusById(searchParams);
  if (queueResult) {
    const { status, position, logGroup } = queueResult;

    // Обновляем основную информацию
    responseData.status = status;
    responseData.position = status === "queued" ? position : null;
    responseData.timestamp = logGroup?.timestamp || new Date().toISOString();
    responseData.message =
      status === "queued"
        ? `Запрос в очереди, позиция: ${position + 1}`
        : "Запрос в обработке";

    // Добавляем события из очереди
    if (logGroup?.events?.length) {
      responseData.events = logGroup.events;
      responseData.lastEvent = logGroup.events[logGroup.events.length - 1];

      // Вычисляем длительность выполнения
      if (logGroup.events.length > 1) {
        const startTime = new Date(logGroup.events[0].timestamp);
        const endTime = new Date(
          logGroup.events[logGroup.events.length - 1].timestamp
        );
        if (!isNaN(startTime) && !isNaN(endTime)) {
          responseData.duration = endTime - startTime;
        }
      }
    }

    // Добавляем дополнительные детали
    responseData.details = {
      inProgress: logGroup?.inProgress || false,
      success: logGroup?.success,
      attemptCount:
        logGroup?.events?.filter((e) => e.type === "request").length || 0,
      lastUpdated: logGroup?.events?.[logGroup.events.length - 1]?.timestamp,
    };

    return res.json(responseData);
  }

  // Если не нашли в активной очереди, ищем в логах
  const logEntries = searchLogs(searchParams);
  if (logEntries.length > 0) {
    // Сортируем по времени (новые записи первыми)
    const sortedLogs = logEntries.sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    );

    // Берем самую свежую запись
    const latestLog = sortedLogs[0];

    // Обновляем основную информацию
    responseData.status = "completed";
    responseData.timestamp = latestLog.timestamp;
    responseData.message = "Запрос уже был обработан";
    responseData.lastEvent =
      latestLog.events?.[latestLog.events.length - 1] || null;
    responseData.completedAt = latestLog.timestamp;

    // Добавляем все события
    if (latestLog.events?.length) {
      responseData.events = latestLog.events;

      // Вычисляем длительность выполнения
      if (latestLog.events.length > 1) {
        const startTime = new Date(latestLog.events[0].timestamp);
        const endTime = new Date(
          latestLog.events[latestLog.events.length - 1].timestamp
        );
        if (!isNaN(startTime) && !isNaN(endTime)) {
          responseData.duration = endTime - startTime;
        }
      }
    }

    // Добавляем дополнительные детали
    responseData.details = {
      success: latestLog.success,
      attemptCount:
        latestLog.events?.filter((e) => e.type === "request").length || 0,
      completedAt: latestLog.timestamp,
      hasErrors: latestLog.events?.some((e) => e.type === "error"),
    };

    return res.json(responseData);
  }

  // Если не нашли нигде
  responseData.success = false;
  responseData.message = `Запрос с ${
    id ? `ID=${id}` : dealId ? `dealId=${dealId}` : `invoiceId=${invoiceId}`
  } не найден`;
  return res.status(404).json(responseData);
});

export default router;
