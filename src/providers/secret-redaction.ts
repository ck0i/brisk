const REDACTED = "[REDACTED]";

const AUTHORIZATION = /(\bauthorization\b\s*[:=]\s*["']?)(?:bearer\s+)?([^\s,"';}]+)/gi;
const CREDENTIAL_ASSIGNMENT =
  /(\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|token)\b\s*[:=]\s*["']?)([^\s,"';}]+)/gi;
const BEARER = /(\bbearer\s+)([^\s,"';}]+)/gi;
const CREDENTIAL_QUERY =
  /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key)=)([^&#\s]+)/gi;
const COMMON_KEY = /\b(?:sk|pk)-(?:ant-)?[A-Za-z0-9._-]{8,}\b/g;

/** Redact explicit credential values and common credential-bearing string shapes. */
export function redactSecrets(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  const uniqueSecrets = [...new Set(secrets)].filter((secret) => secret.length > 0);
  uniqueSecrets.sort((left, right) => right.length - left.length);
  for (const secret of uniqueSecrets) redacted = redacted.replaceAll(secret, REDACTED);

  return redacted
    .replace(AUTHORIZATION, `$1${REDACTED}`)
    .replace(CREDENTIAL_ASSIGNMENT, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(CREDENTIAL_QUERY, `$1${REDACTED}`)
    .replace(COMMON_KEY, REDACTED);
}

export function redactedErrorMessage(
  error: unknown,
  secrets: readonly string[] = [],
  fallback = "Unknown provider error",
): string {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  return redactSecrets(message || fallback, secrets);
}
