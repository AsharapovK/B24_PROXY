/**
 * Конфигурационный файл для прокси-сервера.
 * Содержит параметры запуска, целевые URL, таймауты, лимиты и настройки очереди.
 * Экспортирует объект с настройками.
 */
module.exports = {
  // IP и порт на котором запускается сервер
  SERVER_IP: process.env.SERVER_IP || "0.0.0.0",
  PROXY_PORT: 7776,

  // IP на который отправляются запросы из очереди
  TARGET_BASE_URL: "https://script.google.com/macros/s/AKfycbzREFeMVNKCXAhMSwgvZscYmmCP5K68INsaZMzNR4SXhcJRDXPV_kp4QHe51pvQcOfrcg/exec",
  TARGET_BASE_URL_INVOICE: "https://script.google.com/macros/s/AKfycbzREFeMVNKCXAhMSwgvZscYmmCP5K68INsaZMzNR4SXhcJRDXPV_kp4QHe51pvQcOfrcg/exec",

  // Таймаут запроса
  REQUEST_TIMEOUT: 360000,

  // Максимальное количество попыток запроса
  MAX_RETRIES: 3,

  // Максимальное количество запросов в очереди
  MAX_CONCURRENCY: 1,
};
