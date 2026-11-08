const REDACTED = "[REDACTED]";

const SECRET_KEY_RE = /(?:^|[_-])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|auth|password|passwd|secret|api[_-]?key|private[_-]?key|client[_-]?secret|cookie|set[_-]?cookie|signature|webhook[_-]?url)(?:$|[_-])|^key$/i;
const SECRET_TEXT_RE = /(bearer\s+)[a-z0-9._~+/=-]+|((?:access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|auth|password|passwd|secret|api[_-]?key|private[_-]?key|client[_-]?secret|signature|(?<=^|[?&\s])(?:key|token))=)[^&\s]+/gi;

function isSecretKey(key) {
  const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return SECRET_KEY_RE.test(normalized);
}

export function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSecretKey(key) ? REDACTED : scrubSecrets(entry),
      ])
    );
  }
  if (typeof value === "string") {
    return value.replace(SECRET_TEXT_RE, (match, bearer, queryPrefix) => {
      if (bearer) return `${bearer}${REDACTED}`;
      if (queryPrefix) return `${queryPrefix}${REDACTED}`;
      return REDACTED;
    });
  }
  return value;
}

export function sanitizeRequestParams(params) {
  if (params === null || params === undefined) return {};
  const scrubbed = scrubSecrets(params);
  if (Array.isArray(scrubbed)) return { value: scrubbed };
  return scrubbed && typeof scrubbed === "object" ? scrubbed : { value: scrubbed };
}

export function collectRequestParams(req) {
  const params = {};
  if (req.query && typeof req.query === "object") params.query = req.query;
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    params.body = req.body;
  }
  return params;
}
