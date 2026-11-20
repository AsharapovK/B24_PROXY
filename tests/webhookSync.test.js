import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.NO_LOAD_ENV = "1";

const {
  verifyWebhookToken,
  scheduleInvoiceSync,
  getWebhookStatus,
  clearPendingSyncs,
  resetWebhookStatus,
} = await import("../services/webhookSyncService.js");

const {
  syncSingleInvoice,
  syncSingleInvoiceById,
  syncInvoicesBatch,
  handleDealDelete,
  handleInvoiceDelete,
} = await import("../services/invoiceSync.js");

// Mock DB Client for testing SQL calls
function createMockClient(initialInvoices = []) {
  const invoices = new Map(initialInvoices.map((inv) => [String(inv.invoice_id), { ...inv }]));
  const events = [];
  const log = [];

  return {
    invoices,
    events,
    log,
    query: async (sql, params = []) => {
      log.push({ sql, params });

      if (sql.startsWith("BEGIN") || sql.startsWith("COMMIT") || sql.startsWith("ROLLBACK")) {
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes("pg_advisory_xact_lock")) {
        return { rowCount: 1, rows: [{ acquired: true }] };
      }

      if (sql.includes("SELECT * FROM invoices WHERE invoice_id=$1 FOR UPDATE")) {
        const id = String(params[0]);
        const found = invoices.get(id);
        return { rowCount: found ? 1 : 0, rows: found ? [{ ...found }] : [] };
      }

      if (sql.includes("SELECT occurred_at, payload FROM invoice_events")) {
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes("WITH room_type AS")) {
        return { rowCount: 1, rows: [{ room_type_id: "rt-1", room_id: "r-1" }] };
      }

      if (sql.includes("INSERT INTO invoices")) {
        const invoiceId = String(params[0]);
        const invoiceStatus = params[11];
        const statusBasis = params[13];
        const existing = invoices.get(invoiceId);

        // Handle ON CONFLICT DO UPDATE
        const updatedInvoice = {
          invoice_id: invoiceId,
          deal_id: params[1],
          client_id: params[2],
          amount: params[9],
          paid_amount: params[10],
          invoice_status: existing ? (params[36] ? invoiceStatus : existing.invoice_status) : invoiceStatus,
          status_basis: existing ? (params[36] || params[37] ? statusBasis : existing.status_basis) : statusBasis,
          facts_version: params[18],
          invoice_version: params[17],
          payment_version: params[16],
          updated_at: new Date(),
        };
        invoices.set(invoiceId, updatedInvoice);
        return { rowCount: 1, rows: [updatedInvoice] };
      }

      if (sql.includes("invoice_events")) {
        events.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }

      // Soft delete for deal
      if (sql.includes("UPDATE public.invoices") && sql.includes("WHERE deal_id = $1")) {
        const dealId = String(params[0]);
        const affected = [];
        for (const [id, inv] of invoices.entries()) {
          if (String(inv.deal_id) === dealId && inv.invoice_status === "active") {
            inv.invoice_status = "cancelled";
            inv.status_basis = "b24_deal_deleted";
            inv.invoice_status_basis = "b24_deal_deleted";
            affected.push({ invoice_id: id });
          }
        }
        return { rowCount: affected.length, rows: affected };
      }

      // Soft delete for invoice
      if (sql.includes("UPDATE public.invoices") && sql.includes("WHERE invoice_id = $1")) {
        const invoiceId = String(params[0]);
        const affected = [];
        const inv = invoices.get(invoiceId);
        if (inv && inv.invoice_status === "active") {
          inv.invoice_status = "cancelled";
          inv.status_basis = "b24_invoice_deleted";
          inv.invoice_status_basis = "b24_invoice_deleted";
          affected.push({ invoice_id: invoiceId });
        }
        return { rowCount: affected.length, rows: affected };
      }

      return { rowCount: 0, rows: [] };
    },
    release: () => {},
  };
}

function createMockPool(initialInvoices = []) {
  const client = createMockClient(initialInvoices);
  return {
    client,
    connect: async () => client,
  };
}

test("verifyWebhookToken validates application_token, query token, and header", () => {
  const secret = "secret_token_12345";

  // Match via body auth.application_token
  const reqBody = { body: { auth: { application_token: secret } } };
  assert.equal(verifyWebhookToken(reqBody, secret), true);

  // Match via query
  const reqQuery = { body: {}, query: { token: secret } };
  assert.equal(verifyWebhookToken(reqQuery, secret), true);

  // Match via header
  const reqHeader = { body: {}, headers: { "x-webhook-token": secret } };
  assert.equal(verifyWebhookToken(reqHeader, secret), true);

  // Invalid token
  const reqInvalid = { body: { auth: { application_token: "wrong" } } };
  assert.equal(verifyWebhookToken(reqInvalid, secret), false);

  // Missing token
  const reqMissing = { body: {} };
  assert.equal(verifyWebhookToken(reqMissing, secret), false);
});

test("verifyWebhookToken resolves token from B24_WEBHOOK_APP_TOKEN_FILE", async () => {
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");

  const tmpFile = path.join(os.tmpdir(), `test_token_${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, "file_secret_999\n", "utf8");

  try {
    process.env.B24_WEBHOOK_APP_TOKEN_FILE = tmpFile;
    const req = { body: { auth: { application_token: "file_secret_999" } } };
    assert.equal(verifyWebhookToken(req), true);

    const reqWrong = { body: { auth: { application_token: "wrong_val" } } };
    assert.equal(verifyWebhookToken(reqWrong), false);
  } finally {
    delete process.env.B24_WEBHOOK_APP_TOKEN_FILE;
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test("scheduleInvoiceSync debounces rapid calls and batches distinct IDs into a single sync call", async () => {
  resetWebhookStatus();
  const batchCalls = [];
  const mockBatchFn = async (ids) => {
    batchCalls.push([...ids]);
    return { total: ids.length, inserted: 0, updated: ids.length, skipped: 0, errors: [] };
  };

  // Trigger 4 rapid updates for invoice 555 within 50 ms
  scheduleInvoiceSync("555", { debounceMs: 60, syncBatchFn: mockBatchFn });
  scheduleInvoiceSync("555", { debounceMs: 60, syncBatchFn: mockBatchFn });
  scheduleInvoiceSync("555", { debounceMs: 60, syncBatchFn: mockBatchFn });
  scheduleInvoiceSync("555", { debounceMs: 60, syncBatchFn: mockBatchFn });

  // And 1 update for invoice 777
  scheduleInvoiceSync("777", { debounceMs: 60, syncBatchFn: mockBatchFn });

  const statusBefore = getWebhookStatus();
  assert.equal(statusBefore.webhookCountSinceReset, 5);
  assert.equal(statusBefore.pendingCount, 2);

  // Wait for debounce timeout
  await new Promise((r) => setTimeout(r, 120));

  // Should have been called EXACTLY ONCE with both distinct IDs ["555", "777"]
  assert.equal(batchCalls.length, 1);
  assert.deepEqual(batchCalls[0].sort(), ["555", "777"]);
  assert.equal(getWebhookStatus().pendingCount, 0);

  clearPendingSyncs();
});

test("syncInvoicesBatch executes batch request to Bitrix24 when multiple IDs are provided", async () => {
  const pool = createMockPool([]);
  const mockB24Item1 = { id: "501", parentId2: "D1", stageId: "DT31_2:N", updatedTime: "2026-11-20T14:00:00Z", opportunity: "10000" };
  const mockB24Item2 = { id: "502", parentId2: "D2", stageId: "DT31_2:N", updatedTime: "2026-11-20T14:00:00Z", opportunity: "20000" };

  let batchCalled = false;
  const mockRequest = async (url, method, params) => {
    assert.equal(method, "batch");
    batchCalled = true;
    assert.ok(params.cmd.get_501);
    assert.ok(params.cmd.get_502);
    return {
      result: {
        result: {
          get_501: { item: mockB24Item1 },
          get_502: { item: mockB24Item2 },
        },
        result_error: {},
      },
    };
  };

  const res = await syncInvoicesBatch(["501", "502"], {
    webhookUrl: "https://b24.test.invalid/",
    clientPool: pool,
    request: mockRequest,
  });

  assert.equal(batchCalled, true);
  assert.equal(res.total, 2);
  assert.equal(res.inserted, 2);
  assert.equal(res.errors.length, 0);
  assert.equal(pool.client.invoices.get("501").amount, "10000");
  assert.equal(pool.client.invoices.get("502").amount, "20000");
});

test("handleDealDelete sets active invoices of deal to cancelled (Soft Delete) and logs audit events", async () => {
  const pool = createMockPool([
    { invoice_id: "101", deal_id: "D1", invoice_status: "active", status_basis: "b24_sync" },
    { invoice_id: "102", deal_id: "D1", invoice_status: "active", status_basis: "b24_sync" },
    { invoice_id: "103", deal_id: "D2", invoice_status: "active", status_basis: "b24_sync" },
  ]);

  const res = await handleDealDelete("D1", { clientPool: pool });

  assert.equal(res.dealId, "D1");
  assert.equal(res.affected, 2);
  assert.deepEqual(res.invoiceIds.sort(), ["101", "102"]);

  assert.equal(pool.client.invoices.get("101").invoice_status, "cancelled");
  assert.equal(pool.client.invoices.get("101").status_basis, "b24_deal_deleted");

  assert.equal(pool.client.invoices.get("102").invoice_status, "cancelled");
  assert.equal(pool.client.invoices.get("102").status_basis, "b24_deal_deleted");

  // Unrelated deal D2 remains active
  assert.equal(pool.client.invoices.get("103").invoice_status, "active");

  // Audit events recorded with source_type = 'deal_deletion'
  assert.equal(pool.client.events.length, 2);
  assert.ok(pool.client.events[0].sql.includes("'deal_deletion'"));
  assert.ok(pool.client.events[0].params[1].startsWith("deal_deletion:D1:"));
});

test("handleInvoiceDelete sets invoice to cancelled (Soft Delete) and logs audit event", async () => {
  const pool = createMockPool([
    { invoice_id: "201", deal_id: "D9", invoice_status: "active", status_basis: "b24_sync" },
  ]);

  const res = await handleInvoiceDelete("201", { clientPool: pool });

  assert.equal(res.invoiceId, "201");
  assert.equal(res.affected, 1);
  assert.equal(pool.client.invoices.get("201").invoice_status, "cancelled");
  assert.equal(pool.client.invoices.get("201").status_basis, "b24_invoice_deleted");

  assert.equal(pool.client.events.length, 1);
  assert.ok(pool.client.events[0].sql.includes("'invoice_deletion'"));
  assert.ok(pool.client.events[0].params[1].startsWith("invoice_deletion:201:"));
});

test("syncSingleInvoice does NOT overwrite cancelled status when status_basis is b24_deal_deleted", async () => {
  const pool = createMockPool([
    {
      invoice_id: "301",
      deal_id: "D1",
      invoice_status: "cancelled",
      status_basis: "b24_deal_deleted",
      invoice_status_basis: "b24_deal_deleted",
      facts_version: new Date("2026-11-01T10:00:00Z"),
      invoice_version: new Date("2026-11-01T10:00:00Z"),
      payment_version: new Date("2026-11-01T10:00:00Z"),
    },
  ]);

  // Incoming B24 item with newer timestamp and stageId = active
  const item = {
    id: "301",
    parentId2: "D1",
    updatedTime: "2026-11-20T12:00:00Z",
    stageId: "DT31_2:N", // active stage
    opportunity: "15000",
  };

  const client = await pool.connect();
  const res = await syncSingleInvoice(client, item);

  // The record was updated with facts, but invoice_status remains cancelled!
  assert.equal(pool.client.invoices.get("301").invoice_status, "cancelled");
  assert.equal(pool.client.invoices.get("301").status_basis, "b24_deal_deleted");
});

test("syncSingleInvoiceById fetches single item via crm.item.get and synchronizes with sourceType webhook_push", async () => {
  const pool = createMockPool([]);
  const mockB24Item = {
    id: "401",
    parentId2: "D10",
    stageId: "DT31_2:N",
    updatedTime: "2026-11-20T14:00:00Z",
    opportunity: "25000",
  };

  const mockRequest = async (url, method, params) => {
    assert.equal(method, "crm.item.get");
    assert.equal(params.entityTypeId, 31);
    assert.equal(params.id, "401");
    return { result: { item: mockB24Item } };
  };

  const res = await syncSingleInvoiceById("401", {
    webhookUrl: "https://b24.test.invalid/",
    clientPool: pool,
    request: mockRequest,
  });

  assert.equal(res.invoiceId, "401");
  assert.equal(res.status, "inserted");
  assert.equal(pool.client.invoices.get("401").amount, "25000");
  assert.equal(pool.client.events[0].params[15], "webhook_push");
});

test("Express webhook router handles /b24-invoice, /b24-deal-delete, /b24-invoice-delete and /status", async () => {
  const express = (await import("express")).default;
  const webhooksRouter = (await import("../routes/api/webhooks.js")).default;

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/api/webhook", webhooksRouter);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/webhook`;

  process.env.B24_WEBHOOK_APP_TOKEN = "test_token_xyz";

  try {
    // 1. Unauthorized request
    const unauthRes = await fetch(`${baseUrl}/b24-invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "100" }),
    });
    assert.equal(unauthRes.status, 401);

    // 2. Successful /b24-invoice with token in query
    const invoiceRes = await fetch(`${baseUrl}/b24-invoice?token=test_token_xyz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "999" }),
    });
    assert.equal(invoiceRes.status, 200);
    const invoiceBody = await invoiceRes.json();
    assert.equal(invoiceBody.ok, true);
    assert.equal(invoiceBody.queued, "999");

    // 3. Successful /b24-deal-delete with token in header
    const dealRes = await fetch(`${baseUrl}/b24-deal-delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-token": "test_token_xyz",
      },
      body: JSON.stringify({ data: { FIELDS: { ID: "5555" } } }),
    });
    assert.equal(dealRes.status, 200);
    const dealBody = await dealRes.json();
    assert.equal(dealBody.ok, true);
    assert.equal(dealBody.dealId, "5555");

    // 4. Successful /b24-invoice-delete with auth.application_token
    const invDelRes = await fetch(`${baseUrl}/b24-invoice-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth: { application_token: "test_token_xyz" },
        data: { FIELDS: { ID: "888", ENTITY_TYPE_ID: 31 } },
      }),
    });
    assert.equal(invDelRes.status, 200);
    const invDelBody = await invDelRes.json();
    assert.equal(invDelBody.ok, true);
    assert.equal(invDelBody.invoiceId, "888");

    // 5. Ignored non-31 entity in /b24-invoice-delete
    const nonSmartRes = await fetch(`${baseUrl}/b24-invoice-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth: { application_token: "test_token_xyz" },
        data: { FIELDS: { ID: "888", ENTITY_TYPE_ID: 2 } }, // Deal or Contact, not Smart Invoice
      }),
    });
    assert.equal(nonSmartRes.status, 200);
    const nonSmartBody = await nonSmartRes.json();
    assert.equal(nonSmartBody.ok, true);
    assert.equal(nonSmartBody.ignored, true);

    // 6. Status check
    const statusRes = await fetch(`${baseUrl}/status`);
    assert.equal(statusRes.status, 200);
    const statusBody = await statusRes.json();
    assert.equal(statusBody.ok, true);
    assert.equal(typeof statusBody.lastWebhookAt, "string");
  } finally {
    delete process.env.B24_WEBHOOK_APP_TOKEN;
    clearPendingSyncs();
    server.close();
  }
});
