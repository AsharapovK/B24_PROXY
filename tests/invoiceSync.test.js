import process from "node:process";
import assert from "node:assert/strict";
import test from "node:test";

// Ensure .env is NEVER opened or read during tests:
// Must be set and stubbed BEFORE dynamic import of invoiceSync.js is evaluated
process.env.NODE_ENV = "test";
process.env.NO_LOAD_ENV = "1";
let loadEnvFileCalled = false;
if (typeof process.loadEnvFile === "function") {
  process.loadEnvFile = () => {
    loadEnvFileCalled = true;
    throw new Error("SECURITY VIOLATION: process.loadEnvFile was called in test mode!");
  };
}

const {
  fetchChangedInvoicesFromBitrix,
  verifySnapshotCompleteness,
  getDefaultSinceDate,
  validateSnapshot,
  parseCliArgs,
  importInvoicesFromSnapshot,
  runCli,
  syncSingleInvoice,
} = await import("../services/invoiceSync.js");

function createMockB24Request(items = []) {
  return async (_url, method, params) => {
    if (method === "batch") {
      const total = items.length;
      const pages = {};
      const resultTotal = {};
      const resultNext = {};

      for (let i = 0; i < 50; i++) {
        const cmdKey = `page${i}`;
        const cmdStr = params?.cmd?.[cmdKey] || "";
        const match = cmdStr.match(/start=(\d+)/);
        const start = match ? parseInt(match[1], 10) : i * 50;
        const pageItems = items.slice(start, start + 50).map((it) => ({
          id: it.id,
          updatedTime: it.updatedTime || "2026-01-01T00:00:00Z",
          stageId: it.stageId !== undefined ? it.stageId : "DT31_2:N",
          ...it,
        }));

        pages[cmdKey] = { items: pageItems };
        resultTotal[cmdKey] = total;

        if (start + pageItems.length < total) {
          resultNext[cmdKey] = start + 50;
        }
      }

      return {
        result: {
          result: pages,
          result_error: {},
          result_total: resultTotal,
          result_next: resultNext,
        },
      };
    }
    throw new Error(`Unexpected B24 method ${method}`);
  };
}

test("isolation proof: .env was never loaded and loadEnvFile was never invoked", () => {
  assert.equal(loadEnvFileCalled, false);
});

test("default window starts at Moscow midnight", () => {
  const date = getDefaultSinceDate(2);
  assert.equal(date.getUTCHours(), 21);
});

test("full snapshot without untilDate fetches all items without updatedTime filter", async () => {
  const calls = [];
  const mockReq = createMockB24Request([{ id: 1, updatedTime: "2026-01-01T00:00:00Z" }]);
  const items = await fetchChangedInvoicesFromBitrix({
    webhookUrl: "https://example.invalid/",
    sinceDate: null,
    untilDate: null, // full snapshot mode: no cutoff by updatedTime
    request: async (url, method, params) => {
      calls.push(params);
      return mockReq(url, method, params);
    },
  });
  assert.equal(items.length, 1);
  const query = new URLSearchParams(calls[0].cmd.page0.split("?")[1]);
  assert.equal(query.has("filter[<=updatedTime]"), false, "Full snapshot must NOT filter by <=updatedTime");
  assert.equal(query.has("filter[>=updatedTime]"), false, "Full snapshot must NOT filter by >=updatedTime");
});

test("verifyConsistency detects shift or mutation of items between pagination passes", async () => {
  let pass = 0;
  const mockPass1 = createMockB24Request([{ id: 1, updatedTime: "2026-01-01T00:00:00Z" }]);
  const mockPass2 = createMockB24Request([
    { id: 1, updatedTime: "2026-01-01T00:00:00Z" },
    { id: 2, updatedTime: "2026-01-01T00:00:00Z" },
  ]);
  // Discrepancy test: pass 1 has 1 item, pass 2 has 2 items (data changed during fetch)
  await assert.rejects(
    fetchChangedInvoicesFromBitrix({
      webhookUrl: "https://example.invalid/",
      sinceDate: null,
      untilDate: null,
      verifyConsistency: true,
      request: async (url, method, params) => {
        pass++;
        return pass === 1 ? mockPass1(url, method, params) : mockPass2(url, method, params);
      },
    }),
    /Snapshot consistency verification failed/
  );

  // Consistent test: both passes return identical items
  let passCount = 0;
  const mockConsistent = createMockB24Request([{ id: 1, updatedTime: "2026-01-01T00:00:00Z" }]);
  const items = await fetchChangedInvoicesFromBitrix({
    webhookUrl: "https://example.invalid/",
    sinceDate: null,
    untilDate: null,
    verifyConsistency: true,
    request: async (url, method, params) => {
      passCount++;
      return mockConsistent(url, method, params);
    },
  });
  assert.equal(passCount, 2, "Must perform 2 passes for verification");
  assert.equal(items.length, 1, "Must return items after consistent passes");
});

test("verifySnapshotCompleteness verifies matching vs differing snapshots", async () => {
  const snapshot = [
    { id: "1", updatedTime: "2026-01-01T00:00:00Z" },
    { id: "2", updatedTime: "2026-01-02T00:00:00Z" },
  ];

  // Matching B24 response
  const matchRes = await verifySnapshotCompleteness(snapshot, {
    webhookUrl: "https://example.invalid/",
    request: createMockB24Request([
      { id: 1, updatedTime: "2026-01-01T00:00:00Z" },
      { id: 2, updatedTime: "2026-01-02T00:00:00Z" },
    ]),
  });
  assert.equal(matchRes.verified, true);
  assert.equal(matchRes.count, 2);

  // Mismatch in count
  const mismatchRes = await verifySnapshotCompleteness(snapshot, {
    webhookUrl: "https://example.invalid/",
    request: createMockB24Request([{ id: 1, updatedTime: "2026-01-01T00:00:00Z" }]),
  });
  assert.equal(mismatchRes.verified, false);
  assert.match(mismatchRes.reason, /не совпадает/);
});

test("batch reads 50 pages, preserves ordering and freezes upper boundary", async () => {
  const calls = [];
  const untilDate = new Date("2026-01-01T00:00:00Z");
  const items2501 = Array.from({ length: 2501 }, (_, i) => ({ id: i + 1, updatedTime: "2026-01-01T00:00:00Z" }));
  const mockReq = createMockB24Request(items2501);
  const items = await fetchChangedInvoicesFromBitrix({
    webhookUrl: "https://example.invalid/",
    sinceDate: null,
    untilDate,
    request: async (url, method, params) => {
      assert.equal(method, "batch");
      calls.push(params);
      return mockReq(url, method, params);
    },
  });
  assert.equal(items.length, 2501);
  assert.equal(Object.keys(calls[0].cmd).length, 50);
  const query = new URLSearchParams(calls[1].cmd.page0.split("?")[1]);
  assert.equal(query.get("start"), "2500");
  assert.equal(query.get("filter[<=updatedTime]"), untilDate.toISOString());
  assert.equal(query.has("filter[>=updatedTime]"), false);
});

test("incomplete or unordered responses fail instead of silently dropping pages", async () => {
  await assert.rejects(
    fetchChangedInvoicesFromBitrix({ webhookUrl: "https://example.invalid/", sinceDate: null, request: async () => ({ result: {} }) }),
    /Invalid/
  );
  await assert.rejects(
    fetchChangedInvoicesFromBitrix({
      webhookUrl: "https://example.invalid/",
      sinceDate: null,
      request: async () => ({ result: { result: {}, result_error: { page1: { error: "failed" } } } }),
    }),
    /command failed/
  );
  const pages = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`page${i}`, { items: i === 0 ? [{ id: 3 }, { id: 2 }] : [] }]));
  const resultTotal = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`page${i}`, 2]));
  await assert.rejects(
    fetchChangedInvoicesFromBitrix({
      webhookUrl: "https://example.invalid/",
      sinceDate: null,
      request: async () => ({
        result: {
          result: pages,
          result_error: {},
          result_total: resultTotal,
          result_next: {},
        },
      }),
    }),
    /unordered/
  );
});

test("validateSnapshot checks structure, unique non-empty IDs, and mandatory fields (stageId is nullable)", () => {
  assert.throws(() => validateSnapshot(null), /массивом/);
  assert.throws(() => validateSnapshot([]), /не содержит записей/);
  // Empty snapshot with allowEmpty passes
  assert.doesNotThrow(() => validateSnapshot([], { allowEmpty: true }));
  assert.throws(() => validateSnapshot(["not-an-object"]), /не является корректным объектом/);
  assert.throws(() => validateSnapshot([{ id: null }]), /не содержит обязательного непустого id/);
  assert.throws(
    () =>
      validateSnapshot([
        { id: "1", updatedTime: "2026-01-01T00:00:00Z", stageId: "DT31_2:N" },
        { id: "1", updatedTime: "2026-01-01T00:00:00Z", stageId: "DT31_2:N" },
      ]),
    /дубликат invoice_id 1/i
  );
  assert.throws(
    () => validateSnapshot([{ id: "1", updatedTime: "not-a-date", stageId: "DT31_2:N" }]),
    /не содержит валидного поля updatedTime/
  );

  // stageId can be empty string, null, or undefined:
  assert.doesNotThrow(() => validateSnapshot([{ id: "1", updatedTime: "2026-01-01T00:00:00Z", stageId: "" }]));
  assert.doesNotThrow(() => validateSnapshot([{ id: "1", updatedTime: "2026-01-01T00:00:00Z", stageId: null }]));
  assert.doesNotThrow(() => validateSnapshot([{ id: "1", updatedTime: "2026-01-01T00:00:00Z" }]));

  // Valid snapshot passes
  assert.doesNotThrow(() =>
    validateSnapshot([
      { id: "1", updatedTime: "2026-01-01T00:00:00Z", stageId: "DT31_2:N" },
      { id: "2", updatedTime: "2026-01-01T00:00:00Z", stageId: "DT31_2:P" },
    ])
  );
});

test("parseCliArgs enforces explicit --dry-run vs --apply, allows --allow-empty, and rejects --verified-complete", () => {
  // Valid dry-run
  const dry = parseCliArgs(["--snapshot", "snap.json", "--dry-run"]);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.snapshotPath, "snap.json");
  assert.equal(dry.allowEmpty, false);

  // Valid apply with flags
  const apply = parseCliArgs([
    "--snapshot", "snap.json",
    "--apply",
    "--allow-empty",
  ]);
  assert.equal(apply.dryRun, false);
  assert.equal(apply.apply, true);
  assert.equal(apply.allowEmpty, true);
  assert.equal(apply.snapshotPath, "snap.json");

  // Rejection of --verified-complete (operator cannot manually bypass live verification)
  assert.throws(
    () => parseCliArgs(["--snapshot", "snap.json", "--apply", "--verified-complete"]),
    /Неизвестный аргумент командной строки: --verified-complete/
  );

  // Conflict
  assert.throws(() => parseCliArgs(["--snapshot", "snap.json", "--dry-run", "--apply"]), /не могут использоваться одновременно/);

  // Unknown arg
  assert.throws(() => parseCliArgs(["--snapshot", "snap.json", "--unknown"]), /Неизвестный аргумент/);

  // Missing mode
  assert.throws(() => parseCliArgs(["--snapshot", "snap.json"]), /Необходимо явно указать режим/);

  // Missing snapshot path
  assert.throws(() => parseCliArgs(["--dry-run"]), /аргумент --snapshot/);
});

test("dry-run executes read-only transaction (BEGIN READ ONLY / ROLLBACK), performs zero DML, verifies B24 freshness, and fails closed on DB error", async () => {
  const items = [
    { id: "201", updatedTime: "2026-05-01T10:00:00Z", stageId: "DT31_2:P", opportunity: "50000" },
    { id: "202", updatedTime: "2026-05-01T11:00:00Z", stageId: "DT31_2:N" }, // missing amount, room_number, etc.
  ];

  const pool = createMockTransactionalPool([
    { invoice_id: "201", amount: "40000" },
    { invoice_id: "203", amount: "30000" },
  ]);

  const mockRequest = createMockB24Request(items);
  const res = await importInvoicesFromSnapshot(items, {
    dryRun: true,
    clientPool: pool,
    request: mockRequest,
  });
  assert.equal(res.dryRun, true);
  assert.equal(res.total, 2);
  assert.equal(res.inserted, 0);
  assert.equal(res.updated, 0);
  assert.equal(res.deleted, 0);
  assert.equal(res.estimatedInserts, 1, "202 is new");
  assert.equal(res.estimatedUpdates, 1, "201 already exists in DB");
  assert.equal(res.estimatedDeletes, 1, "203 is absent from snapshot");
  assert.ok(res.nullCounts, "nullCounts must be returned");
  assert.equal(res.nullCounts.amount, 1, "item 202 lacks amount");
  assert.equal(res.nullCounts.room_number, 2, "both items lack room_number");
  assert.equal(res.nullCounts.b24_stage_id, 0, "both have stageId");

  // Verify pool logs: must contain BEGIN READ ONLY, SELECT, ROLLBACK; zero DML
  const queries = pool.getLog().map((l) => l.sql);
  assert.ok(queries.includes("BEGIN READ ONLY"), "Must start read-only transaction");
  assert.ok(queries.includes("SELECT invoice_id FROM invoices"), "Must query existing IDs");
  assert.ok(queries.includes("ROLLBACK"), "Must rollback read-only transaction");
  assert.ok(!queries.some((q) => q.startsWith("INSERT")), "Zero INSERT in dryRun");
  assert.ok(!queries.some((q) => q.startsWith("UPDATE")), "Zero UPDATE in dryRun");
  assert.ok(!queries.some((q) => q.startsWith("DELETE")), "Zero DELETE in dryRun");

  // Fail-closed test: connection error must NOT be swallowed or faked as success
  const brokenPool = {
    connect: async () => {
      throw new Error("Simulated connection timeout");
    },
  };
  await assert.rejects(
    importInvoicesFromSnapshot(items, { dryRun: true, clientPool: brokenPool, request: mockRequest }),
    /Ошибка dry-run при получении локального реестра: Simulated connection timeout/
  );
});

test("runCli returns non-zero code on invalid arguments or validation failure", async () => {
  // Unknown arg
  const codeUnknown = await runCli(["--invalid"]);
  assert.equal(codeUnknown, 1);

  // Missing mode
  const codeNoMode = await runCli(["--snapshot", "dummy.json"]);
  assert.equal(codeNoMode, 1);
});

function createMockDbClient(previousRow, onInsert, eventsRow = null) {
  return {
    query: async (sql, params) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("SELECT * FROM invoices WHERE invoice_id=$1 FOR UPDATE")) {
        return {
          rowCount: previousRow ? 1 : 0,
          rows: previousRow ? [previousRow] : [],
        };
      }
      if (sql.includes("SELECT occurred_at, payload FROM invoice_events")) {
        return {
          rowCount: eventsRow ? 1 : 0,
          rows: eventsRow ? [eventsRow] : [],
        };
      }
      if (sql.includes("WITH room_type AS")) {
        if (!params[0]) return { rowCount: 0, rows: [] };
        return {
          rowCount: 1,
          rows: [{ room_type_id: "rt-1", room_id: "r-1" }],
        };
      }
      if (sql.includes("INSERT INTO invoices")) {
        if (onInsert) onInsert(sql, params);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO invoice_events")) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

test("B24 null clears ALL old values in public.invoices without falling back to previous state", async () => {
  // Existing row has non-null values for ALL B24-owned facts
  const previousInvoice = {
    invoice_id: "701",
    deal_id: "deal_existing",
    client_id: "client_existing",
    invoice_date: "2026-10-01",
    check_in: "2026-10-15",
    check_out: "2026-10-18",
    nights: 3,
    accommodation: "Стандарт 2",
    tariff: "Коттедж Осень",
    tariff_code: "344",
    tariff_name: "Коттедж Осень",
    room_type_name: "Стандарт 2",
    room_number: "101",
    room_type_id: "rt-old",
    room_id: "r-old",
    amount: "50000.00",
    paid_amount: "25000.00",
    status_basis: "b24_sync",
    invoice_status: "active",
    payment_status: "partial",
    invoice_status_basis: "b24_sync",
    payment_status_basis: "b24_sync",
    facts_version: new Date("2026-05-01T10:00:00Z"),
    invoice_version: new Date("2026-05-01T10:00:00Z"),
    payment_version: new Date("2026-05-01T10:00:00Z"),
    b24_stage_id: "DT31_2:UC_IFN8Q1",
  };

  // Incoming B24 snapshot has newer timestamp, but empty/null input for ALL B24-owned columns
  const incomingB24Item = {
    id: "701",
    updatedTime: "2026-06-01T10:00:00Z",
    stageId: null, // cleared
    parentId2: null, // deal_id cleared
    contactId: null, // client_id cleared
    begindate: null, // invoice_date cleared
    createdTime: "2026-01-01T00:00:00Z", // should NOT be used as fallback for invoice_date!
    ufCrm_6780C536C1950: null, // check_in cleared
    ufCrm_6780C536C7240: null, // check_out cleared
    ufCrm_682C33DB915F0: null, // nights cleared
    ufCrm_682C33DB6E4B8: null, // tariff_code cleared
    ufCrm_682C33DBD2DCF: null, // tariff_name cleared
    ufCrm_679255819E7C1: null, // room_type_name cleared
    ufCrm_67925581C6B36: null, // room_number cleared
    opportunity: null, // amount cleared
    ufCrmSmartInvoiceTbiPaymentAmountNum: null, // paid_amount cleared
  };

  let insertedSql = "";
  let insertedParams = null;
  const mockClient = createMockDbClient(previousInvoice, (sql, params) => {
    insertedSql = sql;
    insertedParams = params;
  });

  const res = await syncSingleInvoice(mockClient, incomingB24Item);
  assert.equal(res.status, "updated");
  assert.ok(insertedParams, "Update must be executed");

  // Verify SQL UPDATE contains no COALESCE with old values for ANY B24-owned fact
  const factColumns = [
    "deal_id", "client_id", "invoice_date", "check_in", "check_out",
    "nights", "accommodation", "tariff", "tariff_code", "tariff_name",
    "room_type_name", "room_number", "room_type_id", "room_id", "amount", "paid_amount"
  ];
  for (const col of factColumns) {
    const re = new RegExp(`${col}\\s*=\\s*CASE WHEN \\$33 THEN EXCLUDED\\.${col} ELSE invoices\\.${col} END`);
    assert.match(insertedSql, re, `SQL UPDATE must explicitly overwrite ${col} with EXCLUDED.${col} when factsAccepted is true`);
    assert.doesNotMatch(insertedSql, new RegExp(`${col}\\s*=\\s*COALESCE`), `SQL UPDATE must NOT use COALESCE for ${col}`);
  }

  // Verify all corresponding parameters are passed as NULL
  assert.equal(insertedParams[1], null, "deal_id ($2) must be null");
  assert.equal(insertedParams[2], null, "client_id ($3) must be null");
  assert.equal(insertedParams[3], null, "invoice_date ($4) must be null (no fallback to createdTime)");
  assert.equal(insertedParams[4], null, "check_in ($5) must be null");
  assert.equal(insertedParams[5], null, "check_out ($6) must be null");
  assert.equal(insertedParams[6], null, "nights ($7) must be null (no calculated fallback)");
  assert.equal(insertedParams[7], null, "accommodation ($8) must be null");
  assert.equal(insertedParams[8], null, "tariff ($9) must be null");
  assert.equal(insertedParams[9], null, "amount ($10) must be null");
  assert.equal(insertedParams[10], null, "paid_amount ($11) must be null");
  assert.equal(insertedParams[19], null, "tariff_code ($20) must be null");
  assert.equal(insertedParams[20], null, "tariff_name ($21) must be null");
  assert.equal(insertedParams[21], null, "room_type_name ($22) must be null");
  assert.equal(insertedParams[22], null, "room_number ($23) must be null");
  assert.equal(insertedParams[23], null, "room_type_id ($24) must be null");
  assert.equal(insertedParams[24], null, "room_id ($25) must be null");
  assert.equal(insertedParams[31], null, "b24_stage_id ($32) must be null");
});

test("B24 null nights is NOT calculated from check_in and check_out", async () => {
  const previousInvoice = {
    invoice_id: "702",
    nights: 10,
    status_basis: "b24_sync",
    facts_version: new Date("2026-05-01T10:00:00Z"),
  };

  const incomingB24Item = {
    id: "702",
    updatedTime: "2026-06-01T10:00:00Z",
    stageId: "DT31_2:P",
    ufCrm_6780C536C1950: "2026-06-01", // checkIn
    ufCrm_6780C536C7240: "2026-06-05", // checkOut (4 days diff)
    ufCrm_682C33DB915F0: null, // B24 nights field is null
  };

  let insertedParams = null;
  const mockClient = createMockDbClient(previousInvoice, (_sql, params) => {
    insertedParams = params;
  });

  await syncSingleInvoice(mockClient, incomingB24Item);
  assert.equal(insertedParams[6], null, "nights must remain null despite presence of check_in and check_out");
});

test("B24 null invoice_date does NOT fallback to createdTime", async () => {
  const previousInvoice = {
    invoice_id: "703",
    invoice_date: "2026-05-01",
    status_basis: "b24_sync",
    facts_version: new Date("2026-05-01T10:00:00Z"),
  };

  const incomingB24Item = {
    id: "703",
    updatedTime: "2026-06-01T10:00:00Z",
    stageId: "DT31_2:P",
    begindate: null, // begindate is omitted/null
    createdTime: "2026-05-20T10:00:00Z", // createdTime is present
  };

  let insertedParams = null;
  const mockClient = createMockDbClient(previousInvoice, (_sql, params) => {
    insertedParams = params;
  });

  await syncSingleInvoice(mockClient, incomingB24Item);
  assert.equal(insertedParams[3], null, "invoice_date must remain null without begindate");
});

function createMockTransactionalPool(initialInvoices = [], initialEvents = []) {
  let invoices = new Map(initialInvoices.map((inv) => [inv.invoice_id, { ...inv }]));
  let events = [...initialEvents];
  let inTx = false;
  let txInvoices = null;
  let txEvents = null;
  let log = [];

  const client = {
    query: async (sql, params) => {
      log.push({ sql, params });
      if (sql === "BEGIN" || sql === "BEGIN READ ONLY") {
        inTx = true;
        txInvoices = new Map(invoices);
        txEvents = [...events];
        return { rowCount: 0, rows: [] };
      }
      if (sql === "COMMIT") {
        inTx = false;
        invoices = txInvoices;
        events = txEvents;
        return { rowCount: 0, rows: [] };
      }
      if (sql === "ROLLBACK") {
        inTx = false;
        txInvoices = null;
        txEvents = null;
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("SELECT invoice_id FROM invoices")) {
        const target = inTx ? txInvoices : invoices;
        return {
          rowCount: target.size,
          rows: Array.from(target.keys()).map((id) => ({ invoice_id: id })),
        };
      }
      if (sql.includes("SELECT * FROM invoices WHERE invoice_id=$1 FOR UPDATE")) {
        const id = params[0];
        const target = inTx ? txInvoices : invoices;
        const row = target.get(id);
        return {
          rowCount: row ? 1 : 0,
          rows: row ? [row] : [],
        };
      }
      if (sql.includes("SELECT occurred_at, payload FROM invoice_events")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("WITH room_type AS")) {
        if (!params[0]) return { rowCount: 0, rows: [] };
        return {
          rowCount: 1,
          rows: [{ room_type_id: "rt-1", room_id: "r-1" }],
        };
      }
      if (sql.includes("INSERT INTO invoices")) {
        const id = params[0];
        const target = inTx ? txInvoices : invoices;
        const prev = target.get(id) || {};
        const factsAccepted = params[32];
        const invoiceAccepted = params[33];
        const paymentAccepted = params[34];
        const rowData = {
          invoice_id: id,
          deal_id: factsAccepted ? params[1] : prev.deal_id,
          client_id: factsAccepted ? params[2] : prev.client_id,
          invoice_date: factsAccepted ? params[3] : prev.invoice_date,
          check_in: factsAccepted ? params[4] : prev.check_in,
          check_out: factsAccepted ? params[5] : prev.check_out,
          nights: factsAccepted ? params[6] : prev.nights,
          accommodation: factsAccepted ? params[7] : prev.accommodation,
          tariff: factsAccepted ? params[8] : prev.tariff,
          amount: factsAccepted ? params[9] : prev.amount,
          paid_amount: factsAccepted ? params[10] : prev.paid_amount,
          tariff_code: factsAccepted ? params[19] : prev.tariff_code,
          tariff_name: factsAccepted ? params[20] : prev.tariff_name,
          room_type_name: factsAccepted ? params[21] : prev.room_type_name,
          room_number: factsAccepted ? params[22] : prev.room_number,
          room_type_id: factsAccepted ? params[23] : prev.room_type_id,
          room_id: factsAccepted ? params[24] : prev.room_id,
          b24_stage_id: (invoiceAccepted || paymentAccepted || factsAccepted) ? params[31] : prev.b24_stage_id,
        };
        target.set(id, rowData);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO invoice_events")) {
        const eventRow = {
          invoice_id: params[0],
          event_key: params[1],
          event_type: params[2],
          payload: params[7],
          occurred_at: params[8],
        };
        const target = inTx ? txEvents : events;
        target.push(eventRow);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("SELECT count(*)::int AS count FROM invoices WHERE invoice_id != ALL")) {
        const keepIds = new Set(params[0]);
        const target = inTx ? txInvoices : invoices;
        let count = 0;
        for (const id of target.keys()) {
          if (!keepIds.has(id)) count++;
        }
        return { rowCount: 1, rows: [{ count }] };
      }
      if (sql.includes("SELECT count(*)::int AS count FROM invoices")) {
        const target = inTx ? txInvoices : invoices;
        return { rowCount: 1, rows: [{ count: target.size }] };
      }
      if (sql.includes("DELETE FROM invoices WHERE invoice_id != ALL")) {
        const keepIds = new Set(params[0]);
        const target = inTx ? txInvoices : invoices;
        let count = 0;
        for (const id of Array.from(target.keys())) {
          if (!keepIds.has(id)) {
            target.delete(id);
            count++;
          }
        }
        return { rowCount: count, rows: [] };
      }
      if (sql === "DELETE FROM invoices") {
        const target = inTx ? txInvoices : invoices;
        const count = target.size;
        target.clear();
        return { rowCount: count, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    release: () => {},
  };

  return {
    connect: async () => client,
    getInvoices: () => invoices,
    getEvents: () => events,
    getLog: () => log,
  };
}

test("atomic apply with live B24 verification: missing ID is deleted, remaining updated/inserted, and audit history in invoice_events is preserved", async () => {
  const initialInvoices = [
    { invoice_id: "101", amount: "10000", b24_stage_id: "DT31_2:N" },
    { invoice_id: "102", amount: "20000", b24_stage_id: "DT31_2:N" }, // will be deleted (missing from snapshot)
    { invoice_id: "103", amount: "30000", b24_stage_id: "DT31_2:N" }, // will be deleted (missing from snapshot)
  ];
  const initialEvents = [
    { invoice_id: "101", event_key: "ev_101", event_type: "initial" },
    { invoice_id: "102", event_key: "ev_102", event_type: "initial" },
    { invoice_id: "103", event_key: "ev_103", event_type: "initial" },
  ];

  const pool = createMockTransactionalPool(initialInvoices, initialEvents);

  // Snapshot contains 101 (updated) and 104 (new). 102 and 103 are absent.
  const snapshot = [
    { id: "101", updatedTime: "2026-11-05T12:00:00Z", stageId: "DT31_2:P", opportunity: "15000" },
    { id: "104", updatedTime: "2026-11-05T12:00:00Z", stageId: "DT31_2:UC_IFN8Q1", opportunity: "40000" },
  ];

  const res = await importInvoicesFromSnapshot(snapshot, {
    dryRun: false,
    clientPool: pool,
    request: createMockB24Request(snapshot),
  });

  assert.equal(res.total, 2);
  assert.equal(res.inserted, 1, "104 must be inserted");
  assert.equal(res.updated, 1, "101 must be updated");
  assert.equal(res.deleted, 2, "102 and 103 must be deleted");

  // Verify current state of invoices table
  const survivingInvoices = pool.getInvoices();
  assert.equal(survivingInvoices.size, 2);
  assert.ok(survivingInvoices.has("101"));
  assert.ok(survivingInvoices.has("104"));
  assert.equal(survivingInvoices.has("102"), false, "102 must be removed from invoices");
  assert.equal(survivingInvoices.has("103"), false, "103 must be removed from invoices");

  // Verify audit history in invoice_events is completely preserved
  const allEvents = pool.getEvents();
  assert.ok(allEvents.length >= 4, "Must retain all previous and new events");
  const eventInvoiceIds = allEvents.map((e) => e.invoice_id);
  assert.ok(eventInvoiceIds.includes("102"), "Audit event for deleted invoice 102 must be preserved");
  assert.ok(eventInvoiceIds.includes("103"), "Audit event for deleted invoice 103 must be preserved");
  assert.ok(eventInvoiceIds.includes("101"), "Audit event for invoice 101 must be present");
  assert.ok(eventInvoiceIds.includes("104"), "Audit event for new invoice 104 must be present");
});

test("unverified, stale or mismatched snapshot refuses destructive deletion of missing accounts before BEGIN (fail-closed)", async () => {
  const initialInvoices = [
    { invoice_id: "101", amount: "10000", b24_stage_id: "DT31_2:N" },
    { invoice_id: "102", amount: "20000", b24_stage_id: "DT31_2:N" },
  ];
  const pool = createMockTransactionalPool(initialInvoices);

  // Snapshot has 101, but 102 is missing in snapshot while B24 live inventory STILL has both 101 and 102
  const snapshot = [
    { id: "101", updatedTime: "2026-11-05T12:00:00Z", stageId: "DT31_2:P", opportunity: "15000" },
  ];
  const liveB24 = [
    { id: "101", updatedTime: "2026-11-05T12:00:00Z" },
    { id: "102", updatedTime: "2026-11-05T12:00:00Z" },
  ];

  await assert.rejects(
    importInvoicesFromSnapshot(snapshot, {
      dryRun: false,
      clientPool: pool,
      request: createMockB24Request(liveB24),
    }),
    /Проверка полноты снимка через B24 отклонена: Количество счетов в снимке \(1\) не совпадает со снимком Б24 \(2\)/
  );

  // Verify DB state was NOT touched (zero queries to transactional client)
  assert.equal(pool.getLog().length, 0, "No DB transaction should be opened");
  const currentInvoices = pool.getInvoices();
  assert.equal(currentInvoices.size, 2);
  assert.ok(currentInvoices.has("102"), "Missing invoice must NOT be deleted when B24 verification fails");
});

test("confirmed empty snapshot with allowEmpty and verified empty B24 deletes all invoices while preserving events", async () => {
  const initialInvoices = [
    { invoice_id: "101", amount: "10000" },
    { invoice_id: "102", amount: "20000" },
  ];
  const initialEvents = [
    { invoice_id: "101", event_key: "ev1" },
    { invoice_id: "102", event_key: "ev2" },
  ];
  const pool = createMockTransactionalPool(initialInvoices, initialEvents);

  const res = await importInvoicesFromSnapshot([], {
    dryRun: false,
    clientPool: pool,
    allowEmpty: true,
    request: createMockB24Request([]), // Live B24 is confirmed genuinely empty
  });

  assert.equal(res.total, 0);
  assert.equal(res.deleted, 2, "All existing invoices must be deleted");
  assert.equal(pool.getInvoices().size, 0, "Invoices table must be empty");
  assert.equal(pool.getEvents().length, 2, "Invoice events must be completely preserved");
});

test("empty snapshot without allowEmpty throws before any database operations", async () => {
  const pool = createMockTransactionalPool([{ invoice_id: "101" }]);
  await assert.rejects(
    importInvoicesFromSnapshot([], { dryRun: false, clientPool: pool, allowEmpty: false }),
    /Снимок не содержит записей/
  );
  assert.equal(pool.getLog().length, 0, "Zero queries must be made to DB");
});

test("atomic apply error rolls back entire snapshot and restores initial state", async () => {
  const initialInvoices = [
    { invoice_id: "801", amount: "10000", b24_stage_id: "DT31_2:N" },
  ];
  const pool = createMockTransactionalPool(initialInvoices);

  // Snapshot has 2 items: 801, and 802 which will fail
  const snapshot = [
    { id: "801", updatedTime: "2026-11-05T12:00:00Z", stageId: "DT31_2:P", opportunity: "50000" },
    { id: "802", updatedTime: "2026-11-05T12:00:00Z", stageId: "DT31_2:P", opportunity: "60000" },
  ];

  // Configure pool to fail on item 802
  const originalConnect = pool.connect;
  pool.connect = async () => {
    const cl = await originalConnect();
    const origQuery = cl.query;
    cl.query = async (sql, params) => {
      if (sql.includes("INSERT INTO invoices") && params[0] === "802") {
        throw new Error("Simulated database failure on invoice 802");
      }
      return origQuery(sql, params);
    };
    return cl;
  };

  await assert.rejects(
    importInvoicesFromSnapshot(snapshot, {
      dryRun: false,
      clientPool: pool,
      request: createMockB24Request(snapshot),
    }),
    /Simulated database failure/
  );

  // Check ROLLBACK was executed and database was completely restored
  const finalInvoices = pool.getInvoices();
  assert.equal(finalInvoices.size, 1);
  assert.equal(finalInvoices.get("801").amount, "10000", "801 must NOT have committed changes");
  assert.equal(finalInvoices.has("802"), false, "802 must NOT exist in invoices");
});

test("duplicate or incomplete snapshot fails validation before any DB query is made", async () => {
  let queryCount = 0;
  const mockPool = {
    connect: async () => ({
      query: async () => {
        queryCount++;
        return { rowCount: 0, rows: [] };
      },
      release: () => {},
    }),
  };

  // Duplicate ID
  await assert.rejects(
    importInvoicesFromSnapshot(
      [
        { id: "901", updatedTime: "2026-11-05T12:00:00Z", stageId: "DT31_2:P" },
        { id: "901", updatedTime: "2026-11-05T12:00:00Z", stageId: "DT31_2:P" },
      ],
      { dryRun: false, clientPool: mockPool }
    ),
    /дубликат invoice_id 901/i
  );
  assert.equal(queryCount, 0, "No query should be issued for duplicate snapshot");

  // Incomplete item (invalid updatedTime)
  await assert.rejects(
    importInvoicesFromSnapshot(
      [{ id: "902", updatedTime: "invalid-date", stageId: "DT31_2:P" }],
      { dryRun: false, clientPool: mockPool }
    ),
    /не содержит валидного поля updatedTime/
  );
  assert.equal(queryCount, 0, "No query should be issued for invalid updatedTime");
});

test("repeat of identical full snapshot is idempotent", async () => {
  const pool = createMockTransactionalPool();
  const snapshot = [
    { id: "1001", updatedTime: "2026-11-05T12:00:00Z", stageId: "DT31_2:P", opportunity: "50000" },
    { id: "1002", updatedTime: "2026-11-05T12:00:00Z", stageId: "DT31_2:N", opportunity: "30000" },
  ];

  const mockRequest = createMockB24Request(snapshot);

  // First apply: 2 inserts
  const res1 = await importInvoicesFromSnapshot(snapshot, {
    dryRun: false,
    clientPool: pool,
    request: mockRequest,
  });
  assert.equal(res1.inserted, 2);
  assert.equal(res1.deleted, 0);

  // Second apply: identical snapshot -> 0 inserts, 0 deletes, 2 updates (idempotent overwrite)
  const res2 = await importInvoicesFromSnapshot(snapshot, {
    dryRun: false,
    clientPool: pool,
    request: mockRequest,
  });
  assert.equal(res2.inserted, 0);
  assert.equal(res2.deleted, 0);
  assert.equal(res2.updated, 2);
  assert.equal(pool.getInvoices().size, 2);
});

test("JSON metadata bypass prevention: verifiedComplete or allowEmpty in snapshot payload is ignored", async () => {
  const initialInvoices = [{ invoice_id: "101" }, { invoice_id: "102" }];
  const pool = createMockTransactionalPool(initialInvoices);

  // Malicious snapshot object attempting to claim verifiedComplete without actual B24 match
  const maliciousSnapshot = {
    verifiedComplete: true,
    allowEmpty: true,
    items: [{ id: "101", updatedTime: "2026-11-05T12:00:00Z", stageId: "DT31_2:N" }],
  };

  // Live B24 has 2 items (101 and 102). Malicious snapshot claims verifiedComplete to delete 102.
  await assert.rejects(
    importInvoicesFromSnapshot(maliciousSnapshot, {
      dryRun: false,
      clientPool: pool,
      request: createMockB24Request([
        { id: "101", updatedTime: "2026-11-05T12:00:00Z" },
        { id: "102", updatedTime: "2026-11-05T12:00:00Z" },
      ]),
    }),
    /Проверка полноты снимка через B24 отклонена/
  );
  assert.equal(pool.getLog().length, 0, "Zero DB queries issued");

  // Attempt to bypass allowEmpty from object metadata
  await assert.rejects(
    importInvoicesFromSnapshot({ allowEmpty: true, items: [] }, {
      dryRun: false,
      clientPool: pool,
      allowEmpty: false, // operator did NOT specify --allow-empty
    }),
    /Снимок не содержит записей/
  );
});

test("stale snapshot rejection: newer updatedTime in live B24 stops import before BEGIN", async () => {
  const pool = createMockTransactionalPool([{ invoice_id: "101" }]);
  const snapshot = [{ id: "101", updatedTime: "2026-01-01T10:00:00Z", stageId: "DT31_2:N" }];
  const liveB24 = [{ id: "101", updatedTime: "2026-05-01T12:00:00Z" }]; // mutated in B24

  await assert.rejects(
    importInvoicesFromSnapshot(snapshot, {
      dryRun: false,
      clientPool: pool,
      request: createMockB24Request(liveB24),
    }),
    /Время обновления счета 101 не совпадает/
  );
  assert.equal(pool.getLog().length, 0, "Zero DB queries issued for stale snapshot");
});

test("--allow-empty with non-empty live B24 fails before BEGIN", async () => {
  const pool = createMockTransactionalPool([{ invoice_id: "101" }]);
  await assert.rejects(
    importInvoicesFromSnapshot([], {
      dryRun: false,
      clientPool: pool,
      allowEmpty: true,
      request: createMockB24Request([{ id: "101", updatedTime: "2026-01-01T00:00:00Z" }]),
    }),
    /Количество счетов в снимке \(0\) не совпадает со снимком Б24 \(1\)/
  );
  assert.equal(pool.getLog().length, 0, "Zero DB queries issued");
});

test("nullable stageId is written as NULL and counted in nullCounts without failing validation", async () => {
  const pool = createMockTransactionalPool();
  const snapshot = [
    { id: "901", updatedTime: "2026-11-05T12:00:00Z", stageId: null },
    { id: "902", updatedTime: "2026-11-05T12:00:00Z", stageId: "" },
  ];

  const res = await importInvoicesFromSnapshot(snapshot, {
    dryRun: false,
    clientPool: pool,
    request: createMockB24Request(snapshot),
  });

  assert.equal(res.inserted, 2);
  const invoices = pool.getInvoices();
  assert.equal(invoices.get("901").b24_stage_id, null);
  assert.equal(invoices.get("902").b24_stage_id, null);
});

test("B24 API error during completeness check rejects before BEGIN without touching DB", async () => {
  const pool = createMockTransactionalPool([{ invoice_id: "101" }]);
  const snapshot = [{ id: "101", updatedTime: "2026-11-05T12:00:00Z", stageId: "DT31_2:N" }];

  await assert.rejects(
    importInvoicesFromSnapshot(snapshot, {
      dryRun: false,
      clientPool: pool,
      request: async () => {
        throw new Error("Bitrix24 API 502 Bad Gateway");
      },
    }),
    /Bitrix24 API 502 Bad Gateway/
  );
  assert.equal(pool.getLog().length, 0, "No DB query should be executed on B24 API error");
});

test("B24 mutation between pagination passes rejects before BEGIN", async () => {
  const pool = createMockTransactionalPool([{ invoice_id: "101" }]);
  const snapshot = [{ id: "101", updatedTime: "2026-11-05T12:00:00Z", stageId: "DT31_2:N" }];

  let pass = 0;
  await assert.rejects(
    importInvoicesFromSnapshot(snapshot, {
      dryRun: false,
      clientPool: pool,
      request: async () => {
        pass++;
        const pages = Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [
            `page${i}`,
            {
              items:
                i === 0
                  ? pass === 1
                    ? [{ id: 101, updatedTime: "2026-11-05T12:00:00Z" }]
                    : [{ id: 101, updatedTime: "2026-11-05T12:05:00Z" }] // mutated between pass 1 and pass 2
                  : [],
            },
          ])
        );
        const resultTotal = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`page${i}`, 1]));
        return { result: { result: pages, result_error: {}, result_total: resultTotal, result_next: {} } };
      },
    }),
    /Snapshot consistency verification failed/
  );
  assert.equal(pool.getLog().length, 0, "Zero DB queries issued on pagination mutation");
});

test("B24 item with invalid updatedTime in live response rejects before BEGIN", async () => {
  const pool = createMockTransactionalPool([{ invoice_id: "101" }]);
  const snapshot = [{ id: "101", updatedTime: "2026-11-05T12:00:00Z", stageId: "DT31_2:N" }];

  await assert.rejects(
    importInvoicesFromSnapshot(snapshot, {
      dryRun: false,
      clientPool: pool,
      request: async () => {
        const pages = Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [
            `page${i}`,
            { items: i === 0 ? [{ id: 101, updatedTime: "garbage-time" }] : [] },
          ])
        );
        const resultTotal = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`page${i}`, 1]));
        return { result: { result: pages, result_error: {}, result_total: resultTotal, result_next: {} } };
      },
    }),
    /lacks valid updatedTime/
  );
  assert.equal(pool.getLog().length, 0, "Zero DB queries on invalid B24 updatedTime");
});

test("runCli succeeds with exit code 0 when dry-run or apply matches B24 with injected mocks", async () => {
  const snapshot = [
    { id: "101", updatedTime: "2026-11-05T12:00:00Z", stageId: "DT31_2:P" },
  ];
  const pool = createMockTransactionalPool([{ invoice_id: "101" }]);
  const mockRequest = createMockB24Request(snapshot);

  // In memory, we test by passing parsed snapshot object / array through a mock file or helper
  // Create scratch temporary file for CLI --snapshot argument
  const { writeFile, unlink } = await import("node:fs/promises");
  const tmpPath = "/tmp/test_snapshot_fix5.json";
  await writeFile(tmpPath, JSON.stringify(snapshot));

  try {
    const dryCode = await runCli(["--snapshot", tmpPath, "--dry-run"], {
      clientPool: pool,
      request: mockRequest,
    });
    assert.equal(dryCode, 0, "runCli with --dry-run must exit with 0");

    const applyCode = await runCli(["--snapshot", tmpPath, "--apply"], {
      clientPool: pool,
      request: mockRequest,
    });
    assert.equal(applyCode, 0, "runCli with --apply must exit with 0");
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
});

test("version precedence: B24 snapshot overrides artificial sheet_import timestamp", async () => {
  const previousSheetImport = {
    invoice_id: "301",
    status_basis: "legacy_assumed",
    invoice_status: "active",
    payment_status: "paid",
    invoice_status_basis: "sheet_import",
    payment_status_basis: "legacy_assumed",
    import_row_id: 12345,
    source_request_id: null,
    facts_version: new Date("2026-11-04T00:00:00Z"),
    invoice_version: new Date("2026-11-04T00:00:00Z"),
    payment_version: new Date("2026-11-04T00:00:00Z"),
  };

  const incomingB24Item = {
    id: "301",
    updatedTime: "2025-06-01T12:00:00Z",
    stageId: "DT31_2:UC_IFN8Q1",
    opportunity: "50000",
    ufCrmSmartInvoiceTbiPaymentAmountNum: "25000",
  };

  let insertedParams = null;
  const mockClient = createMockDbClient(previousSheetImport, (_sql, params) => {
    insertedParams = params;
  });

  const res = await syncSingleInvoice(mockClient, incomingB24Item);
  assert.equal(res.status, "updated");
  assert.ok(insertedParams, "Database update must be executed");
  const factsAccepted = insertedParams[32];
  const invoiceAccepted = insertedParams[33];
  const paymentAccepted = insertedParams[34];
  assert.equal(factsAccepted, true, "B24 facts must be accepted despite artificial sheet_import timestamp");
  assert.equal(invoiceAccepted, true);
  assert.equal(paymentAccepted, true);
});

test("version precedence regression: B24 snapshot overrides artificial sheet_import timestamp when status_basis is b24_sync but applied.facts was false", async () => {
  const previousMixedRow = {
    invoice_id: "601",
    status_basis: "b24_sync",
    invoice_status: "active",
    payment_status: "paid",
    invoice_status_basis: "b24_sync",
    payment_status_basis: "b24_sync",
    import_row_id: 9999,
    facts_version: new Date("2026-11-04T00:00:00Z"),
    invoice_version: new Date("2026-05-01T10:00:00Z"),
    payment_version: new Date("2026-05-01T10:00:00Z"),
    b24_stage_id: "DT31_2:P",
  };

  const incomingB24Item = {
    id: "601",
    updatedTime: "2025-06-01T12:00:00Z",
    stageId: "DT31_2:UC_IFN8Q1",
    opportunity: "80000",
    ufCrmSmartInvoiceTbiPaymentAmountNum: "40000",
  };

  let insertedParams = null;
  const mockClient = createMockDbClient(previousMixedRow, (_sql, params) => {
    insertedParams = params;
  }, null);

  const res = await syncSingleInvoice(mockClient, incomingB24Item);
  assert.equal(res.status, "updated");
  assert.ok(insertedParams, "Database update must be executed");
  const factsAccepted = insertedParams[32];
  const invoiceAccepted = insertedParams[33];
  const paymentAccepted = insertedParams[34];
  assert.equal(factsAccepted, true, "B24 facts must be accepted to correct artificial Sheets facts even when status_basis is b24_sync");
  assert.equal(invoiceAccepted, false, "Older snapshot status must not overwrite newer confirmed B24 invoice_status");
  assert.equal(paymentAccepted, false, "Older snapshot status must not overwrite newer confirmed B24 payment_status");
});

test("version precedence regression: older B24 snapshot does NOT overwrite newer confirmed B24 facts with applied.facts=true", async () => {
  const previousRow = {
    invoice_id: "602",
    status_basis: "b24_sync",
    invoice_status: "active",
    payment_status: "paid",
    invoice_status_basis: "b24_sync",
    payment_status_basis: "b24_sync",
    import_row_id: 9999,
    facts_version: new Date("2026-05-01T10:00:00Z"),
    invoice_version: new Date("2026-05-01T10:00:00Z"),
    payment_version: new Date("2026-05-01T10:00:00Z"),
    b24_stage_id: "DT31_2:P",
  };

  const confirmedFactsEvent = {
    occurred_at: new Date("2026-05-01T10:00:00Z"),
    payload: {
      source: "b24_sync",
      b24_updated_time: "2026-05-01T10:00:00Z",
      applied: {
        facts: true,
        invoice_status: true,
        payment_status: true,
      },
    },
  };

  const olderItem = {
    id: "602",
    updatedTime: "2025-01-01T10:00:00Z",
    stageId: "DT31_2:N",
    opportunity: "10000",
  };

  let wasExecuted = false;
  const mockClient = createMockDbClient(previousRow, () => {
    wasExecuted = true;
  }, confirmedFactsEvent);

  const res = await syncSingleInvoice(mockClient, olderItem);
  assert.equal(res.status, "skipped", "Older B24 snapshot must be skipped when newer B24 facts are confirmed");
  assert.equal(wasExecuted, false);
});

test("version precedence: older B24 snapshot does NOT overwrite newer confirmed B24 facts", async () => {
  const previousB24Row = {
    invoice_id: "401",
    status_basis: "b24_sync",
    invoice_status: "active",
    payment_status: "paid",
    invoice_status_basis: "b24_sync",
    payment_status_basis: "b24_sync",
    facts_version: new Date("2026-05-01T10:00:00Z"),
    invoice_version: new Date("2026-05-01T10:00:00Z"),
    payment_version: new Date("2026-05-01T10:00:00Z"),
    b24_stage_id: "DT31_2:P",
  };

  const olderB24Item = {
    id: "401",
    updatedTime: "2025-01-01T10:00:00Z",
    stageId: "DT31_2:N",
    opportunity: "10000",
  };

  let wasExecuted = false;
  const mockClient = createMockDbClient(previousB24Row, () => {
    wasExecuted = true;
  });

  const res = await syncSingleInvoice(mockClient, olderB24Item);
  assert.equal(res.status, "skipped", "Older B24 snapshot must be skipped");
  assert.equal(wasExecuted, false, "Older snapshot must not overwrite confirmed B24 data in DB");
});

test("version precedence: newer B24 snapshot updates existing B24 facts, and repeat is idempotent", async () => {
  const previousB24Row = {
    invoice_id: "501",
    status_basis: "b24_sync",
    invoice_status: "active",
    payment_status: "unpaid",
    invoice_status_basis: "b24_sync",
    payment_status_basis: "b24_sync",
    facts_version: new Date("2025-01-01T10:00:00Z"),
    invoice_version: new Date("2025-01-01T10:00:00Z"),
    payment_version: new Date("2025-01-01T10:00:00Z"),
    b24_stage_id: "DT31_2:N",
  };

  const newerB24Item = {
    id: "501",
    updatedTime: "2026-05-01T10:00:00Z",
    stageId: "DT31_2:P",
    opportunity: "45000",
  };

  let insertedParams = null;
  const mockClient = createMockDbClient(previousB24Row, (_sql, params) => {
    insertedParams = params;
  });

  const res = await syncSingleInvoice(mockClient, newerB24Item);
  assert.equal(res.status, "updated");
  assert.equal(insertedParams[32], true, "factsAccepted must be true for newer B24 snapshot");

  const repeatClient = createMockDbClient(
    {
      ...previousB24Row,
      facts_version: new Date("2026-05-01T10:00:00Z"),
      invoice_version: new Date("2026-05-01T10:00:00Z"),
      payment_version: new Date("2026-05-01T10:00:00Z"),
      invoice_status: "active",
      payment_status: "paid",
    },
    (_sql, p) => {
      insertedParams = p;
    }
  );

  const resRepeat = await syncSingleInvoice(repeatClient, newerB24Item);
  assert.equal(resRepeat.status, "updated", "Repeat of same snapshot is accepted idempotently");
});

// ============================================================================
// FIX6: B24 BATCH PAGINATION METADATA VALIDATION TESTS
// ============================================================================

test("Fix6: equally truncated responses in both passes where items < total are rejected before BEGIN", async () => {
  const pool = createMockTransactionalPool([{ invoice_id: "101" }]);
  const snapshot = Array.from({ length: 50 }, (_, i) => ({
    id: String(i + 1),
    updatedTime: "2026-01-01T00:00:00Z",
    stageId: "DT31_2:N",
  }));

  // Both passes return the same 50 items, but result_total is 100 (truncated list)
  const truncatedRequest = async () => {
    const pages = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [
        `page${i}`,
        {
          items: i === 0 ? snapshot.map((it) => ({ id: Number(it.id), updatedTime: it.updatedTime })) : [],
        },
      ])
    );
    const resultTotal = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`page${i}`, 100]));
    const resultNext = { page0: 50 };
    return {
      result: {
        result: pages,
        result_error: {},
        result_total: resultTotal,
        result_next: resultNext,
      },
    };
  };

  await assert.rejects(
    importInvoicesFromSnapshot(snapshot, {
      dryRun: false,
      clientPool: pool,
      request: truncatedRequest,
    }),
    /Page page1 item count \(0\) does not match expected \(50\)/
  );
  assert.equal(pool.getLog().length, 0, "Zero DB queries issued on truncated B24 pass");
});

test("Fix6: missing result_total metadata is rejected before BEGIN", async () => {
  const pool = createMockTransactionalPool([{ invoice_id: "101" }]);
  const snapshot = [{ id: "101", updatedTime: "2026-01-01T00:00:00Z", stageId: "DT31_2:N" }];

  await assert.rejects(
    importInvoicesFromSnapshot(snapshot, {
      dryRun: false,
      clientPool: pool,
      request: async () => ({
        result: {
          result: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`page${i}`, { items: [] }])),
          result_error: {},
          result_next: {},
          // result_total missing
        },
      }),
    }),
    /missing or invalid batch pagination metadata/
  );
  assert.equal(pool.getLog().length, 0, "Zero DB queries issued when result_total is missing");
});

test("Fix6: missing result_next metadata is rejected before BEGIN", async () => {
  const pool = createMockTransactionalPool([{ invoice_id: "101" }]);
  const snapshot = [{ id: "101", updatedTime: "2026-01-01T00:00:00Z", stageId: "DT31_2:N" }];

  await assert.rejects(
    importInvoicesFromSnapshot(snapshot, {
      dryRun: false,
      clientPool: pool,
      request: async () => ({
        result: {
          result: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`page${i}`, { items: [] }])),
          result_error: {},
          result_total: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`page${i}`, 0])),
          // result_next missing
        },
      }),
    }),
    /missing or invalid batch pagination metadata/
  );
  assert.equal(pool.getLog().length, 0, "Zero DB queries issued when result_next is missing");
});

test("Fix6: mismatched result_total between aliases in same batch is rejected", async () => {
  const pool = createMockTransactionalPool([{ invoice_id: "101" }]);
  const snapshot = [{ id: "101", updatedTime: "2026-01-01T00:00:00Z", stageId: "DT31_2:N" }];

  await assert.rejects(
    importInvoicesFromSnapshot(snapshot, {
      dryRun: false,
      clientPool: pool,
      request: async () => {
        const pages = Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [
            `page${i}`,
            { items: i === 0 ? [{ id: 101, updatedTime: "2026-01-01T00:00:00Z" }] : [] },
          ])
        );
        const resultTotal = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`page${i}`, i === 0 ? 1 : 2]));
        return {
          result: {
            result: pages,
            result_error: {},
            result_total: resultTotal,
            result_next: {},
          },
        };
      },
    }),
    /Inconsistent result_total for page1: expected 1, got 2/
  );
  assert.equal(pool.getLog().length, 0, "Zero DB queries on alias total mismatch");
});

test("Fix6: mismatched result_total between batch rounds is rejected", async () => {
  const calls = [];
  let round = 0;
  await assert.rejects(
    fetchChangedInvoicesFromBitrix({
      webhookUrl: "https://example.invalid/",
      sinceDate: null,
      request: async (_url, _method, params) => {
        calls.push(params);
        round++;
        const total = round === 1 ? 2600 : 2550; // Total shifted between batch rounds
        const pages = Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [
            `page${i}`,
            { items: round === 1 ? Array.from({ length: 50 }, (_, j) => ({ id: i * 50 + j + 1 })) : [] },
          ])
        );
        const resultTotal = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`page${i}`, total]));
        const resultNext = round === 1
          ? Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`page${i}`, (i + 1) * 50]))
          : {};
        return {
          result: {
            result: pages,
            result_error: {},
            result_total: resultTotal,
            result_next: resultNext,
          },
        };
      },
    }),
    /Inconsistent result_total for page0: expected 2600, got 2550/
  );
});

test("Fix6: missing expected result_next when total exceeds current page is rejected", async () => {
  await assert.rejects(
    fetchChangedInvoicesFromBitrix({
      webhookUrl: "https://example.invalid/",
      sinceDate: null,
      request: async () => {
        const pages = Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [
            `page${i}`,
            { items: i === 0 ? Array.from({ length: 50 }, (_, j) => ({ id: j + 1 })) : [] },
          ])
        );
        const resultTotal = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`page${i}`, 100]));
        // result_next is missing page0 even though total is 100 and page0 only has 50 items
        return {
          result: {
            result: pages,
            result_error: {},
            result_total: resultTotal,
            result_next: {},
          },
        };
      },
    }),
    /Missing expected result_next for page0/
  );
});

test("Fix6: invalid result_next value is rejected", async () => {
  await assert.rejects(
    fetchChangedInvoicesFromBitrix({
      webhookUrl: "https://example.invalid/",
      sinceDate: null,
      request: async () => {
        const pages = Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [
            `page${i}`,
            { items: i === 0 ? Array.from({ length: 50 }, (_, j) => ({ id: j + 1 })) : [] },
          ])
        );
        const resultTotal = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`page${i}`, 100]));
        // result_next has wrong offset
        return {
          result: {
            result: pages,
            result_error: {},
            result_total: resultTotal,
            result_next: { page0: 999 },
          },
        };
      },
    }),
    /Invalid result_next for page0: expected 50, got 999/
  );
});

test("Fix6: unexpected result_next when total is reached is rejected", async () => {
  await assert.rejects(
    fetchChangedInvoicesFromBitrix({
      webhookUrl: "https://example.invalid/",
      sinceDate: null,
      request: async () => {
        const pages = Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [
            `page${i}`,
            { items: i === 0 ? Array.from({ length: 50 }, (_, j) => ({ id: j + 1 })) : [] },
          ])
        );
        const resultTotal = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`page${i}`, 50]));
        // page0 has 50 items, total is 50, so result_next should NOT be present
        return {
          result: {
            result: pages,
            result_error: {},
            result_total: resultTotal,
            result_next: { page0: 50 },
          },
        };
      },
    }),
    /Unexpected result_next for page0 when total 50 is reached/
  );
});

test("Fix6: subrequest error in result_error is rejected without leaking sensitive data", async () => {
  const secretWebhook = "https://b24-secret.invalid/rest/1/very_secret_token/";
  await assert.rejects(
    fetchChangedInvoicesFromBitrix({
      webhookUrl: secretWebhook,
      sinceDate: null,
      request: async () => ({
        result: {
          result: {},
          result_error: {
            page0: {
              error: "ACCESS_DENIED",
              error_description: "Access denied with token very_secret_token",
            },
          },
          result_total: {},
          result_next: {},
        },
      }),
    }),
    (err) => {
      assert.match(err.message, /Bitrix24 batch command failed: page0/);
      assert.equal(err.message.includes(secretWebhook), false, "Must not leak webhook URL");
      assert.equal(err.message.includes("very_secret_token"), false, "Must not leak secret token");
      return true;
    }
  );
});

test("Fix6: empty confirmed result total=0 with allowEmpty deletes all records safely", async () => {
  const pool = createMockTransactionalPool([{ invoice_id: "101" }]);
  const emptySnapshot = [];

  const emptyReq = createMockB24Request([]);
  const result = await importInvoicesFromSnapshot(emptySnapshot, {
    dryRun: false,
    allowEmpty: true,
    clientPool: pool,
    request: emptyReq,
  });

  assert.equal(result.total, 0);
  assert.equal(result.deleted, 1);
  assert.equal(pool.getInvoices().size, 0);
  const log = pool.getLog();
  assert.ok(log.some((entry) => entry.sql && entry.sql.includes("DELETE FROM invoices")));
  assert.ok(log.some((entry) => entry.sql === "COMMIT"));
});
