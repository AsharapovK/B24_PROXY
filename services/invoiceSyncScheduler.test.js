import test from "node:test";
import assert from "node:assert/strict";
import { isInvoiceSyncEnabled, startInvoiceSyncScheduler } from "./invoiceSyncScheduler.js";

test("invoice sync defaults on and can be disabled explicitly", () => {
  assert.equal(isInvoiceSyncEnabled(undefined), true);
  assert.equal(isInvoiceSyncEnabled("true"), true);
  assert.equal(isInvoiceSyncEnabled("false"), false);
  assert.equal(isInvoiceSyncEnabled("0"), false);
});

test("disabled sync starts neither the immediate run nor interval", () => {
  let scheduled = 0;
  let invoked = 0;
  const timer = startInvoiceSyncScheduler({
    enabled: false,
    intervalMs: 600_000,
    runSync: () => { invoked += 1; },
    setIntervalImpl: () => { scheduled += 1; return {}; },
  });
  assert.equal(timer, null);
  assert.equal(scheduled, 0);
  assert.equal(invoked, 0);
});

test("enabled sync keeps its immediate run and periodic trigger", () => {
  let scheduledDelay;
  let invoked = 0;
  const timer = startInvoiceSyncScheduler({
    enabled: true,
    intervalMs: 600_000,
    runSync: () => { invoked += 1; },
    setIntervalImpl: (_callback, delay) => {
      scheduledDelay = delay;
      return { unref() {} };
    },
  });
  assert.ok(timer);
  assert.equal(scheduledDelay, 600_000);
  assert.equal(invoked, 1);
});
