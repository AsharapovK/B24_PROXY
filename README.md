![Node.js](https://img.shields.io/badge/Node.js-v18+-green) ![Express](https://img.shields.io/badge/Express-v4.x-blue) ![Swagger](https://img.shields.io/badge/Swagger-OpenAPI-85EA2D) ![License](https://img.shields.io/badge/License-MIT-yellow)

# B24 Proxy

Прокси-сервер для обработки и маршрутизации запросов с интеграцией в Bitrix24. Управляет очередью, логированием и защитой от перегрузки API.

---

## 🚀 Быстрый старт

### 1. Установка Node.js

Убедитесь, что у вас установлен Node.js версии 18 или выше. Если нет, скачайте и установите с [официального сайта](https://nodejs.org/).

Проверка версии:
```bash
node -v
# Должно быть v18.x.x или выше
```

### 2. Клонирование и настройка

```bash
# Клонируйте репозиторий
git clone https://github.com/AsharapovK/B24_PROXY.git
cd B24_PROXY

# Установите зависимости
npm install
```

### 3. Настройка конфигурации

Откройте и отредактируйте файл конфигурации `config/proxy-config.cjs`:

```bash
nano config/proxy-config.cjs
```

Основные настройки для изменения:
- `TARGET_BASE_URL` - основной URL для проксирования запросов
- `TARGET_BASE_URL_INVOICE` - URL для проксирования запросов к счетам
- `MAX_CONCURRENCY` - максимальное количество одновременных запросов (по умолчанию: 1)
- `PROXY_PORT` - порт, на котором будет работать сервер (по умолчанию: 7777)

### 4. Запуск

#### Для разработки:
Запуск сервера разработки с горячей перезагрузкой:
```bash
npm run dev
```

#### Для продакшена:
1. Соберите фронтенд:
```bash
npm run build
```

2. Запустите продакшен-сервер:
```bash
npm start
```

#### Структура после сборки:
- Фронтенд будет собран в директорию `dist/`
- Статические файлы можно развернуть на любом веб-сервере (Nginx, Apache, etc.)
- API будет доступно по адресу: http://127.0.0.1:7777
- Собранный фронтенд будет доступен по адресу: http://127.0.0.1:7777

---

## ⚙️ Конфигурация

Все параметры сервера настраиваются через файл `config/proxy-config.cjs`.

Пример ключевых параметров:

```js
module.exports = {
  SERVER_IP: "127.0.0.1",
  PROXY_PORT: 7777,
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
      target: "http://127.0.0.1:7777",
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

Swagger UI: [http://127.0.0.1:7777/api-docs](http://127.0.0.1:7777/api-docs)

### Примеры эндпоинтов

- **Добавить запрос в очередь**
  ```http
  POST /proxy?DealID=123&param1=value1
  ```
- **Проверить статус по dealId**
  ```http
  GET /api/queue/position?dealId=DEAL123
  ```
- **Проверить статус по invoiceId**
  ```http
  GET /api/queue/position?invoiceId=INV123
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

- Бэкенд (API): http://127.0.0.1:7777
- Фронтенд (в разработке): http://127.0.0.1:5173
- Фронтенд (продакшен): http://127.0.0.1:7777

---

## 🌐 Деплой

### Настройка Nginx для продакшена

Пример конфигурации Nginx для развертывания:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Отдача статики
    location / {
        root /path/to/B24_PROXY/dist;
        try_files $uri /index.html;
    }

    # Проксирование API-запросов
    location /api {
        proxy_pass http://127.0.0.1:7777;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Настройка PM2 для продакшена

Установите PM2 глобально:
```bash
npm install -g pm2
```

Запустите сервер через PM2:
```bash
pm2 start index.js --name "b24-proxy"

# Добавьте автозапуск при загрузке системы
pm2 startup
pm2 save
```

## 📄 Лицензия

MIT

---

**Автор:** Asharapov Kirill  
**Версия:** 3.2.1  
**Дата:** 2025-07-24
