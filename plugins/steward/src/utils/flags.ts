/** Parses a `--flag=a,b,c` value into a trimmed string list. */
export function parseList(csv?: string): string[] | undefined {
  if (csv === undefined) {return undefined;}
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parses an ISO date/time flag into epoch milliseconds. Throws on garbage input. */
export function parseDate(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid date: "${value}" — expected ISO 8601 (e.g. 2026-09-01)`);
  }
  return ms;
}
