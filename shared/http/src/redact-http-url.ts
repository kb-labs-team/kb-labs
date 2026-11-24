const SENSITIVE_QUERY_KEYS = new Set(["access_token", "refresh_token", "token", "share_token"]);

/** Keep request URLs useful in logs while removing credentials carried in query strings. */
export function redactHttpUrl(url: string): string {
  const questionMark = url.indexOf("?");
  const hash = url.indexOf("#");
  const queryStart = questionMark < 0 ? hash : hash < 0 ? questionMark : Math.min(questionMark, hash);
  if (queryStart < 0) { return url; }

  // find-my-way treats the first '?' or '#' as the query delimiter; after
  // that delimiter, a later '#' is ordinary query data.
  const query = url.slice(queryStart + 1);
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
  return `${url.slice(0, queryStart)}${url[queryStart]}${redactedQuery}`;
}
