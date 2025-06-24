![Node.js](https://img.shields.io/badge/Node.js-v18+-green) ![Express](https://img.shields.io/badge/Express-v4.x-blue) ![Swagger](https://img.shields.io/badge/Swagger-OpenAPI-85EA2D) ![License](https://img.shields.io/badge/License-MIT-yellow)

# B24 Proxy

Прокси-сервер для обработки и маршрутизации запросов с интеграцией в Bitrix24. Управляет очередью, логированием и защитой от перегрузки API.

---

## 🚀 Быстрый старт

```bash
# Клонируйте репозиторий
 git clone https://github.com/yourusername/b24-queue-proxy.git
 cd b24-queue-proxy

# Установите зависимости
npm install

# Запустите сервер в режиме разработки
npm run dev

# Для продакшена
npm start
```

---

## ⚙️ Конфигурация

Все параметры сервера настраиваются через файл `config/proxy-config.cjs`.

Пример ключевых параметров:

```js
module.exports = {
  SERVER_IP: "127.0.0.1",
  PROXY_PORT: 3000,
  TARGET_BASE_URL: "https://script.google.com/macros/s/xxxxxxxxxxxxxxxxxxxxxxx/exec",
  TARGET_BASE_URL_INVOICE: "https://script.google.com/macros/s/xxxxxxxxxxxxxxxxxxxxxxx/exec",
  REQUEST_TIMEOUT: 360000,
  MAX_RETRIES: 3,
  MAX_CONCURRENCY: 1,
};
```

Для настройки прокси во фронтенде используйте файл `vite.config.js`:

```js
server: {
  proxy: {
    "/api": {
      target: "http://localhost:3000",
      changeOrigin: true,
      ws: true,
    },
  },
},
```

---

## 📚 Основные возможности

- Очередь запросов с ограничением скорости (p-queue)
- Автоматические повторы при ошибках
- Подробное логирование (winston)
- Веб-интерфейс для логов (`/logs`)
- Документация API через Swagger UI (`/api-docs`)
- Гибкая конфигурация через файлы конфигурации
- Мониторинг очереди и статистики

---

## 🛠 Архитектура

```
┌─────────────┐    ┌────────────────┐    ┌─────────────────┐
│  Bitrix24   │───▶│  Прокси-сервер │───▶│  Целевое API    │
└─────────────┘    └────────────────┘    └─────────────────┘
                        │
                        ▼
                ┌───────────────┐
                │  Очередь     │
                │  (p-queue)   │
                └───────────────┘
                        │
                        ▼
                ┌───────────────┐
                │  Логирование  │
                │  (winston)    │
                └───────────────┘
```

---

## 📚 API Документация

Swagger UI: [http://localhost:3000/api-docs](http://localhost:3000/api-docs)

### Примеры эндпоинтов

- **Добавить запрос в очередь**
  ```http
  POST /proxy?DealID=123&param1=value1
  ```
- **Статистика очереди**
  ```http
  GET /api/queue
  ```
- **Просмотр логов**
  ```http
  GET /api/logs
  ```

---

## 🏁 Запуск

```bash
npm install
npm run dev
```

- Сервер: http://localhost:3000
- Фронтенд: http://localhost:5173

---

## 📄 Лицензия

MIT

---

**Автор:** Asharapov Kirill  
**Версия:** 1.0.0  
**Дата:** 2025-06-05
