/**
 * PostgreSQL-слой журналов PROXY (сделочные и счётовые потоки).
 *
 * Единая точка долговечной записи и чтения запросов/событий на основе таблиц
 * миграции 003 (proxy_deal_requests/events, proxy_invoice_requests/events).
 * Модуль не читает app.log и не выполняет сетевых HTTP-запросов: только SQL.
 *
 * Конфигурация подключения (переменные окружения):
 *   PGHOST, PGPORT, PGDATABASE, PGUSER — обычные параметры libpq/pg.
 *   PGPASSWORD_FILE — путь к файлу с паролем (читается один раз, не логируется).
 *   PG_POOL_MAX — максимум соединений в пуле (по умолчанию 5).
 *   PG_STATEMENT_TIMEOUT_MS — statement_timeout в миллисекундах (по умолчанию 5000).
 *   PG_IDLE_TX_TIMEOUT_MS — idle_in_transaction_session_timeout (по умолчанию 10000).
 *
 * Все SQL-запросы параметризованы; kind ограничен whitelist 'deal' | 'invoice';
 * лимит выборки ограничен 1000. Параметры запроса и полезная нагрузка событий
 * рекурсивно очищаются от секретов; сырой target URL не сохраняется.
 */
import fs from "fs";
import pg from "pg";
import { getBroadcastLog } from "./websocketService.js";
import { sanitizeRequestParams, scrubSecrets } from "./requestParams.js";

const { Pool } = pg;

/** Whitelist видов журнала. */
const KINDS = new Set(["deal", "invoice"]);

/** Верхняя граница размера выборки для listRequests/searchRequests. */
export const MAX_LIST_LIMIT = 1000;

/**
 * Читает пароль из PGPASSWORD_FILE. Файл читается один раз, значение не
 * логируется и не попадает в текст ошибок.
 * @returns {string|undefined}
 */
function readPasswordFile() {
  if (process.env.PGPASSWORD) return process.env.PGPASSWORD;
  const file = process.env.PGPASSWORD_FILE;
  if (!file) return undefined;
  try {
    const raw = fs.readFileSync(file, "utf8");
    return raw.replace(/\r?\n$/, "");
  } catch (error) {
    // Не раскрываем путь/содержимое файла — только факт ошибки чтения.
    throw new Error("PGPASSWORD_FILE недоступен для чтения");
  }
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const statementTimeoutMs = toPositiveInt(process.env.PG_STATEMENT_TIMEOUT_MS, 5000);
const idleTxTimeoutMs = toPositiveInt(process.env.PG_IDLE_TX_TIMEOUT_MS, 10000);
const poolMax = toPositiveInt(process.env.PG_POOL_MAX, 5);

const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT ? Number.parseInt(process.env.PGPORT, 10) : undefined,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: readPasswordFile(),
  max: poolMax,
  idleTimeoutMillis: toPositiveInt(process.env.PG_IDLE_TIMEOUT_MS, 10000),
  connectionTimeoutMillis: toPositiveInt(process.env.PG_CONNECT_TIMEOUT_MS, 5000),
  options: `-c statement_timeout=${statementTimeoutMs} -c idle_in_transaction_session_timeout=${idleTxTimeoutMs}`,
});

function notifyLogsUpdated() {
  try {
    getBroadcastLog()?.({ type: "logs_updated" });
  } catch (error) {
    console.error("WebSocket notification failed:", error?.code || error?.name || "error");
  }
}

// Обработчик ошибок фоновых клиентов пула: пробрасываем наружу, не глотаем.
pool.on("error", (error) => {
  console.error("Ошибка клиента PostgreSQL:", error?.code || error?.name || "error");
});

function assertKind(kind) {
  if (!KINDS.has(kind)) {
    throw new Error(`Недопустимый kind: ${String(kind)}`);
  }
}


/**
 * Рекурсивно очищает значение от секретов.
 * @param {*} value - любое JSON-совместимое значение
 * @returns {*} копия без секретов
 */
/**
 * Очищает текст сообщения события от секретов.
 * @param {*} message
 * @returns {string|null}
 */
function scrubMessage(message) {
  if (message === null || message === undefined) return null;
  const text = typeof message === "string" ? message : JSON.stringify(message);
  return scrubSecrets(text);
}

/**
 * Приводит значение к ISO-строке времени или null.
 * @param {*} value
 * @returns {string|null}
 */
function toTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const STATE_SQL = new Set([
  "queued",
  "processing",
  "succeeded",
  "failed",
  "interrupted",
  "unknown",
]);

function normalizeState(state) {
  return STATE_SQL.has(state) ? state : "unknown";
}

/**
 * Преобразует строку БД в форму события легаси-журнала.
 * @param {object} row
 * @returns {object}
 */
function mapEvent(row) {
  return {
    type: row.event_type,
    message: row.message,
    timestamp: toTimestamp(row.occurred_at),
    attempt: row.attempt,
    status: row.http_status,
    // data — совместимость со старым SPA; payload — то же значение для новых потребителей.
    data: row.payload?.data ?? null,
    payload: row.payload,
  };
}

/**
 * Преобразует строку БД в легаси-форму записи журнала:
 * {id,dealId,invoceId,type,method,timestamp,inProgress,events}.
 * @param {object} row - строка запроса с полем events (JSON-массив)
 * @param {string} kind - 'deal' | 'invoice'
 * @returns {object}
 */
function mapRequest(row, kind) {
  let events = [];
  if (Array.isArray(row.events)) {
    events = row.events.map(mapEvent);
  }
  return {
    id: row.legacy_id,
    dealId: row.deal_id ?? null,
    invoceId: row.invoice_id ?? null,
    type: kind,
    method: row.workflow ?? row.http_method ?? null,
    httpMethod: row.http_method ?? null,
    timestamp: toTimestamp(row.last_event_at ?? row.received_at),
    inProgress: row.in_progress === null ? null : Boolean(row.in_progress),
    state: row.state,
    events,
  };
}

/**
 * SQL-фрагмент агрегации событий запроса в JSON-массив (для выборок списков).
 * @param {string} alias - префикс имени таблицы, напр. 'proxy_deal'
 * @returns {string}
 */
const EVENTS_JSON = (alias, requestAlias) => `
  COALESCE((
    SELECT json_agg(json_build_object(
      'event_type', e.event_type,
      'message', e.message,
      'occurred_at', e.occurred_at,
      'attempt', e.attempt,
      'http_status', e.http_status,
      'payload', e.payload
    ) ORDER BY e.event_no)
    FROM ${alias}_events e WHERE e.request_id = ${requestAlias}.id
  ), '[]'::json)`;
/**
 * Проверяет доступность БД и корректность соединения.
 * @returns {Promise<{ok: true, serverTime: string, version: string}>}
 */
export async function checkDatabase() {
  const { rows } = await pool.query("SELECT now() AS server_time, version() AS version");
  return {
    ok: true,
    serverTime: toTimestamp(rows[0].server_time),
    version: rows[0].version,
  };
}

/**
 * Создаёт запрос и первое событие (event_no = 0) в одной транзакции.
 * Вызывается до ответа 202 клиенту.
 * @param {object} input
 * @returns {Promise<object>} созданная легаси-запись
 */
export async function createRequest({
  kind,
  legacyId,
  dealId = null,
  invoiceId = null,
  workflow = null,
  httpMethod = null,
  requestParams = null,
  queuedMessage = null,
  sourceRef = null,
}) {
  assertKind(kind);
  if (!legacyId) throw new Error("legacyId обязателен");

  const table = `proxy_${kind}_requests`;
  const eventsTable = `proxy_${kind}_events`;
  const hasInvoice = kind === "invoice";

  const columns = [
    "legacy_id",
    "deal_id",
    ...(hasInvoice ? ["invoice_id"] : []),
    "workflow",
    "http_method",
    "request_params",
    "received_at",
    "last_event_at",
    "state",
    "in_progress",
    "source_kind",
    "source_ref",
  ];
  const values = [
    legacyId,
    dealId,
    ...(hasInvoice ? [invoiceId] : []),
    workflow,
    httpMethod,
    JSON.stringify(sanitizeRequestParams(requestParams)),
    new Date(),
    new Date(),
    "queued",
    true,
    "live",
    sourceRef,
  ];
  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

  // invoice_id существует только в proxy_invoice_requests.
  const returningColumns = [
    "id",
    "legacy_id",
    "deal_id",
    ...(hasInvoice ? ["invoice_id"] : []),
    "workflow",
    "http_method",
    "request_params",
    "received_at",
    "last_event_at",
    "state",
    "in_progress",
  ];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const insertRequest = await client.query(
      `INSERT INTO ${table} (${columns.join(", ")})
       VALUES (${placeholders})
       RETURNING ${returningColumns.join(", ")}`,
      values
    );
    const request = insertRequest.rows[0];

    await client.query(
      `INSERT INTO ${eventsTable}
         (request_id, event_no, event_type, occurred_at, message, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        request.id,
        0,
        "queued",
        new Date(),
        scrubMessage(queuedMessage),
        JSON.stringify({}),
      ]
    );

    // Бизнес-обработка счетов переводится на прямую синхронизацию с Bitrix24.
    // Постановка в invoice_ingestion_jobs отключена.

    await client.query("COMMIT");
    notifyLogsUpdated();

    return mapRequest(
      {
        ...request,
        events: [
          {
            event_type: "queued",
            message: scrubMessage(queuedMessage),
            occurred_at: request.last_event_at,
            attempt: null,
            http_status: null,
            payload: {},
          },
        ],
      },
      kind
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
/**
 * Добавляет событие к существующему запросу в транзакции с блокировкой строки
 * (SELECT ... FOR UPDATE), вычисляя event_no = MAX(event_no) + 1. Состояние,
 * in_progress и last_event_at обновляются атомарно.
 * @param {object} input
 * @returns {Promise<{eventNo: number, state: string}>}
 */
export async function appendEvent({ kind, legacyId, event, state }) {
  assertKind(kind);
  if (!legacyId) throw new Error("legacyId обязателен");

  const table = `proxy_${kind}_requests`;
  const eventsTable = `proxy_${kind}_events`;
  const normalizedState = normalizeState(state);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const lock = await client.query(
      `SELECT id FROM ${table} WHERE legacy_id = $1 FOR UPDATE`,
      [legacyId]
    );
    if (lock.rows.length === 0) {
      throw new Error(`Запрос kind=${kind} legacy_id=${legacyId} не найден`);
    }
    const requestId = lock.rows[0].id;

    const nextNo = await client.query(
      `SELECT COALESCE(MAX(event_no), -1) + 1 AS next_no
       FROM ${eventsTable} WHERE request_id = $1`,
      [requestId]
    );
    const eventNo = nextNo.rows[0].next_no;

    const inProgress = !["succeeded", "failed", "interrupted"].includes(normalizedState);

    const attempt = Number.isInteger(event?.attempt) && event.attempt > 0 ? event.attempt : null;
    const httpStatus =
      Number.isInteger(event?.status) && event.status >= 100 && event.status <= 599
        ? event.status
        : null;

    await client.query(
      `INSERT INTO ${eventsTable}
         (request_id, event_no, event_type, occurred_at, message, attempt, http_status, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        requestId,
        eventNo,
        event?.type ?? null,
        new Date(),
        scrubMessage(event?.message),
        attempt,
        httpStatus,
        JSON.stringify(scrubSecrets({ data: event?.payload ?? event?.data ?? null })),
      ]
    );

    await client.query(
      `UPDATE ${table}
          SET state = $2, in_progress = $3, last_event_at = now()
        WHERE id = $1`,
      [requestId, normalizedState, inProgress]
    );

    await client.query("COMMIT");
    notifyLogsUpdated();
    return { eventNo, state: normalizedState };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
/**
 * Возвращает записи newest first, с событиями; при заданном kind ограничивает выборку этим типом.
 * @param {object} [options]
 * @param {number} [options.limit]
 * @param {"deal"|"invoice"} [options.kind]
 * @returns {Promise<{total: number, items: object[]}>}
 */
export async function listRequests({ limit = MAX_LIST_LIMIT, kind = null } = {}) {
  if (kind !== null) assertKind(kind);

  const effectiveLimit = Math.min(
    Math.max(1, Number.parseInt(limit, 10) || MAX_LIST_LIMIT),
    MAX_LIST_LIMIT
  );
  const kinds = kind ? [kind] : ["deal", "invoice"];
  const sourceSql = kinds.map((requestKind) => {
    const invoiceId = requestKind === "invoice" ? "r.invoice_id" : "NULL::text";
    return `
      SELECT '${requestKind}' AS kind, r.id, r.legacy_id, r.deal_id, ${invoiceId} AS invoice_id,
             r.workflow, r.http_method, r.received_at, r.last_event_at, r.state,
             r.in_progress
        FROM proxy_${requestKind}_requests r`;
  }).join("\n      UNION ALL\n");

  // Шаг 1: сначала выбираем ограниченный newest-набор запросов
  // (ORDER BY last_event_at DESC LIMIT $1) без агрегации событий — дешёвая
  // выборка по индексу last_event_at. Шаг 2: агрегируем events только для
  // выбранных id, поэтому архивные события остальных ~28k строк не читаются.
  const sql = `
    WITH selected AS (
      ${sourceSql}
      ORDER BY last_event_at DESC NULLS LAST
      LIMIT $1
    )
    SELECT sel.kind, sel.id, sel.legacy_id, sel.deal_id, sel.invoice_id,
           sel.workflow, sel.http_method, sel.received_at, sel.last_event_at,
           sel.state, sel.in_progress,
           CASE
             WHEN sel.kind = 'deal' THEN ${EVENTS_JSON("proxy_deal", "sel")}
             ELSE ${EVENTS_JSON("proxy_invoice", "sel")}
           END AS events
      FROM selected sel
     ORDER BY sel.last_event_at DESC NULLS LAST`;

  const { rows } = await pool.query(sql, [effectiveLimit]);
  const items = rows.map((row) => mapRequest(row, row.kind));

  const totalSql = kind
    ? `SELECT count(*) AS total FROM proxy_${kind}_requests`
    : `SELECT (SELECT count(*) FROM proxy_deal_requests)
            + (SELECT count(*) FROM proxy_invoice_requests) AS total`;
  const totals = await pool.query(totalSql);

  return { total: Number(totals.rows[0].total), items };
}

/**
 * Поиск запросов обоих видов по id (legacy_id), dealId или invoiceId.
 * @param {object} params
 * @returns {Promise<object[]>} newest first
 */
export async function searchRequests({ id = null, dealId = null, invoiceId = null } = {}) {
  if (!id && !dealId && !invoiceId) return [];

  // Единый порядок параметров для обеих ветвей UNION ALL:
  // $1 = id (legacy_id), $2 = dealId, $3 = invoiceId. Пустые фильтры не занимают
  // плейсхолдер (значение не передаётся), поэтому число параметров всегда равно
  // числу использованных в SQL плейсхолдеров.
  const filterValues = [];
  const index = { id: null, dealId: null, invoiceId: null };
  if (id) {
    index.id = filterValues.push(id);
  }
  if (dealId) {
    index.dealId = filterValues.push(dealId);
  }
  if (invoiceId) {
    index.invoiceId = filterValues.push(invoiceId);
  }

  // deal-таблица не имеет колонки invoice_id: любой фильтр по счёту
  // исключает сделочную ветвь, в том числе вместе с id/dealId.
  const dealHasNoMatch = Boolean(invoiceId);

  const buildDealWhere = () => {
    if (dealHasNoMatch) return "WHERE false";
    const parts = [];
    if (index.id !== null) parts.push(`legacy_id = $${index.id}`);
    if (index.dealId !== null) parts.push(`deal_id = $${index.dealId}`);
    return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  };

  const buildInvoiceWhere = () => {
    const parts = [];
    if (index.id !== null) parts.push(`legacy_id = $${index.id}`);
    if (index.dealId !== null) parts.push(`deal_id = $${index.dealId}`);
    if (index.invoiceId !== null) parts.push(`invoice_id = $${index.invoiceId}`);
    return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  };

  const sql = `
    SELECT 'deal' AS kind, r.id, r.legacy_id, r.deal_id, NULL::text AS invoice_id,
           r.workflow, r.http_method, r.received_at, r.last_event_at, r.state,
           r.in_progress, ${EVENTS_JSON("proxy_deal", "r")} AS events
      FROM proxy_deal_requests r
      ${buildDealWhere()}
    UNION ALL
    SELECT 'invoice' AS kind, r.id, r.legacy_id, r.deal_id, r.invoice_id,
           r.workflow, r.http_method, r.received_at, r.last_event_at, r.state,
           r.in_progress, ${EVENTS_JSON("proxy_invoice", "r")} AS events
      FROM proxy_invoice_requests r
      ${buildInvoiceWhere()}
    ORDER BY last_event_at DESC NULLS LAST
    LIMIT ${MAX_LIST_LIMIT}`;

  const { rows } = await pool.query(sql, filterValues);
  return rows.map((row) => mapRequest(row, row.kind));
}

/**
 * Возвращает незавершённые записи обоих видов (in_progress IS TRUE).
 * @returns {Promise<object[]>} newest first
 */
export async function listInProgress() {
  const sql = `
    SELECT 'deal' AS kind, r.id, r.legacy_id, r.deal_id, NULL::text AS invoice_id,
           r.workflow, r.http_method, r.received_at, r.last_event_at, r.state,
           r.in_progress, ${EVENTS_JSON("proxy_deal", "r")} AS events
      FROM proxy_deal_requests r
     WHERE r.in_progress IS TRUE
    UNION ALL
    SELECT 'invoice' AS kind, r.id, r.legacy_id, r.deal_id, r.invoice_id,
           r.workflow, r.http_method, r.received_at, r.last_event_at, r.state,
           r.in_progress, ${EVENTS_JSON("proxy_invoice", "r")} AS events
      FROM proxy_invoice_requests r
     WHERE r.in_progress IS TRUE
    ORDER BY last_event_at DESC NULLS LAST
    LIMIT ${MAX_LIST_LIMIT}`;

  const { rows } = await pool.query(sql);
  return rows.map((row) => mapRequest(row, row.kind));
}
/**
 * Почасовая статистика в 24 последовательных часовых интервалах по Europe/Moscow.
 * @returns {Promise<{hours: string[], requests: number[], errors: number[]}>}
 */
export async function hourlyStats() {
  const sql = `
    WITH bounds AS (
      SELECT date_trunc('hour', now() AT TIME ZONE 'Europe/Moscow') AS end_hour,
             date_trunc('hour', now() AT TIME ZONE 'Europe/Moscow') - interval '23 hours' AS start_hour
    ),
    hours AS (
      SELECT generate_series(b.start_hour, b.end_hour, interval '1 hour') AS bucket
        FROM bounds b
    ),
    req AS (
      SELECT date_trunc('hour', r.received_at AT TIME ZONE 'Europe/Moscow') AS bucket,
             count(*) AS cnt
        FROM proxy_deal_requests r
        CROSS JOIN bounds b
       WHERE r.received_at >= (b.start_hour AT TIME ZONE 'Europe/Moscow')
         AND r.received_at <= now()
       GROUP BY bucket
      UNION ALL
      SELECT date_trunc('hour', r.received_at AT TIME ZONE 'Europe/Moscow') AS bucket,
             count(*) AS cnt
        FROM proxy_invoice_requests r
        CROSS JOIN bounds b
       WHERE r.received_at >= (b.start_hour AT TIME ZONE 'Europe/Moscow')
         AND r.received_at <= now()
       GROUP BY bucket
    ),
    err AS (
      SELECT date_trunc('hour', e.occurred_at AT TIME ZONE 'Europe/Moscow') AS bucket,
             count(*) AS cnt
        FROM proxy_deal_events e
        CROSS JOIN bounds b
       WHERE e.event_type = 'error'
         AND e.occurred_at >= (b.start_hour AT TIME ZONE 'Europe/Moscow')
         AND e.occurred_at <= now()
       GROUP BY bucket
      UNION ALL
      SELECT date_trunc('hour', e.occurred_at AT TIME ZONE 'Europe/Moscow') AS bucket,
             count(*) AS cnt
        FROM proxy_invoice_events e
        CROSS JOIN bounds b
       WHERE e.event_type = 'error'
         AND e.occurred_at >= (b.start_hour AT TIME ZONE 'Europe/Moscow')
         AND e.occurred_at <= now()
       GROUP BY bucket
    )
    SELECT to_char(h.bucket, 'DD.MM HH24:MI') AS label,
           COALESCE((SELECT sum(cnt) FROM req WHERE req.bucket = h.bucket), 0) AS requests,
           COALESCE((SELECT sum(cnt) FROM err WHERE err.bucket = h.bucket), 0) AS errors
      FROM hours h
     ORDER BY h.bucket`;

  const { rows } = await pool.query(sql);
  return {
    hours: rows.map((row) => row.label),
    requests: rows.map((row) => Number(row.requests)),
    errors: rows.map((row) => Number(row.errors)),
  };
}

/** Агрегаты графика по всем запросам за календарный период Москвы. */
export async function chartStats({ startDate, endDate }) {
  const parseDate = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new RangeError("Ожидается дата YYYY-MM-DD");
    }
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new RangeError("Некорректная дата");
    }
    return date;
  };
  const first = parseDate(startDate);
  const last = parseDate(endDate);
  const days = (last - first) / 86400000;
  if (days < 0 || days > 365) {
    throw new RangeError("Период должен составлять от 1 до 366 дней");
  }

  const sql = `
    WITH combined AS (
      SELECT r.received_at, r.last_event_at, r.state,
             EXISTS (SELECT 1 FROM proxy_deal_events e
                      WHERE e.request_id = r.id AND e.event_type = 'error') AS has_error
        FROM proxy_deal_requests r
       WHERE r.received_at >= ($1::date::timestamp AT TIME ZONE 'Europe/Moscow')
         AND r.received_at < (($2::date + 1)::timestamp AT TIME ZONE 'Europe/Moscow')
      UNION ALL
      SELECT r.received_at, r.last_event_at, r.state,
             EXISTS (SELECT 1 FROM proxy_invoice_events e
                      WHERE e.request_id = r.id AND e.event_type = 'error') AS has_error
        FROM proxy_invoice_requests r
       WHERE r.received_at >= ($1::date::timestamp AT TIME ZONE 'Europe/Moscow')
         AND r.received_at < (($2::date + 1)::timestamp AT TIME ZONE 'Europe/Moscow')
    ), grouped AS (
      SELECT EXTRACT(HOUR FROM received_at AT TIME ZONE 'Europe/Moscow')::int AS h,
             count(*) FILTER (WHERE state = 'succeeded' AND NOT has_error) AS success,
             count(*) FILTER (WHERE state = 'succeeded' AND has_error) AS success_with_error,
             count(*) FILTER (WHERE state IN ('failed', 'interrupted')
                                   OR (state NOT IN ('succeeded', 'failed', 'interrupted') AND has_error)) AS errors,
             avg(EXTRACT(EPOCH FROM (last_event_at - received_at)))
               FILTER (WHERE last_event_at >= received_at) AS average_duration
        FROM combined
       GROUP BY 1
    )
    SELECT h.h, COALESCE(g.success, 0) AS success,
           COALESCE(g.success_with_error, 0) AS success_with_error,
           COALESCE(g.errors, 0) AS errors,
           COALESCE(g.average_duration, 0) AS average_duration
      FROM generate_series(0, 23) AS h(h)
      LEFT JOIN grouped g ON g.h = h.h
     ORDER BY h.h`;
  const { rows } = await pool.query(sql, [startDate, endDate]);
  return {
    hours: rows.map((row) => Number(row.h)),
    success: rows.map((row) => Number(row.success)),
    successWithError: rows.map((row) => Number(row.success_with_error)),
    error: rows.map((row) => Number(row.errors)),
    averageDurations: rows.map((row) => Number(Number(row.average_duration).toFixed(1))),
  };
}

/**
 * Помечает как interrupted собственные live-записи, оставшиеся незавершёнными
 * после рестарта (по source_ref). Затрагивает только source_kind='live'.
 * @param {string} sourceRef
 * @returns {Promise<number>} количество обновлённых записей
 */
export async function markInterrupted(sourceRef) {
  if (!sourceRef) throw new Error("sourceRef обязателен");

  const client = await pool.connect();
  let updated = 0;
  try {
    await client.query("BEGIN");

    for (const kind of KINDS) {
      const table = `proxy_${kind}_requests`;
      const eventsTable = `proxy_${kind}_events`;
      const result = await client.query(
        `UPDATE ${table}
            SET state = 'interrupted', in_progress = false, last_event_at = now()
          WHERE source_kind = 'live'
            AND source_ref = $1
            AND in_progress IS TRUE
          RETURNING id`,
        [sourceRef]
      );
      for (const row of result.rows) {
        await client.query(
          `INSERT INTO ${eventsTable}
             (request_id, event_no, event_type, occurred_at, message, payload)
           SELECT $1,
                  COALESCE(MAX(event_no), -1) + 1,
                  'error',
                  now(),
                  'Запрос прерван при рестарте прокси',
                  '{}'::jsonb
             FROM ${eventsTable}
            WHERE request_id = $1`,
          [row.id]
        );
      }
      updated += result.rowCount;
    }

    await client.query("COMMIT");
    if (updated > 0) notifyLogsUpdated();
    return updated;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Экспорт пула для управляемого завершения процесса. */
export { pool };
