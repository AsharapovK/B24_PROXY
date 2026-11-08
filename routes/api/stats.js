/**
 * Роут для получения статистики запросов.
 * Читает агрегаты из PostgreSQL через requestStore.hourlyStats (не из app.log).
 * Экспортирует Express router с эндпоинтами для статистики.
 */
import express from "express";
import { chartStats, hourlyStats } from "../../services/requestStore.js";

const router = express.Router();

/**
 * @openapi
 * /api/stats/request-stats:
 *   get:
 *     summary: Получить статистику запросов по часам
 *     description: Возвращает запросы за 24 последовательных часовых интервала по времени Europe/Moscow
 *     responses:
 *       200:
 *         description: Успешный ответ
 *       503:
 *         description: Хранилище запросов недоступно
 */
router.get("/request-stats", async (req, res) => {
  try {
    const { hours, requests } = await hourlyStats();
    res.json({ success: true, hours, counts: requests });
  } catch (error) {
    console.error("stats: хранилище запросов недоступно:", error?.code || error?.name || "error");
    res.status(503).json({ success: false, error: "Хранилище запросов недоступно" });
  }
});

/**
 * @openapi
 * /api/stats/request-stats-detailed:
 *   get:
 *     summary: Получить детализированную статистику по часам
 *     description: Возвращает запросы и ошибки за 24 последовательных часовых интервала по времени Europe/Moscow
 *     responses:
 *       200:
 *         description: Успешный ответ
 *       503:
 *         description: Хранилище запросов недоступно
 */
router.get("/request-stats-detailed", async (req, res) => {
  try {
    const { hours, requests, errors } = await hourlyStats();
    res.json({ success: true, hours, requests, errors });
  } catch (error) {
    console.error("stats: хранилище запросов недоступно:", error?.code || error?.name || "error");
    res.status(503).json({ success: false, error: "Хранилище запросов недоступно" });
  }
});

router.get("/chart", async (req, res) => {
  try {
    const result = await chartStats({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof RangeError) {
      return res.status(400).json({ success: false, error: error.message });
    }
    console.error("stats: chart query failed:", error?.code || error?.name || "error");
    return res.status(503).json({ success: false, error: "Хранилище запросов недоступно" });
  }
});

export default router;
