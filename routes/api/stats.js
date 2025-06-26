/**
 * Роут для получения статистики запросов.
 * Экспортирует Express router с эндпоинтами для статистики.
 */
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import logService from "../../services/logService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

/**
 * @openapi
 * /api/request-stats:
 *   get:
 *     summary: Получить статистику запросов по часам
 *     description: Возвращает количество запросов по каждому часу суток
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
 *                 hours:
 *                   type: array
 *                   items:
 *                     type: string
 *                 counts:
 *                   type: array
 *                   items:
 *                     type: integer
 */
router.get("/request-stats", (req, res) => {
  const logPath = path.join(__dirname, "../../app.log");

  try {
    const logData = fs.readFileSync(logPath, "utf-8");
    const lines = logData.split("\n").filter((line) => line.trim());
    const hourlyCounts = Array(24).fill(0);

    lines.forEach((line) => {
      try {
        const logEntry = JSON.parse(line);
        const message = logEntry.message;
        if (message && message.includes("Добавлен запрос")) {
          const timestamp = logEntry.timestamp;
          const timePart = timestamp.split(" ")[1];
          const hour = parseInt(timePart.split(":")[0], 10);
          hourlyCounts[hour]++;
        }
      } catch (e) {
        logService.warn(`Не удалось распарсить строку лога: ${line}`);
      }
    });

    const hours = Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, "0")}:00`);
    res.json({ success: true, hours, counts: hourlyCounts });
  } catch (error) {
    logService.error("Ошибка при обработке лога:", error);
    res.status(500).json({ success: false, error: "Не удалось обработать лог" });
  }
});

/**
 * @openapi
 * /api/request-stats-detailed:
 *   get:
 *     summary: Получить детализированную статистику по часам
 *     description: Возвращает количество запросов и ошибок по каждому часу суток, с возможностью фильтрации по дате
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Начальная дата (опционально)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Конечная дата (опционально)
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
 *                 hours:
 *                   type: array
 *                   items:
 *                     type: string
 *                 requests:
 *                   type: array
 *                   items:
 *                     type: integer
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: integer
 */
router.get("/request-stats-detailed", (req, res) => {
  const logPath = path.join(__dirname, "../../app.log");

  try {
    if (!fs.existsSync(logPath)) {
      return res.json({
        success: true,
        hours: Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, "0")}:00`),
        requests: Array(24).fill(0),
        errors: Array(24).fill(0),
      });
    }

    const logData = fs.readFileSync(logPath, "utf-8");
    const lines = logData.split("\n").filter((line) => line.trim());
    const hourlyStats = Array(24).fill().map(() => ({ requests: 0, errors: 0 }));

    let startDate, endDate;
    if (req.query.startDate) {
      startDate = new Date(req.query.startDate);
      startDate.setHours(0, 0, 0, 0);
    }
    if (req.query.endDate) {
      endDate = new Date(req.query.endDate);
      endDate.setHours(23, 59, 59, 999);
    }

    lines.forEach((line) => {
      try {
        const logEntry = JSON.parse(line);
        if (!logEntry.timestamp || !logEntry.message) return;

        let timestamp;
        try {
          if (logEntry.timestamp.includes(".")) {
            const [date, time] = logEntry.timestamp.split(" ");
            const [day, month, year] = date.split(".");
            timestamp = new Date(`${year}-${month}-${day}T${time}`);
          } else {
            timestamp = new Date(logEntry.timestamp);
          }
        } catch (e) {
          logService.warn(`Не удалось распарсить дату: ${logEntry.timestamp}`);
          return;
        }

        if (isNaN(timestamp.getTime())) {
          logService.warn(`Некорректная дата: ${logEntry.timestamp}`);
          return;
        }

        if ((!startDate || timestamp >= startDate) && (!endDate || timestamp <= endDate)) {
          const hour = timestamp.getHours();

          if (logEntry.message.includes("Добавлен запрос")) {
            hourlyStats[hour].requests++;
          }

          if (logEntry.level === "error" || logEntry.message.includes("ERROR")) {
            hourlyStats[hour].errors++;
          }
        }
      } catch (e) {
        logService.warn(`Не удалось обработать строку лога: ${line}`);
      }
    });

    const hours = Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, "0")}:00`);
    const requests = hourlyStats.map((stat) => stat.requests);
    const errors = hourlyStats.map((stat) => stat.errors);

    res.json({
      success: true,
      hours,
      requests,
      errors,
    });
  } catch (error) {
    logService.error("Ошибка при обработке лога:", error);
    res.status(500).json({
      success: false,
      error: "Не удалось обработать лог",
      details: error.message,
    });
  }
});

export default router; 