/**
 * Главный файл запуска прокси-сервера Bitrix24.
 * Инициализирует Express, очередь, логирование, WebSocket, роуты и middleware.
 * Точка входа для всего приложения.
 */
import express from "express";
import { createServer } from "http";
import axios from "axios";
import PQueue from "p-queue";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import crypto from "crypto";

import { addLogEntry, updateLogEntry } from "./services/logService.js";
import { initWebSocketServer } from "./services/websocketService.js";
import logsRouter from "./routes/api/logs.js";
import queueRouter from "./routes/api/queue.js";
import statsRouter from "./routes/api/stats.js";
import errorHandler from "./middlewares/errorHandler.js";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";

// Обработка необработанных исключений
process.on("uncaughtException", (error) => {
  console.error("Необработанное исключение:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Необработанный промис:", reason);
});

const require = createRequire(import.meta.url);
const { PROXY_PORT, SERVER_IP, TARGET_BASE_URL, REQUEST_TIMEOUT, MAX_RETRIES, MAX_CONCURRENCY } = require("./config/proxy-config.cjs");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// Инициализация WebSocket сервера
initWebSocketServer(server);

const queue = new PQueue({ concurrency: MAX_CONCURRENCY });

async function sendWithRetries(url, retries = MAX_RETRIES, logId) {
  const urlObj = new URL(url);
  const dealId = urlObj.searchParams.get("DEAL_ID") || "N/A";

  const createEvent = (type, message, data = {}) => ({
    type,
    message,
    timestamp: new Date().toISOString(),
    ...data,
  });

  await updateLogEntry(logId, createEvent('processing', 'Запрос взят в работу'));

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await updateLogEntry(logId, createEvent('request', `Отправка №${attempt}`));
      const source = axios.CancelToken.source();
      const timeout = setTimeout(() => source.cancel(`Timeout after ${REQUEST_TIMEOUT}ms`), REQUEST_TIMEOUT);

      const response = await axios.post(url, {}, { cancelToken: source.token });
      clearTimeout(timeout);

      if (response.status === 200) {
        await updateLogEntry(logId, createEvent('response', `Ответ | Статус: ${response.status}`, { status: response.status, data: response.data }));
        return;
      } else {
        await updateLogEntry(logId, createEvent('warn', `Неуспешный статус: ${response.status}`, { status: response.status }));
      }
    } catch (err) {
      const errorMessage = err.message || 'Неизвестная ошибка';
      await updateLogEntry(logId, createEvent('error', `Ошибка: ${errorMessage}`, { attempt }));
    }
  }

  await updateLogEntry(logId, createEvent('error', `Лимит попыток исчерпан`, { retries }));
}

// Мидлвары
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'dist')));

// Swagger
const swaggerOptions = {
  swaggerDefinition: {
    openapi: '3.0.0',
    info: {
      title: 'B24 QProxy API',
      version: '1.0.0',
    },
  },
  apis: ['./routes/api/*.js'],
};
const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// API маршруты
app.use("/api/logs", logsRouter);
app.use("/api/queue", queueRouter);
app.use("/api/stats", statsRouter);

// Основной прокси-маршрут
app.all("/api/proxy", (req, res) => {
  const logId = crypto.randomUUID();

  // Выбор целевого URL
  let baseUrl;
  if (req.query.s5) {
    baseUrl = require("./config/proxy-config.cjs").TARGET_BASE_URL_INVOICE;
  } else {
    baseUrl = require("./config/proxy-config.cjs").TARGET_BASE_URL;
  }
  const targetUrl = new URL(baseUrl);
  targetUrl.search = new URLSearchParams(req.query).toString();

  const dealId = req.query.DealID || "N/A";
  const methodForLogging = req.query.Workflow || "proxy_request";

  let type, typeMessage;
  if (req.query.s5) {
    type = 'invoice';
    typeMessage = `Счет (ID: ${req.query.s5})`;
  } else {
    type = 'deal';
    typeMessage = `Сделка (ID: ${dealId})`;
  }

  const initialLog = {
    id: logId,
    dealId,
    invoceId: req.query.s5 || null,
    type,
    method: methodForLogging,
    timestamp: new Date().toISOString(),
    inProgress: true,
    events: [{
      type: 'queued',
      message: `Запрос добавлен в очередь: ${typeMessage}`,
      timestamp: new Date().toISOString()
    }]
  };

  addLogEntry(initialLog);

  queue.add(() => sendWithRetries(targetUrl.href, MAX_RETRIES, logId));
  
  res.status(202).json({
    success: true,
    message: "Запрос принят в обработку.",
    queueSize: queue.size,
    logId,
    target: targetUrl.href,
    dealId: req.query.DealID || null,
    s5: req.query.s5 || null
  });
});

app.use(errorHandler);

// Отдаем SPA для всех остальных запросов
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

server.listen(PROXY_PORT, SERVER_IP, () => {
  console.log(`Сервер запущен: http://${SERVER_IP}:${PROXY_PORT}`);
});

export default app;
