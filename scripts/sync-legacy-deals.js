#!/usr/bin/env node

/**
 * Скрипт прямой пакетной выгрузки исторических сделок из Bitrix24 (до 10.01.2025)
 * и бесшовной загрузки в таблицу public.invoices со статусом 'deal_legacy'.
 *
 * Использование:
 *   node scripts/sync-legacy-deals.js [--dry-run] [--apply]
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import pg from "pg";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appDir = resolve(__dirname, "..");
const repoDir = resolve(appDir, "../..");

// 1. Загрузка переменных окружения
if (typeof loadEnvFile === "function") {
  const envPath = resolve(appDir, ".env");
  if (existsSync(envPath)) {
    try {
      loadEnvFile(envPath);
    } catch {
      // игнорируем ошибку чтения .env
    }
  }
}

// 2. Настройка подключения к PostgreSQL
process.env.PGHOST = process.env.PGHOST || "127.0.0.1";
process.env.PGPORT = process.env.PGPORT || "5437";
process.env.PGDATABASE = process.env.PGDATABASE || "b24_calculations";
process.env.PGUSER = process.env.PGUSER || "b24_proxy";

function readPassword() {
  if (process.env.PGPASSWORD) return process.env.PGPASSWORD;
  const candidateSecrets = [
    resolve(appDir, "../local/secrets/proxy_db_password"),
    resolve(repoDir, "PROXY/local/secrets/proxy_db_password"),
    resolve(repoDir, "postgres/secrets/proxy_db_password"),
  ];
  for (const sec of candidateSecrets) {
    if (existsSync(sec)) {
      return readFileSync(sec, "utf8").trim();
    }
  }
  return undefined;
}

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: readPassword(),
  max: 5,
  statement_timeout: 30000,
});

const DEFAULT_WEBHOOK_URL = process.env.B24_WEBHOOK_URL || process.env.B24_WEBHOOK;
if (!DEFAULT_WEBHOOK_URL) {
  console.error("ОШИБКА: B24_WEBHOOK_URL не задан в .env");
  process.exit(1);
}

const ROOM_ENUM_MAP = {
  "128": { name: "Стандарт 2", weight: 1 },
  "130": { name: "Стандарт 2+1", weight: 1 },
  "132": { name: "Стандарт 2+2", weight: 1 },
  "134": { name: "Лесной 2+2", weight: 1 },
  "1000": { name: "Лесной 3+2", weight: 1 },
  "136": { name: "Шародом", weight: 1 },
  "138": { name: "Теремок", weight: 1 },
  "140": { name: "ДуВ 2+2", weight: 1 },
  "142": { name: "ДуВ 2+1", weight: 1 },
  "144": { name: "ДуВ 2+2", weight: 1 },
  "146": { name: "ДуВ весь", weight: 6 },
};

function parseDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const dmyMatch = text.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (dmyMatch) return `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;
  const d = new Date(text);
  if (Number.isNaN(d.valueOf())) return null;
  return d.toISOString().slice(0, 10);
}

function parseInstant(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? null : d;
}

function parseAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).replace(/[\s\u00a0]/g, "").replace(",", ".");
  const match = normalized.match(/^-?\d+(\.\d+)?/);
  return match ? match[0] : null;
}

async function fetchAllDealsBeforeCutoff(cutoffDate = "2025-01-10T00:00:00+03:00") {
  const base = DEFAULT_WEBHOOK_URL.endsWith("/") ? DEFAULT_WEBHOOK_URL : `${DEFAULT_WEBHOOK_URL}/`;
  const batchUrl = `${base}batch.json`;
  const allDeals = [];
  let offset = 0;
  let totalReported = null;

  console.log(`Запрос исторических сделок из Bitrix24 (< ${cutoffDate})...`);

  while (true) {
    const cmd = {};
    for (let i = 0; i < 50; i++) {
      const start = offset + i * 50;
      const params = new URLSearchParams();
      params.set("order[ID]", "ASC");
      params.set("filter[<DATE_CREATE]", cutoffDate);
      params.append("select[]", "*");
      params.append("select[]", "UF_*");
      params.set("start", String(start));
      cmd[`page${i}`] = `crm.deal.list?${params}`;
    }

    const t0 = Date.now();
    const res = await fetch(batchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ halt: 0, cmd }),
    });

    if (!res.ok) {
      throw new Error(`B24 batch HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    if (data.error) throw new Error(`B24 batch error: ${data.error}`);

    const batchRes = data.result?.result || {};
    const batchTotals = data.result?.result_total || {};
    const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

    let batchCount = 0;
    for (let i = 0; i < 50; i++) {
      const page = batchRes[`page${i}`] || [];
      batchCount += page.length;
      allDeals.push(...page);
      if (totalReported === null && batchTotals[`page${i}`] !== undefined) {
        totalReported = Number(batchTotals[`page${i}`]);
      }
    }

    console.log(`  Пакет со смещением ${offset}: получено ${batchCount} сделок за ${elapsedSec}s (всего накоплено: ${allDeals.length} из ${totalReported})`);

    if (batchCount < 2500 || allDeals.length >= (totalReported || Infinity)) {
      break;
    }
    offset += 2500;
  }

  return allDeals;
}

function normalizeDeal(deal) {
  const idStr = String(deal.ID).trim();
  const invoiceId = `deal:${idStr}`;
  const dealId = idStr;
  const clientId = deal.CONTACT_ID ? String(deal.CONTACT_ID).trim() : null;

  const invoiceDate = parseDate(deal.DATE_CREATE) || parseDate(deal.BEGINDATE);
  const checkIn = parseDate(deal.UF_CRM_1711464263870 || deal.BEGINDATE);
  const checkOut = parseDate(deal.UF_CRM_1711464284655 || deal.CLOSEDATE);

  let nights = null;
  if (deal.UF_CRM_1762501484 && !Number.isNaN(Number(deal.UF_CRM_1762501484))) {
    nights = Number(deal.UF_CRM_1762501484);
  } else if (checkIn && checkOut) {
    const diff = Math.round((new Date(checkOut) - new Date(checkIn)) / (24 * 60 * 60 * 1000));
    if (diff > 0 && diff <= 365) nights = diff;
  }

  // Определение типа размещения и комнаты
  const roomEnum = deal.UF_CRM_1710856160424 ? String(deal.UF_CRM_1710856160424) : null;
  const mappedRoom = roomEnum && ROOM_ENUM_MAP[roomEnum] ? ROOM_ENUM_MAP[roomEnum] : null;

  let roomTypeName = mappedRoom?.name || (deal.UF_CRM_1737443104642 ? String(deal.UF_CRM_1737443104642).trim() : null);
  const roomNumber = deal.UF_CRM_1737448035 ? String(deal.UF_CRM_1737448035).trim() : null;

  // Суммы и оплаты
  const voucherAmount = parseAmount(deal.UF_CRM_1711464453220);
  const oppAmount = parseAmount(deal.OPPORTUNITY);
  const amount = voucherAmount || oppAmount || "0";

  const isWon = deal.STAGE_SEMANTIC_ID === "S" || deal.STAGE_ID === "C14:WON" || deal.STAGE_ID === "WON";
  const isLose = deal.STAGE_SEMANTIC_ID === "F" || String(deal.STAGE_ID || "").includes("LOSE") || deal.STAGE_ID === "APOLOGY";

  const isCertificate = String(deal.TITLE || "").toLowerCase().includes("сертификат") && !roomEnum && Number(oppAmount || 0) === 0;

  let invoiceStatus = "active";
  if (isLose || isCertificate) {
    invoiceStatus = "cancelled";
  }

  let paymentStatus = "unpaid";
  let paidAmount = "0";

  const paymentNum = parseAmount(deal.UF_CRM_TBI_PAYMENT_AMOUNT_NUM || deal.UF_CRM_TBI_PAYMENT_AMOUNT);
  if (isWon) {
    paymentStatus = "paid";
    paidAmount = paymentNum || amount;
  } else if (invoiceStatus === "cancelled") {
    paymentStatus = "unpaid";
    paidAmount = "0";
  } else if (paymentNum) {
    paidAmount = paymentNum;
    const paidNum = Number(paymentNum);
    const totNum = Number(amount);
    if (paidNum >= totNum && totNum > 0) paymentStatus = "paid";
    else if (paidNum > 0) paymentStatus = "partial";
  }

  const tariffCode = deal.UF_CRM_1770858300 ? String(deal.UF_CRM_1770858300).trim() : (deal.UF_CRM_1730223188 ? String(deal.UF_CRM_1730223188).trim() : null);
  const tariffName = deal.UF_CRM_1747710844 ? String(deal.UF_CRM_1747710844).trim() : null;

  const version = parseInstant(deal.DATE_MODIFY || deal.DATE_CREATE) || new Date();
  const statusChangedAt = parseInstant(deal.MOVED_TIME || deal.DATE_MODIFY || deal.DATE_CREATE) || version;

  const rawHeaders = JSON.stringify(["ID", "TITLE", "STAGE_ID", "STAGE_SEMANTIC_ID", "OPPORTUNITY", "DATE_CREATE", "UF_CRM_1710856160424"]);
  const rawValues = JSON.stringify([
    deal.ID,
    deal.TITLE || "",
    deal.STAGE_ID || "",
    deal.STAGE_SEMANTIC_ID || "",
    deal.OPPORTUNITY || "",
    deal.DATE_CREATE || "",
    deal.UF_CRM_1710856160424 || ""
  ]);

  return {
    invoiceId,
    dealId,
    clientId,
    invoiceDate,
    checkIn,
    checkOut,
    nights,
    accommodation: roomTypeName,
    tariff: tariffName,
    amount,
    paidAmount,
    invoiceStatus,
    paymentStatus,
    statusBasis: "deal_legacy",
    statusChangedAt,
    sourceVersion: version,
    paymentVersion: version,
    invoiceVersion: version,
    factsVersion: version,
    tariffCode,
    tariffName,
    roomTypeName,
    roomNumber,
    invoiceStatusBasis: "deal_legacy",
    paymentStatusBasis: "deal_legacy",
    invoiceStatusChangedAt: statusChangedAt,
    paymentStatusChangedAt: statusChangedAt,
    invoiceStatusTimeBasis: "source_timestamp",
    paymentStatusTimeBasis: "source_timestamp",
    b24StageId: deal.STAGE_ID ? String(deal.STAGE_ID).trim() : null,
    rawHeaders,
    rawValues,
  };
}

async function main() {
  const isApply = process.argv.includes("--apply");
  const isDryRun = process.argv.includes("--dry-run") || !isApply;

  console.log(`=== Импорт исторических сделок Битрикс24 в PostgreSQL ===`);
  console.log(`Режим: ${isApply ? "ПРИМЕНЕНИЕ (--apply)" : "ТЕСТОВЫЙ ПРОГОН (--dry-run, транзакция с откатом)"}`);

  const deals = await fetchAllDealsBeforeCutoff();
  console.log(`Всего получено сделок: ${deals.length}`);

  const client = await pool.connect();

  try {
    await client.query("BEGIN;");

    // Исходное состояние
    const beforeStats = await client.query(`
      SELECT 
        count(*) as total_invoices,
        count(*) FILTER (WHERE status_basis = 'deal_legacy') as legacy_deals,
        count(*) FILTER (WHERE check_in = '2024-11-08' AND invoice_status = 'active') as nov8_active
      FROM public.invoices;
    `);
    console.log("Состояние БД до импорта:", beforeStats.rows[0]);

    let inserted = 0;
    let updated = 0;

    const upsertSql = `
      INSERT INTO public.invoices (
        invoice_id, deal_id, client_id, invoice_date, check_in, check_out, nights,
        accommodation, tariff, amount, paid_amount,
        invoice_status, payment_status, status_basis, status_changed_at,
        source_version, payment_version, invoice_version, facts_version, updated_at,
        tariff_code, tariff_name, room_type_name, room_number,
        invoice_status_basis, payment_status_basis,
        invoice_status_changed_at, payment_status_changed_at,
        invoice_status_time_basis, payment_status_time_basis,
        b24_stage_id, raw_headers, raw_values
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17, $18, $19, now(),
        $20, $21, $22, $23,
        $24, $25,
        $26, $27,
        $28, $29,
        $30, $31::jsonb, $32::jsonb
      )
      ON CONFLICT (invoice_id) DO UPDATE SET
        deal_id = EXCLUDED.deal_id,
        client_id = EXCLUDED.client_id,
        invoice_date = EXCLUDED.invoice_date,
        check_in = EXCLUDED.check_in,
        check_out = EXCLUDED.check_out,
        nights = EXCLUDED.nights,
        accommodation = EXCLUDED.accommodation,
        tariff = EXCLUDED.tariff,
        amount = EXCLUDED.amount,
        paid_amount = EXCLUDED.paid_amount,
        invoice_status = EXCLUDED.invoice_status,
        payment_status = EXCLUDED.payment_status,
        status_basis = EXCLUDED.status_basis,
        status_changed_at = EXCLUDED.status_changed_at,
        source_version = EXCLUDED.source_version,
        payment_version = EXCLUDED.payment_version,
        invoice_version = EXCLUDED.invoice_version,
        facts_version = EXCLUDED.facts_version,
        updated_at = now(),
        tariff_code = EXCLUDED.tariff_code,
        tariff_name = EXCLUDED.tariff_name,
        room_type_name = EXCLUDED.room_type_name,
        room_number = EXCLUDED.room_number,
        invoice_status_basis = EXCLUDED.invoice_status_basis,
        payment_status_basis = EXCLUDED.payment_status_basis,
        invoice_status_changed_at = EXCLUDED.invoice_status_changed_at,
        payment_status_changed_at = EXCLUDED.payment_status_changed_at,
        invoice_status_time_basis = EXCLUDED.invoice_status_time_basis,
        payment_status_time_basis = EXCLUDED.payment_status_time_basis,
        b24_stage_id = EXCLUDED.b24_stage_id,
        raw_headers = EXCLUDED.raw_headers,
        raw_values = EXCLUDED.raw_values
      RETURNING (xmax = 0) AS is_insert;
    `;

    for (const d of deals) {
      const row = normalizeDeal(d);
      const res = await client.query(upsertSql, [
        row.invoiceId,
        row.dealId,
        row.clientId,
        row.invoiceDate,
        row.checkIn,
        row.checkOut,
        row.nights,
        row.accommodation,
        row.tariff,
        row.amount,
        row.paidAmount,
        row.invoiceStatus,
        row.paymentStatus,
        row.statusBasis,
        row.statusChangedAt,
        row.sourceVersion,
        row.paymentVersion,
        row.invoiceVersion,
        row.factsVersion,
        row.tariffCode,
        row.tariffName,
        row.roomTypeName,
        row.roomNumber,
        row.invoiceStatusBasis,
        row.paymentStatusBasis,
        row.invoiceStatusChangedAt,
        row.paymentStatusChangedAt,
        row.invoiceStatusTimeBasis,
        row.paymentStatusTimeBasis,
        row.b24StageId,
        row.rawHeaders,
        row.rawValues,
      ]);

      if (res.rows[0]?.is_insert) {
        inserted++;
      } else {
        updated++;
      }
    }

    console.log(`Обработка завершена: вставлено новых ${inserted}, обновлено ${updated}`);

    // Проверка контрольных показателей внутри транзакции
    const afterStats = await client.query(`
      SELECT 
        count(*) as total_invoices,
        count(*) FILTER (WHERE status_basis = 'deal_legacy') as legacy_deals,
        count(*) FILTER (WHERE check_in = '2024-11-08' AND invoice_status = 'active') as nov8_active,
        count(*) FILTER (WHERE status_basis = 'deal_legacy' AND invoice_status = 'active') as active_deals,
        count(*) FILTER (WHERE status_basis = 'deal_legacy' AND invoice_status = 'cancelled') as cancelled_deals
      FROM public.invoices;
    `);
    console.log("Состояние БД после импорта (в транзакции):", afterStats.rows[0]);

    // Контрольная выборка по 08.11.2024
    const nov8Rows = await client.query(`
      SELECT invoice_id, deal_id, check_in, check_out, room_type_name, amount, invoice_status, payment_status
      FROM public.invoices
      WHERE check_in = '2024-11-08' AND invoice_status = 'active'
      ORDER BY invoice_id;
    `);
    console.log("Контрольная выборка заезда 08.11.2024 (активные):");
    console.table(nov8Rows.rows);

    if (isApply) {
      await client.query("COMMIT;");
      console.log("Транзакция успешно ЗАКОММИЧЕНА (--apply). Изменения сохранены.");
    } else {
      await client.query("ROLLBACK;");
      console.log("Транзакция успешно ОТКАТАНА (--dry-run). База данных не изменена.");
    }
  } catch (err) {
    await client.query("ROLLBACK;").catch(() => {});
    console.error("ОШИБКА транзакции:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

await main();

