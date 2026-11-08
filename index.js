/**
 * Главный файл запуска прокси-сервера Bitrix24.
 * Инициализирует Express, очередь, логирование, WebSocket, роуты и middleware.
 * Точка входа для всего приложения.
 */
import dns from "dns";
// Принудительно используем IPv4 для предотвращения сетевых сбоев ENETUNREACH внутри Docker
dns.setDefaultResultOrder("ipv4first");

import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

import { initWebSocketServer } from "./services/websocketService.js";
import { checkDatabase, markInterrupted, pool } from "./services/requestStore.js";
import { handleProxyRequest, INSTANCE_REF } from "./services/proxyHandler.js";
import { syncRecentInvoices } from "./services/invoiceSync.js";
import logsRouter from "./routes/api/logs.js";
import queueRouter from "./routes/api/queue.js";
import statsRouter from "./routes/api/stats.js";
import errorHandler from "./middlewares/errorHandler.js";
import adminAuth, { loadAdminConfig } from "./middlewares/adminAuth.js";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";

// Обработка необработанных исключений
process.on("uncaughtException", (error) => {
  console.error("Необработанное исключение:", error?.code || error?.name || "error");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Необработанный промис:", reason?.code || reason?.name || "error");
  process.exit(1);
});

const require = createRequire(import.meta.url);
const { PROXY_PORT, SERVER_IP } = require("./config/proxy-config.cjs");
const ADMIN_PORT = Number.parseInt(process.env.ADMIN_PORT || "8776", 10);

// Fail-closed: без валидной конфигурации администратора сервер не стартует.
loadAdminConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const publicAdminApp = express();
const adminApp = express();
const adminServer = createServer(adminApp);

// Публичная панель сохраняет прежний доступ без авторизации; localhost-панель требует Basic Auth.
initWebSocketServer({ server, publicAccess: true }, { server: adminServer });

// Мидлвары (парсинг тела доступен публичному прокси-маршруту)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Публичный приём запросов и проверка здоровья сохраняют действующие webhook-маршруты.
app.all("/api/proxy", handleProxyRequest);
app.post("/api/queue/proxy", handleProxyRequest);
app.get("/healthz", async (req, res) => {
  try {
    await checkDatabase();
    res.status(200).json({ status: "ok", db: "up" });
  } catch {
    res.status(503).json({ status: "error", db: "down" });
  }
});

// Swagger
const swaggerOptions = {
  swaggerDefinition: {
    openapi: "3.1.1",
    info: {
      title: "B24 QProxy API",
      version: "2.1.0",
    },
  },
  apis: ["./routes/api/*.js"],
};
const swaggerSpec = swaggerJsdoc(swaggerOptions);

function configureAdminApp(application, authenticated) {
  if (authenticated) application.use(adminAuth);
  application.use(express.static(path.join(__dirname, "dist")));
  application.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  application.use("/api/logs", logsRouter);
  application.use("/api/queue", queueRouter);
  application.use("/api/stats", statsRouter);
  application.use(errorHandler);
  application.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "dist", "index.html"));
  });
}

configureAdminApp(publicAdminApp, false);
configureAdminApp(adminApp, true);

// На публичном порту сохраняем прежнюю неавторизованную админку после webhook-маршрутов.
app.use(publicAdminApp);
app.use(errorHandler);

// Проверка БД и маркировка прерванных запросов перед приёмом трафика
async function start() {
  try {
    await checkDatabase();
  } catch (error) {
    console.error("Не удалось подключиться к БД при старте:", error?.code || error?.name || "error");
    process.exit(1);
  }

  try {
    const updated = await markInterrupted(INSTANCE_REF);
    if (updated > 0) {
      console.log(`Помечено прерванных запросов: ${updated} (source_ref=${INSTANCE_REF})`);
    }
  } catch (error) {
    console.error("Не удалось пометить прерванные запросы:", error?.code || error?.name || "error");
    process.exit(1);
  }

  // Регулярная фоновая синхронизация счетов из Bitrix24 (за сегодня и вчера)
  const SYNC_INTERVAL_MS = Number.parseInt(process.env.INVOICE_SYNC_INTERVAL_MS || String(10 * 60 * 1000), 10);
  let invoiceSyncRunning = false;
  const runPeriodicSync = async () => {
    if (invoiceSyncRunning) return;
    invoiceSyncRunning = true;
    try {
      const res = await syncRecentInvoices({ days: 2 });
      if (res.updated > 0 || res.inserted > 0) {
        console.log(`[InvoiceSync] Синхронизировано: ${res.updated} обновлено, ${res.inserted} добавлено`);
      }
    } catch (error) {
      console.error("[InvoiceSync] Ошибка фоновой синхронизации:", error?.code || error?.name || error?.message || "error");
    } finally {
      invoiceSyncRunning = false;
    }
  };
  const invoiceSyncTimer = setInterval(runPeriodicSync, SYNC_INTERVAL_MS);
  invoiceSyncTimer.unref();
  void runPeriodicSync();

  server.listen(PROXY_PORT, SERVER_IP, () => {
    console.log(`Публичный PROXY запущен: ${SERVER_IP}:${PROXY_PORT}`);
  });
  adminServer.listen(ADMIN_PORT, "0.0.0.0", () => {
    console.log(`Административный порт запущен: ${ADMIN_PORT}`);
  });
}

start();

// Управляемое завершение: закрываем сервер и пул БД
function shutdown(signal) {
  console.log(`Получен сигнал ${signal}, завершение...`);
  server.close(() => {
    adminServer.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
