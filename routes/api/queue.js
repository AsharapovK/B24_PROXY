/**
 * Роут для работы с очередью запросов.
 * Экспортирует Express router с эндпоинтами для добавления и получения статуса очереди.
 */
import express from "express";
import { requestQueue } from "../../services/queueService.js";
import { listInProgress, searchRequests } from "../../services/requestStore.js";

const router = express.Router();

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
 *       200:
 *         description: Запрос сохранён и добавлен в очередь; расчёт выполняется асинхронно
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
 *                 logId:
 *                   type: string
 *                   description: Идентификатор записи в журнале
 *                 requestId:
 *                   type: string
 *                   description: Уникальный ID запроса
 *                 dealId:
 *                   type: string
 *                   description: ID сделки
 *                 s5:
 *                   type: string
 *                   description: ID счета
 *                 queueSize:
 *                   type: integer
 *                   description: Размер очереди после добавления запроса
 *                 queuePosition:
 *                   type: integer
 *                   description: Значение размера очереди при постановке запроса
 *                 target:
 *                   type: string
 *                   description: Целевой URL для запроса
 */

// Публичный POST /api/queue/proxy регистрируется в index.js до adminAuth и
// до монтирования этого роутера, поэтому здесь дублирующий маршрут удалён.

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
router.get("/in-progress", async (req, res) => {
  try {
    const requests = (await listInProgress()) || [];
    const items = requests.map((r) => ({
      id: r.id ?? null,
      dealId: r.dealId ?? null,
      invoceId: r.invoceId ?? null,
      status: r.state ?? null,
      inProgress: Boolean(r.inProgress),
      timestamp: r.timestamp ?? null,
    }));

    res.json({
      success: true,
      count: items.length,
      items,
      queuePosition: null,
    });
  } catch (error) {
    console.error("queue: хранилище запросов недоступно:", error?.code || error?.name || "error");
    res.status(503).json({ success: false, error: "Хранилище запросов недоступно" });
  }
});

router.get("/position", async (req, res) => {
  const { dealId, invoiceId, id } = req.query;

  if (!dealId && !invoiceId && !id) {
    return res.status(400).json({
      success: false,
      message:
        "Нужно указать хотя бы один из параметров: id, dealId или invoiceId",
    });
  }

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

  try {
    const entries = (await searchRequests({ id, dealId, invoiceId })) || [];
    if (entries.length === 0) {
      responseData.success = false;
      responseData.status = "not_found";
      responseData.message = `Запрос с ${
        id ? `ID=${id}` : dealId ? `dealId=${dealId}` : `invoiceId=${invoiceId}`
      } не найден`;
      return res.status(404).json(responseData);
    }

    // newest first: берём самую свежую запись.
    const request = entries[0];
    const events = Array.isArray(request.events) ? request.events : [];
    const state = request.state;

    // queued/processing как есть; succeeded/failed/interrupted/unknown → completed.
    responseData.status =
      state === "queued" || state === "processing" ? state : "completed";
    responseData.requestId = request.id ?? responseData.requestId;
    responseData.dealId = request.dealId ?? responseData.dealId;
    responseData.invoiceId = request.invoceId ?? responseData.invoiceId;
    responseData.timestamp = request.timestamp ?? responseData.timestamp;

    responseData.events = events;
    responseData.lastEvent = events.length ? events[events.length - 1] : null;

    // p-queue не раскрывает идентификаторы задач; точную позицию не выдумываем.
    responseData.position = null;

    // Длительность выполнения в миллисекундах.
    if (events.length > 1) {
      const startTime = new Date(events[0].timestamp).getTime();
      const endTime = new Date(events[events.length - 1].timestamp).getTime();
      if (!isNaN(startTime) && !isNaN(endTime)) {
        responseData.duration = endTime - startTime;
      }
    }

    const hasErrors = events.some((e) => e.type === "error");
    responseData.details = {
      state,
      inProgress: Boolean(request.inProgress),
      success: state === "succeeded",
      hasErrors,
      attemptCount: events.filter((e) => e.type === "request").length,
      lastUpdated: responseData.lastEvent?.timestamp ?? null,
      completedAt: responseData.status === "completed" ? responseData.timestamp : null,
    };

    return res.json(responseData);
  } catch (error) {
    console.error("queue: хранилище запросов недоступно:", error?.code || error?.name || "error");
    return res.status(503).json({ success: false, error: "Хранилище запросов недоступно" });
  }
});

export default router;
