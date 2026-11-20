const SENSITIVE_QUERY_KEYS = "access_token|refresh_token|token|share_token";

/** Keep request URLs useful in logs while removing credentials carried in query strings. */
export function redactHttpUrl(url: string): string {
  const pattern = new RegExp(`([?&](?:${SENSITIVE_QUERY_KEYS})=)[^&#]*`, "gi");
  return url.replace(pattern, "$1[REDACTED]");
}
