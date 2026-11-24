const SENSITIVE_QUERY_KEYS = new Set(["access_token", "refresh_token", "token", "share_token"]);

/** Keep request URLs useful in logs while removing credentials carried in query strings. */
export function redactHttpUrl(url: string): string {
  const queryStart = url.indexOf("?");
  const fragmentStart = url.indexOf("#");
  const firstDelimiter = queryStart < 0
    ? fragmentStart
    : fragmentStart < 0 ? queryStart : Math.min(queryStart, fragmentStart);
  if (firstDelimiter < 0) { return url; }

  const query = url.slice(firstDelimiter + 1);
  const redactedQuery = query.split("&").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) { return part; }
    const rawKey = part.slice(0, separator);
    let key: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, " ")).toLowerCase();
    } catch {
      key = rawKey.toLowerCase();
    }
    return SENSITIVE_QUERY_KEYS.has(key) ? `${rawKey}=[REDACTED]` : part;
  }).join("&");
  return `${url.slice(0, firstDelimiter)}${url[firstDelimiter]}${redactedQuery}`;
}
