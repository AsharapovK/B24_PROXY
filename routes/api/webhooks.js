import express from "express";
import {
  verifyWebhookToken,
  scheduleInvoiceSync,
  handleDealDelete,
  handleInvoiceDelete,
  getWebhookStatus,
} from "../../services/webhookSyncService.js";

const router = express.Router();

/**
 * Прием события изменения/создания счета из Бизнес-процесса Битрикс24.
 * POST /api/webhook/b24-invoice
 */
router.post("/b24-invoice", (req, res) => {
  if (!verifyWebhookToken(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const rawId = req.body?.id || req.query?.id || req.body?.data?.FIELDS?.ID;
  if (!rawId) {
    return res.status(400).json({ ok: false, error: "Missing invoice ID" });
  }

  const invoiceId = String(rawId).trim();
  res.status(200).json({ ok: true, queued: invoiceId });

  // Постановка в очередь с debounce
  scheduleInvoiceSync(invoiceId);
});

/**
 * Прием события удаления сделки (ONCRMDEALDELETE).
 * POST /api/webhook/b24-deal-delete
 */
router.post("/b24-deal-delete", (req, res) => {
  if (!verifyWebhookToken(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const rawDealId = req.body?.data?.FIELDS?.ID || req.body?.id || req.query?.id;
  if (!rawDealId) {
    return res.status(400).json({ ok: false, error: "Missing deal ID" });
  }

  const dealId = String(rawDealId).trim();
  res.status(200).json({ ok: true, dealId });

  // Асинхронная деактивация всех счетов сделки (Soft Delete)
  handleDealDelete(dealId).catch((err) => {
    console.error(`[WebhookSync] Ошибка Soft Delete для сделки ${dealId}:`, err?.message || err);
  });
});

/**
 * Прием события удаления счета (ONCRMDYNAMICITEMDELETE / ONCRMDYNAMICITEMDELETE_31).
 * POST /api/webhook/b24-invoice-delete
 */
router.post("/b24-invoice-delete", (req, res) => {
  if (!verifyWebhookToken(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const entityTypeId = req.body?.data?.FIELDS?.ENTITY_TYPE_ID;
  if (entityTypeId !== undefined && entityTypeId !== null && String(entityTypeId) !== "31") {
    return res.status(200).json({ ok: true, ignored: true, reason: "Not a smart invoice" });
  }

  const rawInvoiceId = req.body?.data?.FIELDS?.ID || req.body?.id || req.query?.id;
  if (!rawInvoiceId) {
    return res.status(400).json({ ok: false, error: "Missing invoice ID" });
  }

  const invoiceId = String(rawInvoiceId).trim();
  res.status(200).json({ ok: true, invoiceId });

  // Асинхронная деактивация счета (Soft Delete)
  handleInvoiceDelete(invoiceId).catch((err) => {
    console.error(`[WebhookSync] Ошибка Soft Delete для счета ${invoiceId}:`, err?.message || err);
  });
});

/**
 * Статистика работы вебхук-обработчика.
 * GET /api/webhook/status
 */
router.get("/status", (_req, res) => {
  res.status(200).json({ ok: true, ...getWebhookStatus() });
});

export default router;
