/**
 * Resolve artifact data from step outputs using dot-path notation.
 *
 * @example
 * resolveArtifactData('outputs.plan', { plan: '# My Plan' })
 * // → '# My Plan'
 *
 * resolveArtifactData('outputs.review.issues', { review: { issues: [...] } })
 * // → [...]
 */
export function resolveArtifactData(
  source: string,
  outputs: Record<string, unknown> | undefined,
): unknown {
  if (!outputs) {return undefined}

  // Strip leading "outputs." prefix if present
  const path = source.startsWith('outputs.') ? source.slice(8) : source

  const parts = path.split('.')
  let current: unknown = outputs

  for (const part of parts) {
    if (current == null || typeof current !== 'object') {return undefined}
    current = (current as Record<string, unknown>)[part]
  }

  return current
}
