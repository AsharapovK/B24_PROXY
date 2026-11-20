/**
 * HTTP Basic Auth для административного интерфейса на localhost-only порту.
 *
 * Защищает SPA/static, /api/logs, /api/queue (кроме публичного POST /proxy),
 * /api/stats и /api-docs. Публичными остаются /healthz, /api/proxy и
 * POST /api/queue/proxy.
 *
 * Публичный listener отдельно сохраняет прежний неавторизованный доступ к SPA/API.
 * Конфигурация (переменные окружения):
 *   ADMIN_USER — имя пользователя администратора.
 *   ADMIN_PASSWORD_FILE — путь к файлу с паролем (читается один раз, не логируется).
 *
 * Безопасность:
 *   - Fail-closed: если конфигурация отсутствует/некорректна, процесс завершается.
 *   - Пароль никогда не попадает в логи и текст ошибок (только факт/код).
 *   - Сравнение пароля — timingSafeEqual, длина хедеров уравнивается.
 *   - При неудаче — 401 с WWW-Authenticate, без раскрытия учётных данных.
 */
import crypto from "crypto";
import fs from "fs";

/** Кэш прочитанной конфигурации администратора. */
let adminUser = null;
let adminPasswordBuffer = null;
let configLoaded = false;
const WS_COOKIE_NAME = "b24_proxy_ws";
const WS_SESSION_TTL_SECONDS = 8 * 60 * 60;

/**
 * Читает пароль из ADMIN_PASSWORD_FILE. Файл читается один раз; значение не
 * логируется и не попадает в текст ошибок.
 * @returns {string}
 */
function readAdminPasswordFile() {
  const file = process.env.ADMIN_PASSWORD_FILE;
  if (!file) {
    throw new Error("ADMIN_PASSWORD_FILE не задан");
  }
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // Не раскрываем путь/содержимое файла — только факт ошибки чтения.
    throw new Error("ADMIN_PASSWORD_FILE недоступен для чтения");
  }
  return raw.replace(/\r?\n$/, "");
}

/**
 * Загружает и валидирует конфигурацию администратора (fail-closed).
 * Вызывается на старте приложения; завершает процесс при любой проблеме.
 * @returns {{ user: string }}
 */
export function loadAdminConfig() {
  let user = process.env.ADMIN_USER;
  if (process.env.ADMIN_USER_FILE) {
    try {
      user = fs.readFileSync(process.env.ADMIN_USER_FILE, "utf8").replace(/\r?\n$/, "");
    } catch {
      user = "";
    }
  }
  if (!user) {
    console.error("adminAuth: ADMIN_USER не задан — запуск остановлен");
    process.exit(1);
  }

  let password;
  try {
    password = readAdminPasswordFile();
  } catch (error) {
    console.error(`adminAuth: ${error?.message || "конфигурация недоступна"} — запуск остановлен`);
    process.exit(1);
  }

  if (!password) {
    console.error("adminAuth: ADMIN_PASSWORD_FILE пуст — запуск остановлен");
    process.exit(1);
  }

  adminUser = user;
  adminPasswordBuffer = Buffer.from(password, "utf8");
  configLoaded = true;
  return { user };
}

/**
 * Побайтовое сравнение двух строк постоянного времени.
 * Длины уравниваются, чтобы не раскрывать длину ожидаемого значения.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");
  const maxLen = Math.max(bufA.length, bufB.length, 1);
  const padA = Buffer.alloc(maxLen);
  const padB = Buffer.alloc(maxLen);
  bufA.copy(padA);
  bufB.copy(padB);
  return crypto.timingSafeEqual(padA, padB) && bufA.length === bufB.length;
}

/**
 * Разбор заголовка Authorization: Basic.
 * @param {string|undefined} header
 * @returns {{ user: string, pass: string }|null}
 */
function parseBasicAuth(header) {
  if (typeof header !== "string") return null;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  let decoded;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

/** Проверяет Basic Auth для HTTP Upgrade/WebSocket до Express middleware. */
export function isAdminAuthorized(header) {
  if (!configLoaded) return false;
  const credentials = parseBasicAuth(header);
  return (
    credentials !== null &&
    safeEqual(credentials.user, adminUser) &&
    safeEqual(credentials.pass, adminPasswordBuffer.toString("utf8"))
  );
}

function isValidWebSocketSession(cookieHeader) {
  if (!configLoaded || typeof cookieHeader !== "string") return false;
  const encoded = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${WS_COOKIE_NAME}=`))
    ?.slice(WS_COOKIE_NAME.length + 1);
  if (!encoded) return false;

  const separator = encoded.indexOf(".");
  if (separator < 1) return false;
  const expiresAt = encoded.slice(0, separator);
  const signature = encoded.slice(separator + 1);
  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) <= Math.floor(Date.now() / 1000)) return false;

  const expected = crypto
    .createHmac("sha256", adminPasswordBuffer)
    .update(`${adminUser}:${expiresAt}`)
    .digest("base64url");
  return safeEqual(signature, expected);
}

/** Проверяет браузерный WebSocket по Basic Auth или короткоживущему cookie. */
export function isAdminWebSocketAuthorized(authorizationHeader, cookieHeader) {
  return isAdminAuthorized(authorizationHeader) || isValidWebSocketSession(cookieHeader);
}

function issueWebSocketSessionCookie(req, res) {
  const expiresAt = Math.floor(Date.now() / 1000) + WS_SESSION_TTL_SECONDS;
  const signature = crypto
    .createHmac("sha256", adminPasswordBuffer)
    .update(`${adminUser}:${expiresAt}`)
    .digest("base64url");
  const secure = req.secure ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    `${WS_COOKIE_NAME}=${expiresAt}.${signature}; Path=/api/logs/ws; Max-Age=${WS_SESSION_TTL_SECONDS}; HttpOnly; SameSite=Strict${secure}`,
  );
}

/**
 * Express middleware HTTP Basic Auth.
 * На старте (fail-closed) конфигурация должна быть загружена через loadAdminConfig;
 * при отсутствии — middleware также пытается загрузить её самостоятельно.
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
export default function adminAuth(req, res, next) {
  if (!configLoaded) {
    // Защита от монтирования без инициализации: fail-closed на уровне запроса.
    try {
      loadAdminConfig();
    } catch {
      res.set("WWW-Authenticate", 'Basic realm="B24 QProxy Admin", charset="UTF-8"');
      return res.status(401).json({ success: false, error: "Требуется авторизация" });
    }
  }

  if (!isAdminAuthorized(req.headers.authorization)) {
    res.set("WWW-Authenticate", 'Basic realm="B24 QProxy Admin", charset="UTF-8"');
    return res.status(401).json({ success: false, error: "Требуется авторизация" });
  }

  issueWebSocketSessionCookie(req, res);
  return next();
}
