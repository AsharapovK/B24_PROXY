/**
 * Конфигурационный файл для прокси-сервера.
 * Содержит параметры запуска, целевые URL, таймауты, лимиты и настройки очереди.
 * Экспортирует объект с настройками.
 */
module.exports = {
  // IP и порт на котором запускается сервер
  SERVER_IP: "127.0.0.1",
  PROXY_PORT: 7777,

  // IP на который отправляются запросы из очереди
  TARGET_BASE_URL: "https://script.google.com/macros/s/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/exec",
  TARGET_BASE_URL_INVOICE: "https://script.google.com/macros/s/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/exec",

  // Таймаут запроса
  REQUEST_TIMEOUT: 36000,

  // Максимальное количество попыток запроса
  MAX_RETRIES: 3,

  // Максимальное количество запросов в очереди
  MAX_CONCURRENCY: 1,
};
