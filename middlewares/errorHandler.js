/**
 * Централизованный middleware для обработки ошибок Express.
 * Не использует файловый logService и не пишет query/body/stack ни в ответ,
 * ни в stdout: внешние ошибки 500 отдаются обобщённо, без раскрытия секретов.
 */

const errorHandler = (err, req, res, next) => {
  void next;
  const statusCode = err && err.statusCode ? err.statusCode : 500;

  // Санированный сигнал в stderr без query/body/stack.
  const reason = String(err?.code || err?.name || "error").slice(0, 80);
  console.error(`error: ${statusCode} на ${req.method} ${req.path}: ${reason}`);

  // 500 — обобщённое сообщение; иные — сообщение ошибки без деталей запроса.
  const message = statusCode >= 500 ? "Внутренняя ошибка сервера" : "Ошибка запроса";

  res.status(statusCode).json({
    success: false,
    message,
  });
};

export default errorHandler;
