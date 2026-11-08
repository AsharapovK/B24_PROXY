/**
 * Сервис синхронизации счетов напрямую из Bitrix24 (Smart Invoice, entityTypeId: 31).
 *
 * Получает счета, изменившиеся за указанный период (по умолчанию: вчера и сегодня),
 * нормализует статусы, даты и измерения, и обновляет таблицу invoices согласно
 * заложенной архитектурной модели (версионирование, происхождение статусов, резолвинг комнат).
 */

import { pool } from "./requestStore.js";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

if (process.env.NODE_ENV !== "test" && !process.env.NO_LOAD_ENV) {
  try {
    if (typeof loadEnvFile === "function") {
      loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const DEFAULT_WEBHOOK_URL = process.env.B24_WEBHOOK_URL || process.env.B24_WEBHOOK;

const ENTITY_TYPE_ID = 31;
const PAYMENT_COMPONENT_FIELDS = [
  "ufCrm_6780C53A486A3", // Сумма 1-ой оплаты (С)
  "ufCrm_68CA2C6E07484", // Сумма 2-ой оплаты, (С)
  "ufCrm_6780C53AA37C4", // Сумма 3-ей оплаты, (С)
];

/**
 * Приводит строковые скаляры к trim или null (объекты/массивы игнорируются).
 */
function dimensionScalar(value) {
  if (value === null || value === undefined || typeof value === "object") return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

/**
 * Извлекает первый непустой строковый идентификатор.
 */
function toId(value) {
  if (Array.isArray(value)) value = value[0];
  if (value === null || value === undefined || typeof value === "object") return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

/**
 * Парсит числовую сумму.
 */
function parseAmount(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/[\s\u00a0]/g, "").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(normalized) ? normalized : null;
}

function parseMoneyField(value, fieldName) {
  if (value === null || value === undefined || value === "") return null;
  const [rawAmount, currency, ...extra] = String(value).trim().split("|");
  const amount = parseAmount(rawAmount);
  if (amount === null || !currency || extra.length > 0) {
    throw new Error(`Invalid Bitrix24 money value in ${fieldName}`);
  }
  return { amount, currency: currency.trim().toUpperCase() };
}

function amountToMinorUnits(value, fieldName) {
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > 2) throw new Error(`Unsupported precision in ${fieldName}`);
  const sign = whole.startsWith("-") ? -1n : 1n;
  const wholeDigits = whole.replace(/^-/, "");
  return sign * (BigInt(wholeDigits) * 100n + BigInt((fraction + "00").slice(0, 2)));
}

function minorUnitsToAmount(value) {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function getPaymentAmounts(item) {
  const componentFieldsPresent = PAYMENT_COMPONENT_FIELDS.every(field =>
    Object.prototype.hasOwnProperty.call(item, field)
  );

  if (!componentFieldsPresent) {
    return {
      components: [null, null, null],
      paidAmount: parseAmount(item.ufCrmSmartInvoiceTbiPaymentAmountNum ?? item.ufCrm_67ADAF07BC0C8),
      usesPaymentComponents: false,
    };
  }

  const parsed = PAYMENT_COMPONENT_FIELDS.map(field => parseMoneyField(item[field], field));
  const currencies = [...new Set(parsed.filter(Boolean).map(value => value.currency))];
  const invoiceCurrency = dimensionScalar(item.currencyId)?.toUpperCase();
  if (currencies.length > 1 || (invoiceCurrency && currencies.length === 1 && currencies[0] !== invoiceCurrency)) {
    throw new Error(`Mismatched Bitrix24 payment currency for invoice ${item.id}`);
  }

  const minorUnits = parsed.reduce((total, value, index) =>
    total + (value ? amountToMinorUnits(value.amount, PAYMENT_COMPONENT_FIELDS[index]) : 0n), 0n);

  return {
    components: parsed.map(value => value?.amount ?? null),
    paidAmount: minorUnitsToAmount(minorUnits),
    usesPaymentComponents: true,
  };
}

/**
 * Парсит дату в формат YYYY-MM-DD.
 */
function parseDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  const date = match
    ? new Date(`${match[3]}-${match[2]}-${match[1]}T00:00:00Z`)
    : new Date(text);
  if (Number.isNaN(date.valueOf())) return null;
  if (match && date.toISOString().slice(0, 10) !== `${match[3]}-${match[2]}-${match[1]}`) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Парсит временную метку ISO.
 */
function parseInstant(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

/**
 * Определяет статус счета (active | cancelled) по stageId из Б24.
 */
function mapInvoiceStatus(stageId) {
  const stage = String(stageId || "").trim();
  if (
    stage === "DT31_2:D" ||
    stage === "DT31_2:UC_LDULMQ" ||
    stage === "DT31_2:UC_Z48RE1" ||
    stage.includes("возврат")
  ) {
    return "cancelled";
  }
  return "active";
}

/**
 * Определяет статус оплаты (paid | partial | unpaid) по stageId и paidAmount.
 */
function mapPaymentStatus(stageId, paidAmount, totalAmount) {
  const stage = String(stageId || "").trim();
  if (stage === "DT31_2:P") {
    return "paid";
  }
  const partialStages = [
    "DT31_2:UC_IFN8Q1", // Первый частичный платеж
    "DT31_2:UC_RPQJTA", // Второй частичный платеж
    "DT31_2:UC_ZCAB0B", // Внесен АВАНС
    "DT31_2:UC_6ALUZF", // ЗАКРЫВАЮЩИЙ ПЛАТЕЖ
    "DT31_2:UC_RWS270", // Депозит
  ];
  if (partialStages.includes(stage)) {
    return "partial";
  }
  const paid = paidAmount !== null ? Number(paidAmount) : 0;
  const total = totalAmount !== null ? Number(totalAmount) : 0;
  if (paid > 0 && paid < total) {
    return "partial";
  }
  if (paid >= total && total > 0) {
    return "paid";
  }
  return paidAmount === null ? "unknown" : "unpaid";
}

/**
 * Вычисляет дату начала выборки (по умолчанию: вчера 00:00:00 MSK).
 * @param {number} days
 * @returns {Date}
 */
export function getDefaultSinceDate(days = 2) {
  const now = new Date();
  // Вычисляем начало дня N дней назад по московскому времени (UTC+3)
  const mskOffsetMs = 3 * 60 * 60 * 1000;
  const mskNow = new Date(now.getTime() + mskOffsetMs);
  mskNow.setUTCHours(0, 0, 0, 0);
  mskNow.setUTCDate(mskNow.getUTCDate() - (days - 1));
  return new Date(mskNow.getTime() - mskOffsetMs);
}

/**
 * Вызывает REST API Bitrix24.
 */
async function callBitrix(webhookUrl, method, params = {}) {
  const base = webhookUrl.endsWith("/") ? webhookUrl : `${webhookUrl}/`;
  const url = `${base}${method}.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Bitrix24 API ${method} HTTP ${res.status}: ${text}`);
  }
  return await res.json();
}

/**
 * Загружает справочник полей смарт-счетов для сверки ключей UF_* с их названиями.
 * @param {object} [options]
 * @param {string} [options.webhookUrl]
 * @param {typeof callBitrix} [options.request]
 * @returns {Promise<object>}
 */
export async function fetchInvoiceFieldDefinitions({
  webhookUrl = DEFAULT_WEBHOOK_URL,
  request = callBitrix,
} = {}) {
  const targetUrl = webhookUrl || (request !== callBitrix ? "https://b24.mock.invalid/" : undefined);
  if (!targetUrl) throw new Error("B24_WEBHOOK_URL is required");
  const data = await request(targetUrl, "crm.item.fields", { entityTypeId: ENTITY_TYPE_ID });
  if (data?.error) throw new Error(`Bitrix24 API crm.item.fields: ${data.error}`);
  const fields = data?.result?.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error("Invalid Bitrix24 crm.item.fields response");
  }
  return fields;
}

/**
 * Загружает счета пакетами до 50 страниц crm.item.list (до 2500 счетов).
 * @param {object} options
 * @param {string} [options.webhookUrl]
 * @param {Date} [options.sinceDate]
 * @returns {Promise<Array<object>>}
 */
export async function fetchChangedInvoicesFromBitrix({
  webhookUrl = DEFAULT_WEBHOOK_URL,
  sinceDate = null,
  untilDate = null,
  request = callBitrix,
  verifyConsistency = false,
} = {}) {
  const targetUrl = webhookUrl || (request !== callBitrix ? "https://b24.mock.invalid/" : undefined);
  if (!targetUrl) throw new Error("B24_WEBHOOK_URL is required");
  if (sinceDate !== null && (!(sinceDate instanceof Date) || Number.isNaN(sinceDate.valueOf()))) throw new Error("Invalid sinceDate");
  if (untilDate !== null && (!(untilDate instanceof Date) || Number.isNaN(untilDate.valueOf()))) throw new Error("Invalid untilDate");

  async function fetchPass() {
    const items = [];
    let lastId = 0;
    let offset = 0;
    let passTotal = null;

    while (true) {
      const filter = {};
      if (untilDate) filter["<=updatedTime"] = untilDate.toISOString();
      if (sinceDate) filter[">=updatedTime"] = sinceDate.toISOString();
      const cmd = {};
      for (let i = 0; i < 50; i++) {
        const params = new URLSearchParams();
        params.set("entityTypeId", String(ENTITY_TYPE_ID));
        params.append("select[]", "*");
        params.append("select[]", "uf*");
        PAYMENT_COMPONENT_FIELDS.forEach(field => params.append("select[]", field));
        if (filter["<=updatedTime"]) params.set("filter[<=updatedTime]", filter["<=updatedTime"]);
        if (filter[">=updatedTime"]) params.set("filter[>=updatedTime]", filter[">=updatedTime"]);
        params.set("order[id]", "asc");
        params.set("start", String(offset + i * 50));
        cmd[`page${i}`] = `crm.item.list?${params}`;
      }
      const data = await request(targetUrl, "batch", { halt: 0, cmd });
      if (!data || typeof data !== "object") throw new Error("Invalid Bitrix24 batch response");
      if (data.error) throw new Error(`Bitrix24 batch error: ${data.error}`);

      const batchResult = data.result;
      if (!batchResult || typeof batchResult !== "object") throw new Error("Invalid Bitrix24 batch response");

      const errors = batchResult.result_error;
      if (errors && typeof errors === "object" && Object.keys(errors).length > 0) {
        throw new Error(`Bitrix24 batch command failed: ${Object.keys(errors).join(", ")}`);
      }

      const result = batchResult.result;
      const resultTotal = batchResult.result_total;
      const resultNext = batchResult.result_next;

      if (
        !result || typeof result !== "object" || Array.isArray(result) ||
        !errors || typeof errors !== "object" ||
        !resultTotal || typeof resultTotal !== "object" || Array.isArray(resultTotal) ||
        !resultNext || typeof resultNext !== "object"
      ) {
        throw new Error("Invalid Bitrix24 batch response: missing or invalid batch pagination metadata (result, result_error, result_total, result_next)");
      }

      if (Object.keys(errors).length) {
        throw new Error(`Bitrix24 batch command failed: ${Object.keys(errors).join(", ")}`);
      }

      let ended = false;
      for (let i = 0; i < 50; i++) {
        const cmdKey = `page${i}`;
        const cmdStart = offset + i * 50;

        if (!(cmdKey in resultTotal)) {
          throw new Error(`Missing result_total for ${cmdKey}`);
        }
        const rawTotal = resultTotal[cmdKey];
        const cmdTotal = typeof rawTotal === "number" ? rawTotal : Number(rawTotal);
        if (!Number.isSafeInteger(cmdTotal) || cmdTotal < 0) {
          throw new Error(`Invalid result_total for ${cmdKey}: ${rawTotal}`);
        }

        if (passTotal === null) {
          passTotal = cmdTotal;
        } else if (cmdTotal !== passTotal) {
          throw new Error(`Inconsistent result_total for ${cmdKey}: expected ${passTotal}, got ${cmdTotal}`);
        }

        const pageRes = result[cmdKey];
        if (!pageRes || typeof pageRes !== "object") {
          throw new Error(`Invalid Bitrix24 list response for ${cmdKey}`);
        }
        const page = pageRes.items;
        if (!Array.isArray(page) || page.length > 50) {
          throw new Error(`Invalid Bitrix24 list response for ${cmdKey}`);
        }

        const expectedCount = Math.min(50, Math.max(0, passTotal - cmdStart));
        if (page.length !== expectedCount) {
          throw new Error(
            `Page ${cmdKey} item count (${page.length}) does not match expected (${expectedCount}) for total ${passTotal} at start ${cmdStart}`
          );
        }

        const hasNext = cmdStart + page.length < passTotal;
        if (hasNext) {
          if (!(cmdKey in resultNext)) {
            throw new Error(`Missing expected result_next for ${cmdKey} when total ${passTotal} exceeds start ${cmdStart + page.length}`);
          }
          const rawNext = resultNext[cmdKey];
          const nextStart = typeof rawNext === "number" ? rawNext : Number(rawNext);
          if (!Number.isSafeInteger(nextStart) || nextStart !== cmdStart + 50) {
            throw new Error(`Invalid result_next for ${cmdKey}: expected ${cmdStart + 50}, got ${rawNext}`);
          }
        } else {
          if (cmdKey in resultNext && resultNext[cmdKey] !== null && resultNext[cmdKey] !== undefined) {
            throw new Error(`Unexpected result_next for ${cmdKey} when total ${passTotal} is reached at start ${cmdStart}`);
          }
        }

        if (ended && page.length > 0) {
          throw new Error(`Unexpected items on ${cmdKey} after pagination ended`);
        }

        for (const item of page) {
          const id = Number(item.id);
          if (!Number.isSafeInteger(id) || id <= lastId) throw new Error("Invalid or unordered invoice id");
          lastId = id;
          items.push(item);
        }

        if (cmdStart + page.length >= passTotal) {
          ended = true;
        }
      }

      if (ended) break;
      offset += 2500;
    }

    if (items.length !== passTotal) {
      throw new Error(`Total fetched items (${items.length}) does not match B24 result_total (${passTotal})`);
    }

    return { items, total: passTotal };
  }

  const pass1 = await fetchPass();

  if (verifyConsistency) {
    const pass2 = await fetchPass();
    if (pass1.total !== pass2.total) {
      throw new Error(`Snapshot consistency verification failed: total changed from ${pass1.total} to ${pass2.total}`);
    }
    if (pass1.items.length !== pass2.items.length) {
      throw new Error(`Snapshot consistency verification failed: item count changed from ${pass1.items.length} to ${pass2.items.length}`);
    }
    for (let i = 0; i < pass1.items.length; i++) {
      if (String(pass1.items[i].id) !== String(pass2.items[i].id) || pass1.items[i].updatedTime !== pass2.items[i].updatedTime) {
        throw new Error(`Snapshot consistency verification failed: discrepancy at index ${i} (id: ${pass1.items[i].id} vs ${pass2.items[i].id})`);
      }
      if (!parseInstant(pass1.items[i].updatedTime)) {
        throw new Error(`Snapshot consistency verification failed: item ${pass1.items[i].id} lacks valid updatedTime`);
      }
    }
  }

  return pass1.items;
}

/**
 * Сверяет снимок с Bitrix24 для подтверждения полноты перед удалением отсутствующих строк.
 * Сравнивает точные наборы invoice ID и updatedTime. При расхождении удаление запрещается.
 * @param {Array<object>} items
 * @param {object} [options]
 * @returns {Promise<{ verified: boolean, reason?: string, count: number }>}
 */
export async function verifySnapshotCompleteness(items, {
  webhookUrl = DEFAULT_WEBHOOK_URL,
  request = callBitrix,
} = {}) {
  const current = await fetchChangedInvoicesFromBitrix({
    webhookUrl,
    sinceDate: null,
    untilDate: null,
    request,
    verifyConsistency: true,
  });
  if (current.length !== items.length) {
    return {
      verified: false,
      reason: `Количество счетов в снимке (${items.length}) не совпадает со снимком Б24 (${current.length})`,
      count: items.length,
    };
  }
  const snapMap = new Map();
  for (const it of items) {
    const id = toId(it.id);
    const instant = parseInstant(it.updatedTime);
    if (!id || !instant) {
      return {
        verified: false,
        reason: `Счет в снимке имеет некорректный ID или updatedTime`,
        count: items.length,
      };
    }
    snapMap.set(id, instant.toISOString());
  }
  for (const item of current) {
    const id = toId(item.id);
    const currInstant = parseInstant(item.updatedTime);
    if (!id || !currInstant) {
      return {
        verified: false,
        reason: `Счет в Б24 имеет некорректный ID или updatedTime`,
        count: items.length,
      };
    }
    if (!snapMap.has(id)) {
      return {
        verified: false,
        reason: `В Б24 найден счет ${id}, отсутствующий в снимке`,
        count: items.length,
      };
    }
    const snapTime = snapMap.get(id);
    const currTime = currInstant.toISOString();
    if (snapTime !== currTime) {
      return {
        verified: false,
        reason: `Время обновления счета ${id} не совпадает (снимок: ${snapTime}, Б24: ${currTime})`,
        count: items.length,
      };
    }
  }
  return { verified: true, count: items.length };
}

/**
 * Синхронизирует один счет из Б24 в PostgreSQL в рамках транзакции.
 * @param {import('pg').PoolClient} client
 * @param {object} item
 * @returns {Promise<{ invoiceId: string, status: 'updated' | 'inserted' | 'skipped' }>}
 */
export async function syncSingleInvoice(client, item) {
  const invoiceId = toId(item.id);
  if (!invoiceId) return { invoiceId: null, status: "skipped" };

  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [invoiceId]);

  const dealId =
    toId(item.parentId2) ||
    toId(item.ufCrm_67925582298F8) ||
    null;

  const clientId =
    toId(Array.isArray(item.contactIds) ? item.contactIds[0] : item.contactId) ||
    null;

  // Исходный источник invoice_date в B24 — begindate. При отсутствии сохраняем NULL без fallback на createdTime.
  const invoiceDate = parseDate(item.begindate);

  const checkIn =
    parseDate(item.ufCrm_6780C536C1950) ||
    parseDate(item.ufCrm_682C33DAF35B0) ||
    parseDate(item.ufCrm_1747709659) ||
    parseDate(item.ufCrm_1711464263870) ||
    null;

  const checkOut =
    parseDate(item.ufCrm_6780C536C7240) ||
    parseDate(item.ufCrm_682C33DB2C6BD) ||
    parseDate(item.ufCrm_1747709682) ||
    parseDate(item.ufCrm_1711464284655) ||
    null;

  // Исходный источник ночей — алиасы полей B24. При отсутствии сохраняем NULL без вычисления из дат заезда/выезда.
  const rawNights =
    item.ufCrm_682C33DB915F0 ??
    item.ufCrm_1747710789 ??
    item.ufCrm_1762501484 ??
    null;
  const parsedNights =
    rawNights !== null && rawNights !== "" && !Number.isNaN(Number(rawNights))
      ? Number(rawNights)
      : null;
  const nights = parsedNights && parsedNights > 0 ? parsedNights : null;

  const tariffCode =
    dimensionScalar(item.ufCrm_682C33DB6E4B8) ||
    dimensionScalar(item.ufCrm_67AB08D45B504) ||
    dimensionScalar(item.ufCrm_1770858300) ||
    dimensionScalar(item.ufCrm_SMART_INVOICE_1770859065);

  const tariffName =
    dimensionScalar(item.ufCrm_682C33DBD2DCF) ||
    dimensionScalar(item.ufCrm_6780C53BC5238) ||
    dimensionScalar(item.ufCrm_1747710844) ||
    dimensionScalar(item.ufCrm_682C33DBB0CF9);

  const roomTypeName =
    dimensionScalar(item.ufCrm_679255819E7C1) ||
    dimensionScalar(item.ufCrm_1737443104642) ||
    dimensionScalar(item.ufCrm_6736FD0E36851);

  const roomNumber =
    dimensionScalar(item.ufCrm_67925581C6B36) ||
    dimensionScalar(item.ufCrm_1737448035);

  const amount = parseAmount(item.opportunity);
  const paymentAmounts = getPaymentAmounts(item);
  const paidAmount = paymentAmounts.paidAmount;

  const invoiceStatus = mapInvoiceStatus(item.stageId);
  const paymentStatus = mapPaymentStatus(item.stageId, paidAmount, amount);
  const b24StageId = dimensionScalar(item.stageId);

  const updatedTime = parseInstant(item.updatedTime);
  if (!updatedTime) throw new Error("Invoice lacks valid updatedTime");

  // Проверяем текущее состояние в базе
  const existing = await client.query("SELECT * FROM invoices WHERE invoice_id=$1 FOR UPDATE", [invoiceId]);
  const isNew = existing.rowCount === 0;
  const previous = existing.rows[0];

  const paymentVersion = updatedTime;
  const invoiceVersion = updatedTime;
  const factsVersion = updatedTime;
  const validVersion = updatedTime;

  // Определение происхождения предыдущих фактов и статусов
  let previousConfirmedB24FactsTime = null;
  if (!isNew && client) {
    try {
      const eventsRes = await client.query(
        `SELECT occurred_at, payload FROM invoice_events
         WHERE invoice_id = $1
           AND source_type = 'reconciliation'
           AND status_basis = 'b24_sync'
           AND (payload->'applied'->>'facts')::boolean = true
         ORDER BY occurred_at DESC, id DESC
         LIMIT 1`,
        [invoiceId]
      );
      if (eventsRes?.rows?.length > 0) {
        const row = eventsRes.rows[0];
        const timeVal = row.payload?.b24_updated_time || row.occurred_at;
        if (timeVal) {
          previousConfirmedB24FactsTime = new Date(timeVal).getTime();
        }
      }
    } catch {
      // Игнорируем ошибку при отсутствии таблицы/колонки в моках
    }
  }

  // Признак происхождения фактов из Sheets-импорта:
  // - наличие import_row_id (даже если статусы были позже синхронизированы в b24_sync)
  // - или invoice_status_basis === "sheet_import"
  // - или status_basis начинается с "legacy_"
  const hasPreviousSheetFacts = Boolean(
    previous && (
      previous.import_row_id != null ||
      previous.invoice_status_basis === "sheet_import" ||
      previous.status_basis?.startsWith("legacy_")
    )
  );

  // Факты считаются подтверждёнными от B24, если:
  // 1) Есть подтверждённое событие B24 с applied.facts = true, ИЛИ
  // 2) Запись не из Sheets и имеет status_basis === "b24_sync"
  const hasConfirmedB24Facts = previousConfirmedB24FactsTime !== null || (
    previous && !hasPreviousSheetFacts && previous.status_basis === "b24_sync"
  );

  const isPreviousProxyTime = Boolean(
    previous && !hasPreviousSheetFacts && !hasConfirmedB24Facts && (
      previous.status_basis?.startsWith("proxy_") ||
      previous.invoice_status_time_basis === "proxy_observed_at"
    )
  );
  const proxyDelayToleranceMs = isPreviousProxyTime ? 60000 : 0;

  // Поля компонентов оплаты из B24 являются источником истины для суммы.
  // При одинаковом updatedTime они разрешают повторно вычислить прежний статус,
  // если он ранее был рассчитан по устаревшему полю общей предоплаты.
  const paymentConflict = Boolean(
    previous?.payment_version &&
    paymentVersion.valueOf() === new Date(previous.payment_version).valueOf() &&
    paymentStatus !== previous.payment_status &&
    !paymentAmounts.usesPaymentComponents
  );
  const invoiceConflict = Boolean(
    previous?.invoice_version &&
    invoiceVersion.valueOf() === new Date(previous.invoice_version).valueOf() &&
    invoiceStatus !== previous.invoice_status
  );

  let factsAccepted = false;
  let invoiceAccepted = false;
  let paymentAccepted = false;

  if (isNew) {
    factsAccepted = true;
    invoiceAccepted = true;
    paymentAccepted = true;
  } else if (hasConfirmedB24Facts) {
    // В БД уже есть подтвержденные B24-факты:
    // Более старый B24 snapshot НЕ перезаписывает факты с более новым подтвержденным временем
    const prevB24FactsTime = previousConfirmedB24FactsTime ?? (
      previous.facts_version ? new Date(previous.facts_version).getTime() : 0
    );
    factsAccepted = factsVersion.getTime() >= prevB24FactsTime;

    const prevInvoiceTime = previous.invoice_version ? new Date(previous.invoice_version).getTime() : 0;
    const prevPaymentTime = previous.payment_version ? new Date(previous.payment_version).getTime() : 0;

    invoiceAccepted = !invoiceConflict && (invoiceVersion.getTime() >= prevInvoiceTime);
    paymentAccepted = !paymentConflict && (paymentStatus !== "unknown") && (paymentVersion.getTime() >= prevPaymentTime);
  } else if (hasPreviousSheetFacts) {
    // Факты пришли из Sheets-импорта (с искусственно более поздним captured_at):
    // Текущий реальный B24 snapshot исправляет искусственный timestamp
    factsAccepted = true;

    // Статусы: если они уже были подтверждены из B24, проверяем их версии отдельно
    if (previous.invoice_status_basis === "b24_sync") {
      const prevInvoiceTime = previous.invoice_version ? new Date(previous.invoice_version).getTime() : 0;
      invoiceAccepted = !invoiceConflict && (invoiceVersion.getTime() >= prevInvoiceTime);
    } else {
      invoiceAccepted = !invoiceConflict;
    }

    if (previous.payment_status_basis === "b24_sync") {
      const prevPaymentTime = previous.payment_version ? new Date(previous.payment_version).getTime() : 0;
      paymentAccepted = !paymentConflict && (paymentStatus !== "unknown") && (paymentVersion.getTime() >= prevPaymentTime);
    } else {
      paymentAccepted = !paymentConflict && (paymentStatus !== "unknown" || !previous.payment_status || previous.payment_status === "unknown");
    }
  } else {
    // Предыдущие данные от proxy (или иные) с учетом proxyDelayToleranceMs
    factsAccepted = !previous.facts_version ||
      (factsVersion.getTime() + proxyDelayToleranceMs) >= new Date(previous.facts_version).getTime();
    invoiceAccepted = !invoiceConflict &&
      (!previous.invoice_version ||
        (invoiceVersion.getTime() + proxyDelayToleranceMs) >= new Date(previous.invoice_version).getTime());
    paymentAccepted = !paymentConflict && (paymentStatus !== "unknown") &&
      (!previous.payment_version ||
        (paymentVersion.getTime() + proxyDelayToleranceMs) >= new Date(previous.payment_version).getTime());
  }

  if (!isNew && !factsAccepted && !invoiceAccepted && !paymentAccepted) {
    return { invoiceId, status: "skipped" };
  }

  const appliedPayment = paymentAccepted ? paymentStatus : (previous?.payment_status || paymentStatus);
  const appliedStatus = invoiceAccepted ? invoiceStatus : (previous?.invoice_status || invoiceStatus);

  const dimensions = {
    tariff_code: tariffCode,
    tariff_name: tariffName,
    room_type_name: roomTypeName,
    room_number: roomNumber,
  };

  // Резолвинг room_type_id и room_id через штатные функции БД
  const resolved = (factsAccepted && dimensions.room_type_name)
    ? await client.query(
        `WITH room_type AS (SELECT public.invoice_room_type_id($1::text) AS id)
         SELECT id AS room_type_id, public.invoice_room_id($2::text, id) AS room_id FROM room_type`,
        [dimensions.room_type_name, dimensions.room_number]
      )
    : null;

  const basis = "b24_sync";

  await client.query(
    `INSERT INTO invoices
      (invoice_id, deal_id, client_id, invoice_date, check_in, check_out, nights, accommodation, tariff, amount, paid_amount,
       invoice_status, payment_status, status_basis, status_changed_at,
       source_version, payment_version, invoice_version, facts_version, updated_at,
       tariff_code, tariff_name, room_type_name, room_number, room_type_id, room_id,
       invoice_status_basis, payment_status_basis, invoice_status_changed_at, payment_status_changed_at,
       invoice_status_time_basis, payment_status_time_basis,
       b24_stage_id, payment_1_amount, payment_2_amount, payment_3_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now(),$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)
     ON CONFLICT (invoice_id) DO UPDATE SET
       deal_id=CASE WHEN $36 THEN EXCLUDED.deal_id ELSE invoices.deal_id END,
       client_id=CASE WHEN $36 THEN EXCLUDED.client_id ELSE invoices.client_id END,
       invoice_date=CASE WHEN $36 THEN EXCLUDED.invoice_date ELSE invoices.invoice_date END,
       check_in=CASE WHEN $36 THEN EXCLUDED.check_in ELSE invoices.check_in END,
       check_out=CASE WHEN $36 THEN EXCLUDED.check_out ELSE invoices.check_out END,
       nights=CASE WHEN $36 THEN EXCLUDED.nights ELSE invoices.nights END,
       accommodation=CASE WHEN $36 THEN EXCLUDED.accommodation ELSE invoices.accommodation END,
       tariff=CASE WHEN $36 THEN EXCLUDED.tariff ELSE invoices.tariff END,
       tariff_code=CASE WHEN $36 THEN EXCLUDED.tariff_code ELSE invoices.tariff_code END,
       tariff_name=CASE WHEN $36 THEN EXCLUDED.tariff_name ELSE invoices.tariff_name END,
       room_type_name=CASE WHEN $36 THEN EXCLUDED.room_type_name ELSE invoices.room_type_name END,
       room_number=CASE WHEN $36 THEN EXCLUDED.room_number ELSE invoices.room_number END,
       room_type_id=CASE WHEN $36 THEN EXCLUDED.room_type_id ELSE invoices.room_type_id END,
       room_id=CASE WHEN $36 THEN EXCLUDED.room_id ELSE invoices.room_id END,
       amount=CASE WHEN $36 THEN EXCLUDED.amount ELSE invoices.amount END,
       paid_amount=CASE WHEN $38 THEN EXCLUDED.paid_amount ELSE invoices.paid_amount END,
       payment_1_amount=CASE WHEN $38 THEN EXCLUDED.payment_1_amount ELSE invoices.payment_1_amount END,
       payment_2_amount=CASE WHEN $38 THEN EXCLUDED.payment_2_amount ELSE invoices.payment_2_amount END,
       payment_3_amount=CASE WHEN $38 THEN EXCLUDED.payment_3_amount ELSE invoices.payment_3_amount END,
       invoice_status=CASE WHEN $37 THEN EXCLUDED.invoice_status ELSE invoices.invoice_status END,
       payment_status=CASE WHEN $38 THEN EXCLUDED.payment_status ELSE invoices.payment_status END,
       status_basis=CASE WHEN $37 OR $38 THEN EXCLUDED.status_basis ELSE invoices.status_basis END,
       status_changed_at=CASE WHEN $37 OR $38 THEN EXCLUDED.status_changed_at ELSE invoices.status_changed_at END,
       source_version=CASE WHEN $37 OR $38 THEN GREATEST(invoices.source_version, EXCLUDED.source_version) ELSE invoices.source_version END,
       payment_version=CASE WHEN $38 THEN EXCLUDED.payment_version ELSE invoices.payment_version END,
       invoice_version=CASE WHEN $37 THEN EXCLUDED.invoice_version ELSE invoices.invoice_version END,
       facts_version=CASE WHEN $36 THEN EXCLUDED.facts_version ELSE invoices.facts_version END,
       invoice_status_basis=CASE WHEN $37 THEN EXCLUDED.invoice_status_basis ELSE invoices.invoice_status_basis END,
       payment_status_basis=CASE WHEN $38 THEN EXCLUDED.payment_status_basis ELSE invoices.payment_status_basis END,
       invoice_status_changed_at=CASE WHEN $37 THEN EXCLUDED.invoice_status_changed_at ELSE invoices.invoice_status_changed_at END,
       payment_status_changed_at=CASE WHEN $38 THEN EXCLUDED.payment_status_changed_at ELSE invoices.payment_status_changed_at END,
       invoice_status_time_basis=CASE WHEN $37 THEN EXCLUDED.invoice_status_time_basis ELSE invoices.invoice_status_time_basis END,
       payment_status_time_basis=CASE WHEN $38 THEN EXCLUDED.payment_status_time_basis ELSE invoices.payment_status_time_basis END,
       b24_stage_id=CASE WHEN $37 OR $38 OR $36 THEN EXCLUDED.b24_stage_id ELSE invoices.b24_stage_id END,
       updated_at=now()`,
    [
      invoiceId,
      dealId,
      clientId,
      invoiceDate,
      checkIn,
      checkOut,
      nights > 0 ? nights : null,
      dimensions.room_type_name,
      dimensions.tariff_name,
      amount,
      paidAmount,
      nextStatus(isNew, invoiceAccepted, invoiceStatus, previous),
      nextPayment(isNew, paymentAccepted, paymentStatus, previous),
      basis,
      validVersion,
      validVersion,
      paymentAccepted ? paymentVersion : null,
      invoiceAccepted ? invoiceVersion : null,
      factsAccepted ? factsVersion : null,
      dimensions.tariff_code,
      dimensions.tariff_name,
      dimensions.room_type_name,
      dimensions.room_number,
      factsAccepted ? resolved?.rows[0]?.room_type_id ?? null : previous?.room_type_id ?? null,
      factsAccepted ? resolved?.rows[0]?.room_id ?? null : previous?.room_id ?? null,
      invoiceAccepted ? basis : (previous?.invoice_status_basis || "unknown"),
      paymentAccepted ? basis : (previous?.payment_status_basis || "unknown"),
      invoiceAccepted ? updatedTime : (previous?.invoice_status_changed_at ?? null),
      paymentAccepted ? updatedTime : (previous?.payment_status_changed_at ?? null),
      invoiceAccepted ? "source_timestamp" : (previous?.invoice_status_time_basis || "unknown"),
      paymentAccepted ? "source_timestamp" : (previous?.payment_status_time_basis || "unknown"),
      b24StageId,
      ...paymentAmounts.components,
      factsAccepted,
      invoiceAccepted,
      paymentAccepted,
    ]
  );

  // Фиксация события в invoice_events
  const paymentAmountsChanged = Boolean(
    previous && paymentAccepted && (
      Number(previous.paid_amount ?? 0) !== Number(paidAmount ?? 0) ||
      paymentAmounts.components.some((value, index) =>
        Number(previous[["payment_1_amount", "payment_2_amount", "payment_3_amount"][index]] ?? 0) !== Number(value ?? 0)
      )
    )
  );
  const eventKey = paymentAmountsChanged && paymentAmounts.usesPaymentComponents
    ? `b24_payment_components_v1:${invoiceId}:${updatedTime.toISOString()}`
    : `b24_sync:${invoiceId}:${updatedTime.toISOString()}`;
  const stageChanged = Boolean(
    (factsAccepted || invoiceAccepted || paymentAccepted) &&
    previous &&
    previous.b24_stage_id !== b24StageId
  );
  const changed =
    !previous ||
    paymentAmountsChanged ||
    (paymentAccepted && previous.payment_status !== appliedPayment) ||
    (invoiceAccepted && previous.invoice_status !== appliedStatus) ||
    stageChanged;

  const eventPayload = {
    source: "b24_sync",
    b24_updated_time: item.updatedTime,
    b24_stage_id: item.stageId,
    deal_id: dealId,
    client_id: clientId,
    amount,
    paid_amount: paidAmount,
    payment_1_amount: paymentAmounts.components[0],
    payment_2_amount: paymentAmounts.components[1],
    payment_3_amount: paymentAmounts.components[2],
    applied: {
      facts: factsAccepted,
      invoice_status: invoiceAccepted,
      payment_status: paymentAccepted,
    },
  };

  await client.query(
    `INSERT INTO invoice_events
      (invoice_id, source_type, event_key, event_type, invoice_status,
       payment_status, status_basis, source_version, payload, occurred_at,
       invoice_status_basis, payment_status_basis, invoice_status_changed_at, payment_status_changed_at,
       invoice_status_time_basis, payment_status_time_basis)
     VALUES ($1, 'reconciliation', $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (event_key) DO NOTHING`,
    [
      invoiceId,
      eventKey,
      changed ? "status_changed" : "request_observed",
      appliedStatus,
      appliedPayment,
      basis,
      validVersion,
      JSON.stringify(eventPayload),
      updatedTime,
      invoiceAccepted ? basis : (previous?.invoice_status_basis || "unknown"),
      paymentAccepted ? basis : (previous?.payment_status_basis || "unknown"),
      invoiceAccepted ? updatedTime : null,
      paymentAccepted ? updatedTime : null,
      invoiceAccepted ? "source_timestamp" : "unknown",
      paymentAccepted ? "source_timestamp" : "unknown",
    ]
  );

  return { invoiceId, status: isNew ? "inserted" : "updated" };
}

function nextStatus(isNew, invoiceAccepted, invoiceStatus, previous) {
  if (invoiceAccepted) return invoiceStatus;
  return isNew ? invoiceStatus : previous.invoice_status;
}

function nextPayment(isNew, paymentAccepted, paymentStatus, previous) {
  if (paymentAccepted) return paymentStatus;
  return isNew ? paymentStatus : previous.payment_status;
}

/**
 * Главная функция синхронизации списка счетов.
 * @param {object} options
 * @param {number} [options.days=2] количество дней назад (по умолчанию 2: сегодня и вчера)
 * @param {string} [options.webhookUrl]
 * @returns {Promise<{ total: number, inserted: number, updated: number, skipped: number, errors: Array<object> }>}
 */
export async function syncRecentInvoices({
  days = 2,
  full = false,
  dryRun = false,
  webhookUrl = DEFAULT_WEBHOOK_URL,
} = {}) {
  const sinceDate = full ? null : getDefaultSinceDate(days);
  const untilDate = new Date();
  const items = await fetchChangedInvoicesFromBitrix({ webhookUrl, sinceDate, untilDate });
  if (dryRun) return { total: items.length, inserted: 0, updated: 0, skipped: 0, errors: [], since: sinceDate?.toISOString() ?? null, until: untilDate.toISOString(), dryRun: true, snapshot: items };

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const item of items) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const res = await syncSingleInvoice(client, item);
      await client.query("COMMIT");
      if (res.status === "inserted") inserted++;
      else if (res.status === "updated") updated++;
      else skipped++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      errors.push({ invoiceId: item.id, error: err.message });
    } finally {
      client.release();
    }
  }

  return {
    total: items.length,
    inserted,
    updated,
    skipped,
    errors,
    since: sinceDate?.toISOString() ?? null,
    until: untilDate.toISOString(),
  };
}

/**
 * Локальный, повторно применимый full-import path из reviewed snapshot.
 * Обновляет B24-поля уже имеющихся счетов и добавляет отсутствующие реальные B24-счета.
 * Не удаляет локальные строки, отсутствующие в текущем B24 snapshot.
 * Не подменяет неизвестные поля выдуманными значениями.
 *
 * @param {string | Array<object> | object} snapshotSource путь к файлу снимка или уже распарсенные данные
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @param {import('pg').Pool} [options.clientPool=pool]
 * @returns {Promise<{ total: number, inserted: number, updated: number, skipped: number, errors: Array<object> }>}
 */
/**
 * Валидирует структуру снимка перед первой записью.
 * Проверяет непустые уникальные ID и обязательное поле updatedTime,
 * чтобы malformed snapshot не приводил к частичному импорту.
 * Поле stageId является nullable (может отсутствовать или быть null/пустым).
 * @param {Array<object>} items
 */
export function validateSnapshot(items, { allowEmpty = false } = {}) {
  if (!Array.isArray(items)) {
    throw new Error("Снимок должен быть массивом счетов");
  }
  if (items.length === 0) {
    if (!allowEmpty) {
      throw new Error("Снимок не содержит записей. Для применения пустого снимка требуется явное подтверждение (allowEmpty / --allow-empty)");
    }
    return true;
  }

  const seenIds = new Set();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Элемент #${i} не является корректным объектом`);
    }

    const invoiceId = toId(item.id);
    if (!invoiceId) {
      throw new Error(`Элемент #${i} не содержит обязательного непустого id`);
    }

    if (seenIds.has(invoiceId)) {
      throw new Error(`Обнаружен дубликат invoice_id ${invoiceId} на позиции #${i}`);
    }
    seenIds.add(invoiceId);

    const updatedTime = parseInstant(item.updatedTime);
    if (!updatedTime) {
      throw new Error(`Счет ${invoiceId} не содержит валидного поля updatedTime`);
    }
  }
  return true;
}

/**
 * Парсит аргументы командной строки импорта снимка B24.
 * Требует явного указания режима: либо --dry-run, либо --apply.
 * Поддерживает опциональный флаг подтверждения --allow-empty для пустого снимка.
 * Флаг --verified-complete удален: полнота проверяется исключительно live-запросом к B24.
 * @param {string[]} args
 * @returns {{ snapshotPath: string, dryRun: boolean, apply: boolean, allowEmpty: boolean }}
 */
export function parseCliArgs(args = process.argv.slice(2)) {
  let snapshotPath = null;
  let dryRun = false;
  let apply = false;
  let allowEmpty = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--snapshot" || arg === "-s") {
      i++;
      if (i >= args.length || args[i].startsWith("-")) {
        throw new Error("Не указан путь к файлу после аргумента --snapshot / -s");
      }
      snapshotPath = args[i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--allow-empty") {
      allowEmpty = true;
    } else {
      throw new Error(`Неизвестный аргумент командной строки: ${arg}`);
    }
  }

  if (!snapshotPath) {
    throw new Error("Обязательный аргумент --snapshot <path> не указан");
  }
  if (!dryRun && !apply) {
    throw new Error("Необходимо явно указать режим выполнения: --dry-run (без записи) или --apply (применение)");
  }
  if (dryRun && apply) {
    throw new Error("Аргументы --dry-run и --apply не могут использоваться одновременно");
  }

  return { snapshotPath, dryRun, apply, allowEmpty };
}

/**
 * Локальный, повторно применимый full-import path из reviewed snapshot.
 * Обновляет B24-поля уже имеющихся счетов и добавляет недостающие реальные B24-счета.
 * Перед любым деструктивным удалением или dry-run выполняет обязательную live-проверку
 * полноты снимка через verifySnapshotCompleteness (runtime double-pass consistency check B24).
 * Метаданные файлов/объектов (verifiedComplete, allowEmpty) строго игнорируются.
 * Флаг allowEmpty передается только оператором через CLI options.
 * До подтверждения полноты снимка удаление строго запрещено (fail-closed guard).
 * Сохраняет полный аудит в invoice_events.
 *
 * @param {string | Array<object> | object} snapshotSource путь к файлу снимка или уже распарсенные данные
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @param {import('pg').Pool} [options.clientPool=pool]
 * @param {boolean} [options.allowEmpty=false]
 * @param {string} [options.webhookUrl=DEFAULT_WEBHOOK_URL]
 * @param {Function} [options.request=callBitrix]
 * @returns {Promise<{ total: number, inserted: number, updated: number, skipped: number, deleted: number, errors: Array<object>, dryRun?: boolean, verifiedComplete?: boolean }>}
 */
export async function importInvoicesFromSnapshot(snapshotSource, {
  dryRun = false,
  clientPool = pool,
  allowEmpty = false,
  webhookUrl = DEFAULT_WEBHOOK_URL,
  request = callBitrix,
} = {}) {
  let items = [];

  if (typeof snapshotSource === "string") {
    const content = await readFile(snapshotSource, "utf-8");
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      items = parsed;
    } else if (Array.isArray(parsed.items)) {
      items = parsed.items;
    } else if (Array.isArray(parsed.result?.items)) {
      items = parsed.result.items;
    } else {
      throw new Error("Не удалось извлечь список счетов из snapshot-файла");
    }
  } else if (Array.isArray(snapshotSource)) {
    items = snapshotSource;
  } else if (snapshotSource && typeof snapshotSource === "object") {
    if (Array.isArray(snapshotSource.items)) {
      items = snapshotSource.items;
    } else if (Array.isArray(snapshotSource.result?.items)) {
      items = snapshotSource.result.items;
    } else {
      throw new Error("Некорректная структура объекта snapshot");
    }
  } else {
    throw new Error("Ожидался путь к файлу snapshot или массив счетов");
  }

  // Строгая валидация снимка ДО начала любых операций записи в БД
  validateSnapshot(items, { allowEmpty });

  // Обязательная live-проверка полноты снимка перед dry-run или деструктивным apply
  let verifiedComplete = false;
  const verifyRes = await verifySnapshotCompleteness(items, { webhookUrl, request });
  if (!verifyRes.verified) {
    throw new Error(`Проверка полноты снимка через B24 отклонена: ${verifyRes.reason}`);
  }
  verifiedComplete = true;

  const nullCounts = {
    deal_id: 0,
    client_id: 0,
    invoice_date: 0,
    check_in: 0,
    check_out: 0,
    nights: 0,
    tariff_code: 0,
    tariff_name: 0,
    room_type_name: 0,
    room_number: 0,
    amount: 0,
    paid_amount: 0,
    payment_1_amount: 0,
    payment_2_amount: 0,
    payment_3_amount: 0,
    b24_stage_id: 0,
  };

  for (const item of items) {
    const dealId = toId(item.parentId2) || toId(item.ufCrm_67925582298F8);
    if (!dealId) nullCounts.deal_id++;

    const clientId = toId(Array.isArray(item.contactIds) ? item.contactIds[0] : item.contactId);
    if (!clientId) nullCounts.client_id++;

    const invoiceDate = parseDate(item.begindate);
    if (!invoiceDate) nullCounts.invoice_date++;

    const checkIn =
      parseDate(item.ufCrm_6780C536C1950) ||
      parseDate(item.ufCrm_682C33DAF35B0) ||
      parseDate(item.ufCrm_1747709659) ||
      parseDate(item.ufCrm_1711464263870);
    if (!checkIn) nullCounts.check_in++;

    const checkOut =
      parseDate(item.ufCrm_6780C536C7240) ||
      parseDate(item.ufCrm_682C33DB2C6BD) ||
      parseDate(item.ufCrm_1747709682) ||
      parseDate(item.ufCrm_1711464284655);
    if (!checkOut) nullCounts.check_out++;

    const rawNights =
      item.ufCrm_682C33DB915F0 ??
      item.ufCrm_1747710789 ??
      item.ufCrm_1762501484 ??
      null;
    const parsedNights =
      rawNights !== null && rawNights !== "" && !Number.isNaN(Number(rawNights))
        ? Number(rawNights)
        : null;
    if (!parsedNights || parsedNights <= 0) nullCounts.nights++;

    const tariffCode =
      dimensionScalar(item.ufCrm_682C33DB6E4B8) ||
      dimensionScalar(item.ufCrm_67AB08D45B504) ||
      dimensionScalar(item.ufCrm_1770858300) ||
      dimensionScalar(item.ufCrm_SMART_INVOICE_1770859065);
    if (!tariffCode) nullCounts.tariff_code++;

    const tariffName =
      dimensionScalar(item.ufCrm_682C33DBD2DCF) ||
      dimensionScalar(item.ufCrm_6780C53BC5238) ||
      dimensionScalar(item.ufCrm_1747710844) ||
      dimensionScalar(item.ufCrm_682C33DBB0CF9);
    if (!tariffName) nullCounts.tariff_name++;

    const roomTypeName =
      dimensionScalar(item.ufCrm_679255819E7C1) ||
      dimensionScalar(item.ufCrm_1737443104642) ||
      dimensionScalar(item.ufCrm_6736FD0E36851);
    if (!roomTypeName) nullCounts.room_type_name++;

    const roomNumber =
      dimensionScalar(item.ufCrm_67925581C6B36) ||
      dimensionScalar(item.ufCrm_1737448035);
    if (!roomNumber) nullCounts.room_number++;

    const amount = parseAmount(item.opportunity);
    if (amount === null) nullCounts.amount++;

    const paymentAmounts = getPaymentAmounts(item);
    const paidAmount = paymentAmounts.paidAmount;
    if (paidAmount === null) nullCounts.paid_amount++;
    paymentAmounts.components.forEach((value, index) => {
      if (value === null) nullCounts[["payment_1_amount", "payment_2_amount", "payment_3_amount"][index]]++;
    });

    const b24StageId = dimensionScalar(item.stageId);
    if (!b24StageId) nullCounts.b24_stage_id++;
  }

  if (dryRun) {
    let estimatedInserts = 0;
    let estimatedUpdates = 0;
    let estimatedDeletes = 0;

    if (!clientPool || typeof clientPool.connect !== "function") {
      throw new Error("clientPool is required for dry-run preview");
    }

    let client = null;
    try {
      client = await clientPool.connect();
      // Строгая read-only транзакция: гарантирует отсутствие любых мутаций данных
      await client.query("BEGIN READ ONLY");
      const existingRes = await client.query("SELECT invoice_id FROM invoices");
      await client.query("ROLLBACK");

      const existingIds = new Set(existingRes.rows.map((r) => r.invoice_id));
      const snapshotIds = new Set(items.map((it) => toId(it.id)));

      for (const id of snapshotIds) {
        if (existingIds.has(id)) estimatedUpdates++;
        else estimatedInserts++;
      }
      for (const id of existingIds) {
        if (!snapshotIds.has(id)) estimatedDeletes++;
      }
    } catch (err) {
      if (client) {
        await client.query("ROLLBACK").catch(() => {});
      }
      throw new Error(`Ошибка dry-run при получении локального реестра: ${err.message}`);
    } finally {
      if (client) {
        client.release();
      }
    }

    return {
      total: items.length,
      inserted: 0,
      updated: 0,
      skipped: 0,
      deleted: 0,
      estimatedInserts,
      estimatedUpdates,
      estimatedDeletes,
      duplicateIdsCount: 0,
      errorsCount: 0,
      nullCounts,
      errors: [],
      dryRun: true,
      verifiedComplete: Boolean(verifiedComplete),
    };
  }

  // АТОМАРНЫЙ APPLY: единая транзакция на весь снимок
  const client = await clientPool.connect();
  try {
    await client.query("BEGIN");

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const snapshotIds = [];

    for (const item of items) {
      const res = await syncSingleInvoice(client, item);
      if (res.invoiceId) {
        snapshotIds.push(res.invoiceId);
      }
      if (res.status === "inserted") inserted++;
      else if (res.status === "updated") updated++;
      else skipped++;
    }

    // Удаляем из public.invoices счета, отсутствующие в полном снимке
    // До подтверждения полноты (verifiedComplete) удаление запрещено (fail-closed)
    let deleted = 0;
    if (snapshotIds.length > 0) {
      if (!verifiedComplete) {
        // Проверяем наличие отсутствующих счетов
        const checkRes = await client.query(
          `SELECT count(*)::int AS count FROM invoices WHERE invoice_id != ALL($1::text[])`,
          [snapshotIds]
        );
        const missingCount = checkRes.rows[0]?.count || 0;
        if (missingCount > 0) {
          throw new Error(`Удаление отсутствующих счетов (${missingCount}) отклонено: полнота снимка не подтверждена (verifiedComplete)`);
        }
      } else {
        const delRes = await client.query(
          `DELETE FROM invoices WHERE invoice_id != ALL($1::text[])`,
          [snapshotIds]
        );
        deleted = delRes.rowCount || 0;
      }
    } else if (items.length === 0 && allowEmpty) {
      if (!verifiedComplete) {
        const countRes = await client.query("SELECT count(*)::int AS count FROM invoices");
        const count = countRes.rows[0]?.count || 0;
        if (count > 0) {
          throw new Error(`Очистка реестра для пустого снимка (${count} счетов) отклонена: полнота снимка не подтверждена (verifiedComplete)`);
        }
      } else {
        const delRes = await client.query("DELETE FROM invoices");
        deleted = delRes.rowCount || 0;
      }
    }

    await client.query("COMMIT");

    return {
      total: items.length,
      inserted,
      updated,
      skipped,
      deleted,
      errors: [],
      verifiedComplete: Boolean(verifiedComplete),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Исполнитель CLI для импорта снимка с безопасной сводкой (без персональных данных).
 * @param {string[]} [args]
 * @param {object} [options]
 * @param {import('pg').Pool} [options.clientPool=pool]
 * @param {string} [options.webhookUrl=DEFAULT_WEBHOOK_URL]
 * @param {Function} [options.request=callBitrix]
 * @returns {Promise<number>} exit-код (0 при успехе, 1 при ошибках/сбоях)
 */
export async function runCli(args = process.argv.slice(2), {
  clientPool = pool,
  webhookUrl = DEFAULT_WEBHOOK_URL,
  request = callBitrix,
} = {}) {
  try {
    const { snapshotPath, dryRun, allowEmpty } = parseCliArgs(args);
    const result = await importInvoicesFromSnapshot(snapshotPath, {
      dryRun,
      clientPool,
      allowEmpty,
      webhookUrl,
      request,
    });

    const safeSummary = {
      total: result.total,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      deleted: result.deleted ?? 0,
      errorsCount: result.errors ? result.errors.length : 0,
      dryRun: Boolean(result.dryRun),
    };
    if (result.dryRun) {
      safeSummary.estimatedInserts = result.estimatedInserts;
      safeSummary.estimatedUpdates = result.estimatedUpdates;
      safeSummary.estimatedDeletes = result.estimatedDeletes;
      safeSummary.nullCounts = result.nullCounts;
    }

    console.log("Безопасная сводка импорта:", JSON.stringify(safeSummary, null, 2));

    if (result.errors && result.errors.length > 0) {
      console.error(`Импорт завершен с ошибками: ${result.errors.length} шт.`);
      return 1;
    }
    return 0;
  } catch (err) {
    console.error("Ошибка выполнения CLI:", err.message);
    return 1;
  }
}

// Запуск импорта снимка через CLI координатором: node invoiceSync.js --snapshot <path> (--dry-run | --apply)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch(() => {
      process.exit(1);
    });
}

