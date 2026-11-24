/** Keep the path useful in logs and omit all query data that could carry credentials. */
export function redactHttpUrl(url: string): string {
  const queryStart = url.indexOf("?");
  const fragmentStart = url.indexOf("#");
  const firstDelimiter = queryStart < 0
    ? fragmentStart
    : fragmentStart < 0 ? queryStart : Math.min(queryStart, fragmentStart);
  return firstDelimiter < 0 ? url : url.slice(0, firstDelimiter);
}
