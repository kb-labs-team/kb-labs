function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keep workflow input structure useful in logs while omitting env and secret values. */
export function summarizeWorkflowInput(
  input: Record<string, unknown>,
  declaredSecretNames: readonly string[] = [],
): Record<string, unknown> {
  const secretNames = new Set(declaredSecretNames)
  const summarize = (value: unknown, key?: string): unknown => {
    if (key === 'env' && isRecord(value)) {
      const keys = Object.keys(value)
      return {
        keys,
        declaredSecretKeys: keys.filter((name) => secretNames.has(name)),
      }
    }
    if (key === 'secrets' && isRecord(value)) {
      return { keys: Object.keys(value), declaredSecretKeys: Object.keys(value) }
    }
    if (Array.isArray(value)) return value.map((nested) => summarize(nested))
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([nestedKey, nested]) => [nestedKey, summarize(nested, nestedKey)]),
      )
    }
    return value
  }

  return summarize(input) as Record<string, unknown>
}
