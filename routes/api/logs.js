/**
 * Роут для получения журнала запросов через API.
 * Читает записи из PostgreSQL через requestStore.listRequests (не из app.log).
 * Экспортирует Express router с эндпоинтами для работы с логами.
 */
import express from "express";
import { requestQueue } from "../../services/queueService.js";
import { listRequests } from "../../services/requestStore.js";

const router = express.Router();

/**
 * @openapi
 * /api/logs:
 *   get:
 *     summary: Получить журнал запросов
 *     description: Возвращает последние 200 записей счетов из PostgreSQL (новые сверху)
 *     responses:
 *       200:
 *         description: Успешный ответ с журналом
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 logs:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 shown:
 *                   type: integer
 *                 queue:
 *                   type: array
 *                 size:
 *                   type: integer
 *                 pending:
 *                   type: integer
 *       503:
 *         description: Хранилище запросов недоступно
 */
router.get("/", async (req, res) => {
  try {
    const { total, items } = await listRequests({ limit: 200, kind: "invoice" });
    const logs = Array.isArray(items) ? items : [];

    res.json({
      success: true,
      logs,
      total: Number.isFinite(total) ? total : logs.length,
      shown: logs.length,
      queue: [],
      size: requestQueue.size,
      pending: requestQueue.pending,
    });
  } catch (error) {
    console.error("logs: хранилище запросов недоступно:", error?.code || error?.name || "error");
    res.status(503).json({ success: false, error: "Хранилище запросов недоступно" });
  }
});

export default router;
