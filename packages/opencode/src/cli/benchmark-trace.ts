const CREDENTIAL_FIELDS = new Set([
  "apikey",
  "accesstoken",
  "authorization",
  "authorizationheader",
  "authtoken",
  "clientsecret",
  "cookie",
  "credentials",
  "githubtoken",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretkey",
  "signedcredential",
])
const CREDENTIAL_FIELD_SUFFIXES = [
  "apikey",
  "accesskey",
  "accesstoken",
  "authorization",
  "authorizationheader",
  "authtoken",
  "clientsecret",
  "cookie",
  "credentials",
  "githubtoken",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretaccesskey",
  "secretkey",
  "signedcredential",
] as const

const ACCOUNTING_FIELDS = new Set([
  "accumulatedcost",
  "accumulatedtokenusage",
  "cachereadtokens",
  "cachewritetokens",
  "cachedtokens",
  "completiontokens",
  "cost",
  "costusd",
  "currency",
  "estimatedcost",
  "estimatedcostusd",
  "inputtokens",
  "outputtokens",
  "price",
  "prompttokens",
  "reasoningtokens",
  "tokencount",
  "tokens",
  "totalcost",
  "totalcostusd",
  "totaltokens",
  "usage",
  "usagesummary",
  "usagetometrics",
])
const ACCOUNTING_FIELD_SUFFIXES = [...ACCOUNTING_FIELDS]

export function sanitizeBenchmarkTrace(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeBenchmarkTrace)
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
        if (
          matchesField(normalized, CREDENTIAL_FIELDS, CREDENTIAL_FIELD_SUFFIXES) ||
          matchesField(normalized, ACCOUNTING_FIELDS, ACCOUNTING_FIELD_SUFFIXES)
        )
          return []
        return [[key, sanitizeBenchmarkTrace(item)]]
      }),
    )
  }
  if (typeof value === "string") return sanitizeText(value)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function sanitizeText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gs, "<redacted:private_key>")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "<redacted:authorization>")
    .replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g, "<redacted:model_api_key>")
    .replace(/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g, "<redacted:github_token>")
    .replace(/(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g, "<redacted:cloud_access_key>")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^:/@\s]+):([^/@\s]+)@/gi, "$1$2:<redacted:uri_password>@")
    .replace(
      /(?<![A-Za-z0-9_])(--?)?((?:[A-Za-z_][A-Za-z0-9_-]*?)?(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|authorization(?:[_-]?header)?|client[_-]?secret|cookie|credentials|github[_-]?token|password|private[_-]?key|refresh[_-]?token|secret(?:[_-]?access)?[_-]?key|secret|signed[_-]?credential))\s*(?:=|\s)\s*(?!<redacted:)(['"]?)([^\s'"]{4,})\3/gi,
      "$1$2=<redacted:assignment>",
    )
}

function matchesField(normalized: string, exact: ReadonlySet<string>, suffixes: readonly string[]): boolean {
  return exact.has(normalized) || suffixes.some((suffix) => normalized !== suffix && normalized.endsWith(suffix))
}
