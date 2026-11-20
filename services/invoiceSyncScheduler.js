const DISABLED_VALUES = new Set(["false", "0", "no", "off"]);

export function isInvoiceSyncEnabled(value = process.env.INVOICE_SYNC_ENABLED) {
  return !DISABLED_VALUES.has(String(value ?? "true").trim().toLowerCase());
}

export function startInvoiceSyncScheduler({
  enabled = isInvoiceSyncEnabled(),
  intervalMs,
  runSync,
  setIntervalImpl = setInterval,
}) {
  if (!enabled) return null;

  const timer = setIntervalImpl(runSync, intervalMs);
  timer?.unref?.();
  void runSync();
  return timer;
}
