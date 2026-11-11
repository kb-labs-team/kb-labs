import type { ExpressionContext, WorkflowInvocationSpec } from './types'

/**
 * Parse workflow: uses string into WorkflowInvocationSpec
 * @param uses - The uses string (e.g., "workflow:workspace:ai-ci")
 * @returns WorkflowInvocationSpec or null if not a workflow uses
 */
export function parseWorkflowUses(uses: string): WorkflowInvocationSpec | null {
  if (!uses.startsWith('workflow:')) {
    return null
  }

  const workflowId = uses.slice('workflow:'.length)
  if (!workflowId) {
    return null
  }

  return {
    type: 'workflow',
    workflowId,
    mode: 'wait', // default
    inheritEnv: true, // default
  }
}

/**
 * Extract all ${{ expression }} patterns from a string
 */
export function extractExpressions(str: string): string[] {
  const pattern = /\$\{\{\s*([^}]+)\s*\}\}/g
  const matches: string[] = []
  let match: RegExpExecArray | null

  while ((match = pattern.exec(str)) !== null) {
    matches.push(match[1]!.trim())
  }

  return matches
}

/**
 * Evaluate a boolean expression
 * Supported operators: ==, !=, &&, ||, !
 * Supported functions: contains(), startsWith(), endsWith()
 * Supported contexts: env.*, trigger.*, steps.*.outputs.*
 */
export function evaluateExpression(
  expr: string,
  context: ExpressionContext,
): boolean {
  const trimmed = expr.trim()

  // Handle logical operators. || has lower precedence than && — split on ||
  // first so && operands are evaluated as a unit, not the other way around.
  // Use splitOnOperator so quoted strings (e.g. "a && b") are not split.
  const orParts = splitOnOperator(trimmed, '||')
  if (orParts.length > 1) {
    return orParts.some((part) => evaluateExpression(part.trim(), context))
  }

  const andParts = splitOnOperator(trimmed, '&&')
  if (andParts.length > 1) {
    return andParts.every((part) => evaluateExpression(part.trim(), context))
  }

  // Handle negation
  if (trimmed.startsWith('!')) {
    return !evaluateExpression(trimmed.slice(1).trim(), context)
  }

  // Handle parentheses (simple case)
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    return evaluateExpression(trimmed.slice(1, -1).trim(), context)
  }

  // Handle boolean literals (before equality checks)
  if (trimmed === 'true') {return true}
  if (trimmed === 'false') {return false}

  // Handle equality/inequality
  if (trimmed.includes('==')) {
    const parts = trimmed.split('==').map((s) => s.trim())
    if (parts.length === 2 && parts[0] && parts[1]) {
      const left = resolveValue(parts[0], context)
      const right = resolveValue(parts[1], context)
      // For numeric comparison, try numeric first
      if (typeof left === 'number' && typeof right === 'number') {
        return left === right
      }
      // Otherwise coerce to string
      return coerceToString(left) === coerceToString(right)
    }
  }

  if (trimmed.includes('!=')) {
    const parts = trimmed.split('!=').map((s) => s.trim())
    if (parts.length === 2 && parts[0] && parts[1]) {
      const left = resolveValue(parts[0], context)
      const right = resolveValue(parts[1], context)
      // For numeric comparison, try numeric first
      if (typeof left === 'number' && typeof right === 'number') {
        return left !== right
      }
      // Otherwise coerce to string
      return coerceToString(left) !== coerceToString(right)
    }
  }

  // Handle functions
  if (trimmed.includes('contains(')) {
    const match = trimmed.match(/contains\(([^,]+),\s*([^)]+)\)/)
    if (match && match[1] && match[2]) {
      const value = resolveValue(match[1].trim(), context)
      const search = match[2].trim().replace(/^["']|["']$/g, '')
      return String(value).includes(search)
    }
  }

  if (trimmed.includes('startsWith(')) {
    const match = trimmed.match(/startsWith\(([^,]+),\s*([^)]+)\)/)
    if (match && match[1] && match[2]) {
      const value = resolveValue(match[1].trim(), context)
      const prefix = match[2].trim().replace(/^["']|["']$/g, '')
      return String(value).startsWith(prefix)
    }
  }

  if (trimmed.includes('endsWith(')) {
    const match = trimmed.match(/endsWith\(([^,]+),\s*([^)]+)\)/)
    if (match && match[1] && match[2]) {
      const value = resolveValue(match[1].trim(), context)
      const suffix = match[2].trim().replace(/^["']|["']$/g, '')
      return String(value).endsWith(suffix)
    }
  }

  // Fallback: treat as truthy/falsy
  const value = resolveValue(trimmed, context)
  return Boolean(value)
}

/**
 * Resolve a value from context (e.g., "env.VAR", "steps.build.outputs.version")
 */
export function resolveValue(path: string, context: ExpressionContext): unknown {
  // Remove quotes
  const cleanPath = path.replace(/^["']|["']$/g, '')

  // env.VAR
  if (cleanPath.startsWith('env.')) {
    const key = cleanPath.slice('env.'.length)
    return context.env[key] ?? ''
  }

  // trigger.type, trigger.actor, trigger.payload.*
  if (cleanPath.startsWith('trigger.')) {
    const key = cleanPath.slice('trigger.'.length)
    if (key === 'type') {
      return context.trigger.type
    }
    if (key === 'actor') {
      return context.trigger.actor ?? ''
    }
    if (key.startsWith('payload.')) {
      const payloadKey = key.slice('payload.'.length)
      return context.trigger.payload?.[payloadKey] ?? ''
    }
    return ''
  }

  // steps.<id>.outputs.<key>[.<nested>...]
  if (cleanPath.startsWith('steps.')) {
    const rest = cleanPath.slice('steps.'.length)
    const match = rest.match(/^([^.]+)\.outputs\.(.+)$/)
    if (match) {
      const stepId = match[1]!
      const outputKey = match[2]!
      const outputs = context.steps[stepId]?.outputs
      if (outputs === undefined) {return ''}
      // Navigate nested path (e.g. "result.passed" → outputs.result.passed)
      const parts = outputKey.split('.')
      let value: unknown = outputs
      for (const part of parts) {
        if (value === undefined || value === null || typeof value !== 'object') {return ''}
        value = (value as Record<string, unknown>)[part]
      }
      return value !== undefined ? value : ''
    }
    return ''
  }

  // inputs.*
  if (cleanPath.startsWith('inputs.') && context.inputs) {
    const key = cleanPath.slice('inputs.'.length)
    return context.inputs[key] ?? ''
  }

  // matrix.* (for future)
  if (cleanPath.startsWith('matrix.') && context.matrix) {
    const key = cleanPath.slice('matrix.'.length)
    return context.matrix[key] ?? ''
  }

  // Try to parse as number
  const num = Number(cleanPath)
  if (!isNaN(num) && isFinite(num)) {
    return num
  }

  // Try to parse as boolean
  if (cleanPath === 'true') {return true}
  if (cleanPath === 'false') {return false}

  // Literal value
  return cleanPath
}

/**
 * Coerce value to string for comparison
 */
export function coerceToString(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

/**
 * Interpolate string with context values
 * Example: "Version: ${{ steps.build.outputs.version }}"
 */
export function interpolateString(
  str: string,
  context: ExpressionContext,
): string {
  const expressions = extractExpressions(str)
  let result = str

  for (const expr of expressions) {
    const value = resolveValueWithFallback(expr, context)
    const replacement = coerceToString(value)
    const pattern = new RegExp(
      `\\$\\{\\{\\s*${escapeRegex(expr)}\\s*\\}\\}`,
      'g',
    )
    result = result.replace(pattern, replacement)
  }

  return result
}

/**
 * Build a shell-safe command from a `run:` block by injecting ${{ expr }} values
 * as environment variables instead of raw string substitution.
 *
 * Raw substitution is unsafe because issue/PR titles may contain shell metacharacters
 * (backticks, $(), quotes). When content arrives via an env var, shell expansion of
 * the variable does NOT re-evaluate backticks or $() — they are literal characters.
 *
 * Single-quote context: when ${{ expr }} is wrapped in single quotes — the natural
 * pattern for `jq --argjson x '${{ inputs.payload }}'` — bash single-quote semantics
 * would prevent ${_WF_var} from expanding. The single-quoted wrapper is replaced with
 * a double-quoted reference instead:
 *
 * Example:
 *   Input:  `echo "${{ steps.issue.outputs.title }}"`
 *   Output: command = `echo "${_WF_steps_issue_outputs_title}"`
 *           shellEnvVars = { _WF_steps_issue_outputs_title: "Add `kb cancel` command" }
 *
 *   Input:  `jq --argjson payload '${{ inputs.invoice_payload }}' '{"x":1}'`
 *   Output: command = `jq --argjson payload "${_WF_inputs_invoice_payload}" '{"x":1}'`
 *           shellEnvVars = { _WF_inputs_invoice_payload: '{"vendor":"Acme","total":250}' }
 */
export function buildShellSafeCommand(
  rawRun: string,
  context: ExpressionContext,
): { command: string; shellEnvVars: Record<string, string> } {
  const expressions = extractExpressions(rawRun)
  const shellEnvVars: Record<string, string> = {}
  let command = rawRun

  for (const expr of expressions) {
    const value = resolveValueWithFallback(expr, context)
    const strValue = coerceToString(value)

    // Build a safe shell variable name from the expression.
    // Replace any non-alphanumeric/underscore chars with underscore.
    const safeName = '_WF_' + expr.trim().replace(/[^a-zA-Z0-9_]/g, '_')
    shellEnvVars[safeName] = strValue

    // Replace '${{ expr }}' (single-quote wrapped) with "${_WF_var}" (double-quoted).
    // Single quotes in bash prevent ${...} expansion; switching to double quotes fixes it.
    const sqPattern = new RegExp(
      `'\\$\\{\\{\\s*${escapeRegex(expr)}\\s*\\}\\}'`,
      'g',
    )
    command = command.replace(sqPattern, `"\${${safeName}}"`)

    // Replace remaining unquoted/double-quoted occurrences with ${_WF_var}.
    const pattern = new RegExp(`\\$\\{\\{\\s*${escapeRegex(expr)}\\s*\\}\\}`, 'g')
    command = command.replace(pattern, `\${${safeName}}`)
  }

  return { command, shellEnvVars }
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Resolve a value expression with || (logical OR / default value) support.
 * Returns the first truthy value, or the last value if all are falsy.
 * Example: "trigger.payload.mode || 'heuristic'" → value of mode, or 'heuristic' if empty/undefined
 */
function resolveValueWithFallback(expr: string, context: ExpressionContext): unknown {
  // Split on || (but not inside quotes)
  const parts = splitOnOperator(expr, '||')
  if (parts.length === 1) {
    return resolveValue(parts[0]!.trim(), context)
  }

  // Return first truthy value, or last value
  for (let i = 0; i < parts.length; i++) {
    const value = resolveValue(parts[i]!.trim(), context)
    // Truthy check: non-empty string, non-zero number, non-false boolean, non-null object
    if (isTruthy(value)) {
      return value
    }
    // Last part — return even if falsy
    if (i === parts.length - 1) {
      return value
    }
  }

  return ''
}

/**
 * Split expression string on an operator, respecting quoted strings.
 * Example: "a || 'hello || world'" → ["a ", " 'hello || world'"]
 */
function splitOnOperator(expr: string, op: string): string[] {
  const parts: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let i = 0

  while (i < expr.length) {
    const ch = expr[i]!

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      current += ch
      i++
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      current += ch
      i++
    } else if (!inSingle && !inDouble && expr.slice(i, i + op.length) === op) {
      parts.push(current)
      current = ''
      i += op.length
    } else {
      current += ch
      i++
    }
  }

  parts.push(current)
  return parts
}

/**
 * Check if a resolved value is "truthy" for || operator purposes.
 * Empty string, null, undefined, false, 0 are falsy.
 */
function isTruthy(value: unknown): boolean {
  if (value === '' || value === null || value === undefined || value === false || value === 0) {
    return false
  }
  return true
}

/**
 * Resolve expression preserving types.
 * If the string is exactly one `${{ expr }}` (no surrounding text),
 * returns the raw value (object, number, boolean, etc.).
 * Supports || operator for default values: `${{ a || 'default' }}`
 * Otherwise delegates to interpolateString (returns string).
 */
export function resolveExpression(
  str: string,
  context: ExpressionContext,
): unknown {
  const trimmed = str.trim()

  // Check if the entire string is a single expression
  const singleExprMatch = trimmed.match(/^\$\{\{\s*([^}]+)\s*\}\}$/)
  if (singleExprMatch && singleExprMatch[1]) {
    return resolveValueWithFallback(singleExprMatch[1].trim(), context)
  }

  // Multiple expressions or text around them — interpolate as string
  if (trimmed.includes('${{')) {
    return interpolateString(trimmed, context)
  }

  // No expressions — return as-is
  return str
}

/**
 * Recursively interpolate all string values in an object/array.
 * - Strings: resolved via resolveExpression (type-preserving)
 * - Arrays: each element interpolated recursively
 * - Objects: each value interpolated recursively
 * - Primitives (number, boolean, null): returned as-is
 */
export function interpolateObject(
  obj: Record<string, unknown>,
  context: ExpressionContext,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(obj)) {
    result[key] = interpolateValue(value, context)
  }

  return result
}

/**
 * Interpolate a single value recursively
 */
function interpolateValue(value: unknown, context: ExpressionContext): unknown {
  if (typeof value === 'string') {
    return resolveExpression(value, context)
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, context))
  }

  if (value !== null && typeof value === 'object') {
    return interpolateObject(value as Record<string, unknown>, context)
  }

  // number, boolean, null, undefined — pass through
  return value
}

