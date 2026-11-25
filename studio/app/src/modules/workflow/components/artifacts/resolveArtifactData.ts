/**
 * Resolve artifact data from step outputs using dot-path notation.
 * Qualified sources can only refer to the step declaring the artifact.
 *
 * @example
 * resolveArtifactData('outputs.plan', { plan: '# My Plan' })
 * // → '# My Plan'
 *
 * resolveArtifactData('outputs.review.issues', { review: { issues: [...] } })
 * // → [...]
 *
 * resolveArtifactData('steps.build.outputs', { passed: true }, 'build')
 * // → { passed: true }
 */
export function resolveArtifactData(
  source: string,
  outputs: Record<string, unknown> | undefined,
  stepId?: string,
): unknown {
  if (!outputs) {return undefined}

  let parts = source.split('.')
  if (parts[0] === 'steps' && parts.length > 1) {
    if (!stepId || parts[1] !== stepId || parts[2] !== 'outputs') {return undefined}
    parts = parts.slice(3)
  } else if (parts[0] === 'outputs' && parts.length > 1) {
    parts = parts.slice(1)
  }

  let current: unknown = outputs

  for (const part of parts) {
    if (current == null || typeof current !== 'object' || !Object.hasOwn(current, part)) {return undefined}
    current = (current as Record<string, unknown>)[part]
  }

  return current
}
