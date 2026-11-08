#!/usr/bin/env node

/**
 * Скрипт синхронизации счетов из Bitrix24 напрямую в PostgreSQL.
 * Использование:
 *   node scripts/sync-invoices.js [--days=2] [--status-file=<path>] [--dry-run]
 */

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appDir = resolve(__dirname, "..");
const repoDir = resolve(appDir, "../..");

// 1. Предварительная загрузка .env файла (если есть)
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

// 2. Настройка подключения к PostgreSQL по умолчанию для локального запуска/Cron
process.env.PGHOST = process.env.PGHOST || "127.0.0.1";
process.env.PGPORT = process.env.PGPORT || "5437";
process.env.PGDATABASE = process.env.PGDATABASE || "b24_calculations";
process.env.PGUSER = process.env.PGUSER || "b24_proxy";

if (!process.env.PGPASSWORD && !process.env.PGPASSWORD_FILE) {
  const candidateSecrets = [
    resolve(appDir, "../local/secrets/proxy_db_password"),
    resolve(repoDir, "PROXY/local/secrets/proxy_db_password"),
    resolve(repoDir, "postgres/secrets/proxy_db_password"),
  ];
  for (const sec of candidateSecrets) {
    if (existsSync(sec)) {
      process.env.PGPASSWORD_FILE = sec;
      break;
    }
  }
}

// 3. Динамический импорт модулей после инициализации переменных окружения
const { syncRecentInvoices } = await import("../services/invoiceSync.js");
const { pool } = await import("../services/requestStore.js");

async function writeStatusSafe(statusObj, customPath = null) {
  const payload = JSON.stringify(statusObj, null, 2);
  const targets = [
    "/tmp/b24-invoice-sync-status.json",
    resolve(appDir, "data/invoice-sync-status.json"),
  ];
  if (customPath) targets.unshift(customPath);

  for (const target of targets) {
    try {
      const dir = dirname(target);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(target, payload, "utf8");
    } catch {
      // запись статуса не должна ронять скрипт
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  let days = 2;
  const full = args.includes("--full");
  const dryRun = args.includes("--dry-run");
  const snapshotPath = args.find(arg => arg.startsWith("--snapshot="))?.slice("--snapshot=".length);
  const statusFilePath = args.find(arg => arg.startsWith("--status-file="))?.slice("--status-file=".length);

  if (full && (!snapshotPath || !isAbsolute(snapshotPath))) {
    throw new Error("Full dry-run requires absolute --snapshot path");
  }
  if (full && !dryRun) {
    throw new Error("Full import requires reviewed staging; use --full --dry-run");
  }

  for (const arg of args) {
    if (arg.startsWith("--days=")) {
      const parsed = Number.parseInt(arg.split("=")[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) days = parsed;
    }
  }

  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [InvoiceSync] Запуск синхронизации счетов за последние ${days} дн. (dryRun: ${dryRun}) ...`);
  const startTime = Date.now();

  try {
    const result = await syncRecentInvoices({ days, full, dryRun });
    if (dryRun && snapshotPath) {
      await writeFile(
        snapshotPath,
        JSON.stringify({ capturedAt: result.until, since: result.since, total: result.total, items: result.snapshot }),
        { flag: "wx", mode: 0o600 }
      );
    }
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`[InvoiceSync] Успешно завершено за ${duration}с`);
    console.log(`  Период с: ${result.since}`);
    console.log(`  Всего получено из Б24: ${result.total}`);
    console.log(`  Добавлено новых в БД: ${result.inserted}`);
    console.log(`  Обновлено существующих: ${result.updated}`);
    console.log(`  Пропущено (без ID): ${result.skipped}`);

    if (result.errors.length > 0) {
      console.error(`  Ошибок: ${result.errors.length}`);
      for (const err of result.errors.slice(0, 10)) {
        console.error(`    ID ${err.invoiceId}: ${err.error}`);
      }
      process.exitCode = 1;
    }

    if (!dryRun) {
      await writeStatusSafe({
        lastRunAt: new Date().toISOString(),
        status: result.errors.length > 0 ? "warning" : "healthy",
        durationSeconds: Number(duration),
        periodSince: result.since,
        periodUntil: result.until,
        days,
        total: result.total,
        inserted: result.inserted,
        updated: result.updated,
        skipped: result.skipped,
        errorsCount: result.errors.length,
        errors: result.errors.slice(0, 10),
      }, statusFilePath);
    }
  } catch (err) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error("[InvoiceSync] Критическая ошибка:", err);
    process.exitCode = 1;

    if (!dryRun) {
      await writeStatusSafe({
        lastRunAt: new Date().toISOString(),
        status: "error",
        durationSeconds: Number(duration),
        error: err?.message || String(err),
      }, statusFilePath);
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

await main();
