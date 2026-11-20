/**
 * Общий обработчик входных прокси-запросов.
 *
 * Один и тот же async handleProxyRequest используется и для app.all('/api/proxy'),
 * и для POST /api/queue/proxy. Приём запроса сначала долговечно фиксируется в
 * PostgreSQL (createRequest атомарно создаёт событие queued), задача ставится в очередь,
 * после чего сразу возвращается 200; выполнение расчёта не ожидается.
 * Ошибка БД до подтверждения приводит к 503 без внешней отправки.
 *
 * Отправка в Apps Script выполняется воркером через единую очередь requestQueue
 * из queueService: 3 попытки, таймаут, состояние succeeded только при реальном
 * ответе {status:'success'}, failed после исчерпания лимита. События пишутся
 * через appendEvent; сбой записи после подтверждения повторяется ограниченно и виден в
 * санированном stderr, но не отменяет внешний вызов.
 */
import crypto from "crypto";
import { createRequire } from "module";
import axios from "axios";

import { requestQueue } from "./queueService.js";
import { createRequest, appendEvent } from "./requestStore.js";
import { collectRequestParams } from "./requestParams.js";

const require = createRequire(import.meta.url);
const {
  TARGET_BASE_URL,
  TARGET_BASE_URL_INVOICE,
  MAX_RETRIES,
  REQUEST_TIMEOUT,
} = require("../config/proxy-config.cjs");

/** Задержки перед повторными попытками внешнего вызова (мс). */
const RETRY_DELAYS_MS = [1000, 3000, 5000];

/** Ограниченные повторы записи события после подтверждения при сбое appendEvent. */
const EVENT_WRITE_ATTEMPTS = 3;
/** Базовая задержка между повторами записи события (мс). */
const EVENT_WRITE_DELAY_MS = 300;

/** Идентификатор инстанса для markInterrupted; по умолчанию статический 'invoice'. */
export const INSTANCE_REF = process.env.PROXY_INSTANCE || "invoice";

/**
 * Пауза.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Приводит параметр к непустой строке или null.
 * @param {*} value
 * @returns {string|null}
 */
function toId(value) {
  if (Array.isArray(value)) value = value[0];
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length ? text : null;
}

/**
 * Краткая санированная строка причины для stderr (без query/body/токенов).
 * @param {*} error
 * @returns {string}
 */
function safeReason(error) {
  if (!error) return "неизвестная ошибка";
  return String(error.code || error.name || "ошибка").slice(0, 80);
}

/**
 * Ограниченно повторяет запись события после подтверждения. Не бросает: сбой только
 * сигнализируется в санированный stderr, внешний вызов при этом продолжается.
 * @param {string} kind
 * @param {string} legacyId
 * @param {object} event
 * @param {string} state
 * @returns {Promise<boolean>} успешность записи
 */
async function appendEventWithRetry(kind, legacyId, event, state) {
  for (let attempt = 1; attempt <= EVENT_WRITE_ATTEMPTS; attempt++) {
    try {
      await appendEvent({ kind, legacyId, event, state });
      return true;
    } catch (error) {
      const last = attempt === EVENT_WRITE_ATTEMPTS;
      console.error(
        `proxy: не удалось записать событие (kind=${kind}, state=${state}, попытка ${attempt}/${EVENT_WRITE_ATTEMPTS}): ${safeReason(error)}`
      );
      if (!last) await delay(EVENT_WRITE_DELAY_MS);
    }
  }
  return false;
}

/**
 * Извлекает безопасное сообщение об ошибке из ответа/исключения axios.
 * @param {*} err
 * @returns {string}
 */
function describeError(err) {
  if (err?.response) {
    const text =
      typeof err.response.data === "string"
        ? err.response.data.slice(0, 200)
        : JSON.stringify(err.response.data);
    return `HTTP ${err.response.status}: ${text || err.message}`;
  }
  if (err?.code) return `${err.code}: ${err.message}`;
  return err?.message || "Неизвестная ошибка";
}

/**
 * Один внешний вызов Apps Script с таймаутом и без метания исключения.
 * @param {string} url
 * @returns {Promise<{ok: boolean, status?: number, data?: *, error?: *}>}
 */
async function sendOnce(url) {
  const source = axios.CancelToken.source();
  const timer = setTimeout(() => source.cancel(`Timeout after ${REQUEST_TIMEOUT}ms`), REQUEST_TIMEOUT);
  try {
    const response = await axios.post(url, {}, { cancelToken: source.token, validateStatus: () => true });
    return { ok: true, status: response.status, data: response.data };
  } catch (error) {
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Воркер отправки в Apps Script: 3 попытки, таймаут, запись событий через appendEvent.
 * Состояние succeeded ставится только при реальном {status:'success'}, failed — после лимита.
 * @param {object} ctx - { kind, legacyId, targetUrl }
 * @returns {Promise<void>}
 */
async function runWorker({ kind, legacyId, targetUrl }) {
  await appendEventWithRetry(kind, legacyId, { type: "processing", message: "Запрос взят в работу" }, "processing");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      const delayMs = RETRY_DELAYS_MS[attempt - 2] || 3000;
      await appendEventWithRetry(
        kind,
        legacyId,
        { type: "info", message: `Ожидание перед повторной попыткой №${attempt}: ${delayMs / 1000}с` },
        "processing"
      );
      await delay(delayMs);
    }

    await appendEventWithRetry(kind, legacyId, { type: "request", message: `Отправка №${attempt}`, attempt }, "processing");

    const result = await sendOnce(targetUrl);

    if (!result.ok) {
      await appendEventWithRetry(
        kind,
        legacyId,
        { type: "error", message: `Ошибка: ${describeError(result.error)}`, attempt },
        "processing"
      );
      continue;
    }

    const { status, data } = result;

    if (status === 200 && typeof data === "string" && data.includes("<!DOCTYPE html>")) {
      await appendEventWithRetry(
        kind,
        legacyId,
        { type: "error", message: "Google Apps Script вернул HTML-ответ (блокировка/лимит)", status, attempt },
        "processing"
      );
      continue;
    }

    if (status === 200 && data && data.status === "success") {
      await appendEventWithRetry(
        kind,
        legacyId,
        { type: "response", message: `Успешный ответ | Статус: ${status}`, status, attempt, payload: data },
        "succeeded"
      );
      return;
    }

    if (status === 200) {
      const errMessage = data?.errors?.[0]?.message || data?.message || data?.status || "Ошибка выполнения в Apps Script";
      await appendEventWithRetry(
        kind,
        legacyId,
        { type: "error", message: `Ошибка в таблице: ${errMessage}`, status, attempt, payload: data },
        "processing"
      );
      continue;
    }

    await appendEventWithRetry(
      kind,
      legacyId,
      { type: "warn", message: `Неуспешный HTTP статус: ${status}`, status, attempt },
      "processing"
    );
  }

  await appendEventWithRetry(
    kind,
    legacyId,
    { type: "error", message: "Лимит попыток исчерпан" },
    "failed"
  );
}

/**
 * Общий async-обработчик входного прокси-запроса.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
export async function handleProxyRequest(req, res) {
  const query = req.query || {};
  const dealId = toId(query.DealID) || toId(query.DEAL_ID);
  const s5 = toId(query.s5);
  const workflow = toId(query.Workflow);

  const kind = s5 ? "invoice" : "deal";
  const baseUrl = s5 ? TARGET_BASE_URL_INVOICE : TARGET_BASE_URL;

  const target = new URL(baseUrl);
  target.search = new URLSearchParams(query).toString();
  const targetUrl = target.href;

  const legacyId = crypto.randomUUID();
  const httpMethod = req.method || "GET";

  try {
    await createRequest({
      kind,
      legacyId,
      dealId,
      invoiceId: s5,
      workflow,
      httpMethod,
      requestParams: collectRequestParams(req),
      queuedMessage:
        kind === "invoice"
          ? `Запрос добавлен в очередь: Счет (ID: ${s5})`
          : `Запрос добавлен в очередь: Сделка (ID: ${dealId || "N/A"})`,
      sourceRef: INSTANCE_REF,
    });

  } catch (error) {
    console.error(`proxy: отказ приёма ${kind} ${legacyId}: ${safeReason(error)}`);
    res.status(503).json({
      success: false,
      message: "Хранилище запросов недоступно, запрос не принят.",
    });
    return;
  }

  const queueSize = requestQueue.size;
  const queuePosition = queueSize;

  const task = requestQueue.add(() => runWorker({ kind, legacyId, targetUrl }));
  task.catch((error) => {
    console.error(`proxy: ошибка воркера ${kind} ${legacyId}: ${safeReason(error)}`);
  });

  res.status(200).json({
    success: true,
    message: "Запрос принят и сохранён.",
    logId: legacyId,
    requestId: legacyId,
    dealId,
    s5,
    queueSize,
    queuePosition,
    target: kind,
  });
}

export default handleProxyRequest;
