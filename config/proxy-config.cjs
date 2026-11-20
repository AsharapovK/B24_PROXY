/**
 * Конфигурационный файл для прокси-сервера.
 * Содержит параметры запуска, целевые URL, таймауты, лимиты и настройки очереди.
 * Экспортирует объект с настройками.
 */
const fs = require("node:fs");

function readHttpsEndpoint(file) {
  let value;
  try {
    value = fs.readFileSync(file, "utf8").trim();
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("invalid scheme");
  } catch {
    throw new Error("Required HTTPS endpoint configuration is unavailable");
  }
  return value;
}

module.exports = {
  // IP и порт на котором запускается сервер
  SERVER_IP: process.env.SERVER_IP || "0.0.0.0",
  PROXY_PORT: 7776,

  // IP на который отправляются запросы из очереди
  TARGET_BASE_URL: readHttpsEndpoint(process.env.TARGET_BASE_URL_FILE || "/run/secrets/target_base_url"),
  TARGET_BASE_URL_INVOICE: readHttpsEndpoint(process.env.TARGET_BASE_URL_INVOICE_FILE || "/run/secrets/target_base_url_invoice"),

  // Таймаут запроса
  REQUEST_TIMEOUT: 360000,

  // Максимальное количество попыток запроса
  MAX_RETRIES: 3,

  // Максимальное количество запросов в очереди
  MAX_CONCURRENCY: 1,
};
