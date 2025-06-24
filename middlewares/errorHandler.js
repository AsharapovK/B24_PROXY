/**
 * Централизованный middleware для обработки ошибок Express.
 * Логирует ошибку и возвращает корректный JSON-ответ клиенту.
 * Использует logService для записи ошибок.
 */
import logService from "../services/logService.js";

const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  // Всегда подробный вывод (dev-режим)
  const isProduction = false;

  logService('error', "Ошибка:", {
    error: err.message,
    stack: isProduction ? undefined : err.stack,
    path: req.path,
    method: req.method,
    params: req.params,
    query: req.query,
    body: req.body,
  });

  res.status(statusCode).json({
    success: false,
    message: isProduction && statusCode === 500 ? "Внутренняя ошибка сервера" : err.message,
    ...(!isProduction && { stack: err.stack }),
  });
};

export default errorHandler; 