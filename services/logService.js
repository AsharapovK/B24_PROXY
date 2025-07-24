/**
 * Сервис логирования на основе winston.
 * Экспортирует стандартный winston-логгер для централизованного логирования.
 * Используйте logService.info/warn/error/debug для записи логов.
 */
import logger from "../config/logger.js";
import fs from "fs";
import path from "path";
import { getBroadcastLog } from "./websocketService.js";

const logPath = path.join(process.cwd(), "app.log");
// Убедимся, что файл логов существует
if (!fs.existsSync(logPath)) {
  fs.writeFileSync(logPath, "", 'utf8');
}

/**
 * Добавляет новую запись лога в app.log
 * @param {object} logData - Объект лога для записи
 */
export function addLogEntry(logData) {
  try {
    const logLine = JSON.stringify(logData) + '\n';
    fs.appendFileSync(logPath, logLine, 'utf8');
    
    const broadcast = getBroadcastLog();
    if (broadcast) {
      broadcast({ type: 'logs_updated' });
    }
  } catch (e) {
    logger.error('Ошибка добавления записи в лог:', { error: e.message, logData });
  }
}

/**
 * Обновляет существующую запись лога в app.log
 * @param {string} logId - ID записи лога для обновления
 * @param {object} newEvent - Новый объект события для добавления
 */
export function updateLogEntry(logId, newEvent) {
  try {
    const fileContent = fs.readFileSync(logPath, 'utf8');
    const lines = fileContent.split('\n').filter(line => line.trim() !== '');
    let logUpdated = false;

    const updatedLines = lines.map(line => {
      try {
        const logEntry = JSON.parse(line);
        if (logEntry.id === logId) {
          if (!logEntry.events) logEntry.events = [];
          logEntry.events.push(newEvent);
          logEntry.timestamp = newEvent.timestamp;
          logEntry.inProgress = newEvent.type !== 'response' && newEvent.type !== 'error';
          logUpdated = true;
          return JSON.stringify(logEntry);
        }
      } catch(e) {
        // Игнорируем строки, которые не являются валидным JSON
      }
      return line;
    });

    if (logUpdated) {
      fs.writeFileSync(logPath, updatedLines.join('\n') + '\n', 'utf8');
      const broadcast = getBroadcastLog();
      if (broadcast) {
        broadcast({ type: 'logs_updated' });
      }
    }
  } catch (e) {
    logger.error('Ошибка обновления записи в логе:', { error: e.message, logId });
  }
}

function formatDate(date = new Date()) {
  const pad = n => n.toString().padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Поиск записей в логах по dealId, invoiceId или id
 * @param {Object} params - Параметры поиска { dealId, invoiceId, id }
 * @returns {Array} - Массив найденных записей логов
 */
export function searchLogs({ dealId, invoiceId, id }) {
  try {
    if (!fs.existsSync(logPath)) {
      return [];
    }

    const fileContent = fs.readFileSync(logPath, 'utf8');
    const lines = fileContent.split('\n').filter(line => line.trim() !== '');
    const results = [];

    for (const line of lines) {
      try {
        const logEntry = JSON.parse(line);
        const matches = 
          (id && logEntry.id === id) ||
          (dealId && logEntry.dealId === dealId) ||
          (invoiceId && logEntry.invoceId === invoiceId);

        if (matches) {
          results.push(logEntry);
        }
      } catch (e) {
        console.error('Ошибка парсинга строки лога:', e);
      }
    }

    return results;
  } catch (e) {
    console.error('Ошибка при чтении логов:', e);
    return [];
  }
}

// In-memory Map для групп логов (только для grouped_request)
const logGroupsMap = new Map();

export default function logService(level, message, meta) {
  // Не логировать служебные сообщения для фронта
  if ((typeof message === 'object' && message.type === 'logs_updated') || (meta && meta.type === 'logs_updated')) return;

  // Если это grouped_request — обновляем/добавляем группу
  if (message === 'grouped_request' && meta && meta.id) {
    logGroupsMap.set(meta.id, { ...meta, timestamp: formatDate() });
    try {
      fs.writeFileSync(logPath, Array.from(logGroupsMap.values()).map(g => JSON.stringify(g)).join('\n'), 'utf8');
    } catch (e) {
      logger.log('error', 'Ошибка записи групп логов', { error: e.message });
    }
    if (getBroadcastLog()) {
      getBroadcastLog()({ message: 'grouped_request', ...meta });
    }
    return;
  }

  // Обычное логирование для всех остальных сообщений
  const logEntry = { level, message, ...meta, timestamp: formatDate() };
  logger.log(level, message, meta);
  if (getBroadcastLog()) {
    getBroadcastLog()(logEntry);
  }
} 