/**
 * Роут для получения логов сервера через API.
 * Экспортирует Express router с эндпоинтами для работы с логами.
 */
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { requestQueue } from "../../services/queueService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

/**
 * @openapi
 * /api/logs:
 *   get:
 *     summary: Получить логи сервера
 *     description: Возвращает последние 1000 логов сервера (новые сверху)
 *     responses:
 *       200:
 *         description: Успешный ответ с логами
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
 */
router.get("/", (req, res) => {
  try {
    const logPath = path.join(__dirname, "../../app.log");
    const logs = fs.readFileSync(logPath, "utf8");
    let allLogs = logs
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return null; // Игнорируем невалидные JSON строки
        }
      })
      .filter(Boolean); // Убираем null из массива

    const getTimestamp = (log) => {
      if (log.events && log.events.length > 0) {
        return new Date(log.events[log.events.length - 1].timestamp).getTime();
      }
      return new Date(log.timestamp).getTime();
    };
    
    // Сортируем все логи по убыванию timestamp (новые вверху)
    allLogs.sort((a, b) => getTimestamp(b) - getTimestamp(a));

    // Всегда возвращаем только 1000 самых свежих логов
    const logsToSend = allLogs.slice(0, 1000);

    res.json({
      success: true,
      logs: logsToSend,
      total: allLogs.length,
      shown: logsToSend.length,
      queue: [],
      size: requestQueue.size,
      pending: requestQueue.pending
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Ошибка при чтении логов",
      details: error.message,
    });
  }
});

export default router; 