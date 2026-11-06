import { describe, it, expect } from 'vitest'
import { evaluateExpression, interpolateString, resolveExpression, interpolateObject, resolveValue, coerceToString, buildShellSafeCommand } from '../expressions'
import type { ExpressionContext } from '../types'

describe('Expression Evaluation', () => {
  const baseContext: ExpressionContext = {
    env: { NODE_ENV: 'production', VERSION: '1.0.0' },
    trigger: {
      type: 'push',
      actor: 'user',
      payload: { ref: 'refs/heads/main' },
    },
    steps: {},
  }

  it('should evaluate boolean literals', () => {
    expect(evaluateExpression('true', baseContext)).toBe(true)
    expect(evaluateExpression('false', baseContext)).toBe(false)
  })

  it('should evaluate equality', () => {
    expect(evaluateExpression('env.NODE_ENV == "production"', baseContext)).toBe(true)
    expect(evaluateExpression('env.NODE_ENV == "development"', baseContext)).toBe(false)
  })

  it('should evaluate inequality', () => {
    expect(evaluateExpression('env.NODE_ENV != "development"', baseContext)).toBe(true)
    expect(evaluateExpression('env.NODE_ENV != "production"', baseContext)).toBe(false)
  })

  it('should evaluate contains function', () => {
    expect(evaluateExpression('contains(env.VERSION, "1.0")', baseContext)).toBe(true)
    expect(evaluateExpression('contains(env.VERSION, "2.0")', baseContext)).toBe(false)
  })

  it('should evaluate startsWith function', () => {
    expect(evaluateExpression('startsWith(trigger.payload.ref, "refs/heads/")', baseContext)).toBe(true)
    expect(evaluateExpression('startsWith(trigger.payload.ref, "refs/tags/")', baseContext)).toBe(false)
  })

  it('should evaluate endsWith function', () => {
    expect(evaluateExpression('endsWith(trigger.payload.ref, "/main")', baseContext)).toBe(true)
    expect(evaluateExpression('endsWith(trigger.payload.ref, "/develop")', baseContext)).toBe(false)
  })

  it('should handle parentheses', () => {
    expect(evaluateExpression('(true)', baseContext)).toBe(true)
    expect(evaluateExpression('(env.NODE_ENV == "production")', baseContext)).toBe(true)
  })

  it('should interpolate strings', () => {
    const result = interpolateString('Hello ${{ env.NODE_ENV }}', baseContext)
    expect(result).toBe('Hello production')
  })

  it('should interpolate multiple expressions', () => {
    const result = interpolateString('Version ${{ env.VERSION }} by ${{ trigger.actor }}', baseContext)
    expect(result).toBe('Version 1.0.0 by user')
  })

  it('should handle step outputs', () => {
    const contextWithSteps: ExpressionContext = {
      ...baseContext,
      steps: {
        test: {
          outputs: {
            exitCode: 0,
            result: 'success',
          },
        },
      },
    }

    // String comparison - both sides are coerced to string
    expect(evaluateExpression('steps.test.outputs.exitCode == 0', contextWithSteps)).toBe(true)
    expect(evaluateExpression('steps.test.outputs.result == success', contextWithSteps)).toBe(true)
  })

  it('should handle empty expressions', () => {
    expect(evaluateExpression('', baseContext)).toBe(false)
    expect(evaluateExpression('   ', baseContext)).toBe(false)
  })
})

describe('resolveValue', () => {
  const ctx: ExpressionContext = {
    env: { REGION: 'us-east-1', COUNT: '42' },
    trigger: {
      type: 'manual',
      actor: 'alice',
      payload: { branch: 'main', depth: 3 },
    },
    steps: {
      build: {
        outputs: { version: '2.1.0', passed: true, score: 99 },
      },
    },
    matrix: { os: 'ubuntu', node: 20 },
  }

  it('resolves env variables', () => {
    expect(resolveValue('env.REGION', ctx)).toBe('us-east-1')
    expect(resolveValue('env.MISSING', ctx)).toBe('')
  })

  it('resolves trigger.type and trigger.actor', () => {
    expect(resolveValue('trigger.type', ctx)).toBe('manual')
    expect(resolveValue('trigger.actor', ctx)).toBe('alice')
  })

  it('resolves trigger.payload fields', () => {
    expect(resolveValue('trigger.payload.branch', ctx)).toBe('main')
    expect(resolveValue('trigger.payload.depth', ctx)).toBe(3)
    expect(resolveValue('trigger.payload.missing', ctx)).toBe('')
  })

  it('resolves step outputs', () => {
    expect(resolveValue('steps.build.outputs.version', ctx)).toBe('2.1.0')
    expect(resolveValue('steps.build.outputs.passed', ctx)).toBe(true)
    expect(resolveValue('steps.build.outputs.score', ctx)).toBe(99)
  })

  it('returns empty string for unknown step', () => {
    expect(resolveValue('steps.missing.outputs.foo', ctx)).toBe('')
  })

  it('resolves matrix values', () => {
    expect(resolveValue('matrix.os', ctx)).toBe('ubuntu')
    expect(resolveValue('matrix.node', ctx)).toBe(20)
  })

  it('parses numeric literals', () => {
    expect(resolveValue('0', ctx)).toBe(0)
    expect(resolveValue('3.14', ctx)).toBe(3.14)
  })

  it('parses boolean literals', () => {
    expect(resolveValue('true', ctx)).toBe(true)
    expect(resolveValue('false', ctx)).toBe(false)
  })

  it('strips surrounding quotes from string literals', () => {
    expect(resolveValue('"hello"', ctx)).toBe('hello')
    expect(resolveValue("'world'", ctx)).toBe('world')
  })

  it('returns the raw path string for unrecognised paths', () => {
    expect(resolveValue('unknown.path', ctx)).toBe('unknown.path')
  })
})

describe('resolveExpression', () => {
  const ctx: ExpressionContext = {
    env: { NODE_ENV: 'production' },
    trigger: { type: 'push' },
    steps: {
      lint: {
        outputs: { passed: true, count: 7, label: 'ok', report: { errors: 0 } },
      },
    },
  }

  it('returns raw value when the whole string is a single expression (boolean)', () => {
    const result = resolveExpression('${{ steps.lint.outputs.passed }}', ctx)
    expect(result).toBe(true)
  })

  it('returns raw value when the whole string is a single expression (number)', () => {
    const result = resolveExpression('${{ steps.lint.outputs.count }}', ctx)
    expect(result).toBe(7)
  })

  it('returns raw value when the whole string is a single expression (object)', () => {
    const result = resolveExpression('${{ steps.lint.outputs.report }}', ctx)
    expect(result).toEqual({ errors: 0 })
  })

  it('returns a string when there is surrounding text mixed with an expression', () => {
    const result = resolveExpression('env=${{ env.NODE_ENV }}', ctx)
    expect(result).toBe('env=production')
    expect(typeof result).toBe('string')
  })

  it('returns a string when multiple expressions are present', () => {
    const result = resolveExpression(
      '${{ env.NODE_ENV }} / ${{ steps.lint.outputs.label }}',
      ctx,
    )
    expect(result).toBe('production / ok')
    expect(typeof result).toBe('string')
  })

  it('returns the original string when there are no expressions', () => {
    expect(resolveExpression('plain text', ctx)).toBe('plain text')
    expect(resolveExpression('  no braces  ', ctx)).toBe('  no braces  ')
  })

  it('handles whitespace inside expression delimiters', () => {
    const result = resolveExpression('${{  steps.lint.outputs.count  }}', ctx)
    expect(result).toBe(7)
  })
})

describe('interpolateObject', () => {
  const ctx: ExpressionContext = {
    env: { TAG: 'v1.2.3', DEBUG: 'false' },
    trigger: { type: 'tag' },
    steps: {
      test: {
        outputs: { passed: true, suite: 'unit', total: 42 },
      },
    },
  }

  it('interpolates top-level string values', () => {
    const result = interpolateObject(
      { tag: '${{ env.TAG }}', mode: 'release' },
      ctx,
    )
    expect(result.tag).toBe('v1.2.3')
    expect(result.mode).toBe('release')
  })

  it('preserves type of single-expression values (boolean)', () => {
    const result = interpolateObject(
      { ok: '${{ steps.test.outputs.passed }}' },
      ctx,
    )
    expect(result.ok).toBe(true)
  })

  it('preserves type of single-expression values (number)', () => {
    const result = interpolateObject(
      { total: '${{ steps.test.outputs.total }}' },
      ctx,
    )
    expect(result.total).toBe(42)
  })

  it('passes through non-string primitives unchanged', () => {
    const result = interpolateObject({ count: 99, flag: false, nothing: null }, ctx)
    expect(result.count).toBe(99)
    expect(result.flag).toBe(false)
    expect(result.nothing).toBeNull()
  })

  it('recursively interpolates nested objects', () => {
    const result = interpolateObject(
      {
        meta: {
          tag: '${{ env.TAG }}',
          suite: '${{ steps.test.outputs.suite }}',
        },
      },
      ctx,
    )
    expect((result.meta as Record<string, unknown>).tag).toBe('v1.2.3')
    expect((result.meta as Record<string, unknown>).suite).toBe('unit')
  })

  it('recursively interpolates elements inside arrays', () => {
    const result = interpolateObject(
      { tags: ['${{ env.TAG }}', 'latest', '${{ steps.test.outputs.suite }}'] },
      ctx,
    )
    expect(result.tags).toEqual(['v1.2.3', 'latest', 'unit'])
  })

  it('handles arrays of objects', () => {
    const result = interpolateObject(
      {
        steps: [
          { name: 'deploy', tag: '${{ env.TAG }}' },
          { name: 'verify', passed: '${{ steps.test.outputs.passed }}' },
        ],
      },
      ctx,
    )
    const steps = result.steps as Array<Record<string, unknown>>
    expect(steps[0]?.tag).toBe('v1.2.3')
    expect(steps[1]?.passed).toBe(true)
  })

  it('returns an empty object unchanged', () => {
    expect(interpolateObject({}, ctx)).toEqual({})
  })
})

describe('|| (logical OR / default value) operator', () => {
  const ctx: ExpressionContext = {
    env: { REGION: 'us-east-1' },
    trigger: {
      type: 'manual',
      payload: { mode: 'full', empty: '' },
    },
    steps: {
      build: {
        outputs: { version: '2.0.0', passed: true },
      },
    },
  }

  it('resolveExpression: returns value when present', () => {
    const result = resolveExpression("${{ trigger.payload.mode || 'heuristic' }}", ctx)
    expect(result).toBe('full')
  })

  it('resolveExpression: returns default when value is empty string', () => {
    const result = resolveExpression("${{ trigger.payload.empty || 'fallback' }}", ctx)
    expect(result).toBe('fallback')
  })

  it('resolveExpression: returns default when value is missing', () => {
    const result = resolveExpression("${{ trigger.payload.missing || 'default' }}", ctx)
    expect(result).toBe('default')
  })

  it('resolveExpression: chains multiple fallbacks', () => {
    const result = resolveExpression("${{ trigger.payload.missing || trigger.payload.empty || 'last' }}", ctx)
    expect(result).toBe('last')
  })

  it('resolveExpression: preserves non-string types', () => {
    const result = resolveExpression('${{ steps.build.outputs.passed || false }}', ctx)
    expect(result).toBe(true)
  })

  it('resolveExpression: returns numeric default', () => {
    const result = resolveExpression('${{ trigger.payload.missing || 42 }}', ctx)
    expect(result).toBe(42)
  })

  it('interpolateString: works in embedded expressions', () => {
    const result = interpolateString("Mode: ${{ trigger.payload.missing || 'heuristic' }}", ctx)
    expect(result).toBe('Mode: heuristic')
  })

  it('interpolateString: uses value when present', () => {
    const result = interpolateString("Mode: ${{ trigger.payload.mode || 'heuristic' }}", ctx)
    expect(result).toBe('Mode: full')
  })

  it('interpolateObject: works with || in object values', () => {
    const result = interpolateObject(
      { mode: "${{ trigger.payload.missing || 'heuristic' }}" },
      ctx,
    )
    expect(result.mode).toBe('heuristic')
  })

  it('evaluateExpression: || still works for boolean evaluation', () => {
    expect(evaluateExpression('false || true', ctx)).toBe(true)
    expect(evaluateExpression('false || false', ctx)).toBe(false)
  })

  it('handles || inside quotes (no split)', () => {
    // "hello || world" is a single quoted literal, should NOT split on ||
    const result = resolveExpression("${{ trigger.payload.missing || 'a || b' }}", ctx)
    expect(result).toBe('a || b')
  })
})

describe('coerceToString (BUG-001 — direct unit)', () => {
  it('returns string values unchanged', () => {
    expect(coerceToString('hello')).toBe('hello')
    expect(coerceToString('{"foo":1}')).toBe('{"foo":1}')
  })

  it('JSON.stringifies objects', () => {
    expect(coerceToString({ vendor: 'ACME', amount: 5000 })).toBe('{"vendor":"ACME","amount":5000}')
  })

  it('JSON.stringifies arrays', () => {
    expect(coerceToString([{ desc: 'Consulting' }])).toBe('[{"desc":"Consulting"}]')
  })

  it('handles boolean', () => {
    expect(coerceToString(true)).toBe('true')
    expect(coerceToString(false)).toBe('false')
  })

  it('handles number', () => {
    expect(coerceToString(42)).toBe('42')
    expect(coerceToString(0)).toBe('0')
  })

  it('handles null and undefined as empty string', () => {
    expect(coerceToString(null)).toBe('')
    expect(coerceToString(undefined)).toBe('')
  })

  it('does not produce [object Object] for plain objects', () => {
    expect(coerceToString({ vendor: "O'Brien LLC" })).not.toContain('[object Object]')
  })
})

describe('coerceToString — object serialization (BUG-001)', () => {
  const ctx: ExpressionContext = {
    env: {},
    trigger: { type: 'manual' },
    steps: {
      parse: {
        outputs: {
          payload: { amount: 100, currency: 'USD' },
          items: [1, 2, 3],
          nested: { a: { b: 'deep' } },
        },
      },
    },
    inputs: {
      invoice_payload: { vendor: 'Acme', total: 250 },
      tags: ['alpha', 'beta'],
    },
  }

  // NOTE: interpolateString is used for with: fields, NOT for run: blocks.
  // run: blocks go through buildShellSafeCommand — see 'buildShellSafeCommand — JSON object inputs' suite.
  it('interpolateString: object input serializes to JSON, not [object Object]', () => {
    const result = interpolateString("--argjson payload '${{ inputs.invoice_payload }}'", ctx)
    expect(result).toBe("--argjson payload '{\"vendor\":\"Acme\",\"total\":250}'")
    expect(result).not.toContain('[object Object]')
  })

  it('interpolateString: array input serializes to JSON array', () => {
    const result = interpolateString('tags=${{ inputs.tags }}', ctx)
    expect(result).toBe('tags=["alpha","beta"]')
  })

  it('interpolateString: step output object serializes to JSON', () => {
    const result = interpolateString('result=${{ steps.parse.outputs.payload }}', ctx)
    expect(result).toBe('result={"amount":100,"currency":"USD"}')
  })

  it('interpolateString: nested object serializes to JSON', () => {
    const result = interpolateString('x=${{ steps.parse.outputs.nested }}', ctx)
    expect(result).toBe('x={"a":{"b":"deep"}}')
  })

  it('evaluateExpression: object == string comparison does not silently misfire', () => {
    // object coerced via JSON.stringify won't equal a plain string accidentally
    const result = evaluateExpression('steps.parse.outputs.payload == "ok"', ctx)
    expect(result).toBe(false)
  })

  it('evaluateExpression: object != string is true (no [object Object] confusion)', () => {
    const result = evaluateExpression('steps.parse.outputs.payload != "[object Object]"', ctx)
    expect(result).toBe(true)
  })

  it('resolveExpression: single-expr object still returns raw object (type-preserving path)', () => {
    const result = resolveExpression('${{ steps.parse.outputs.payload }}', ctx)
    expect(result).toEqual({ amount: 100, currency: 'USD' })
  })
})

describe('env block coercion (BUG-001 — worker.ts fix)', () => {
  // Mirrors the fix in worker.ts: after interpolateObject, apply coerceToString to each value
  // so that object/array inputs become valid JSON strings, not "[object Object]".
  const ctx: ExpressionContext = {
    env: {},
    trigger: { type: 'manual' },
    steps: {},
    inputs: {
      invoice_payload: { vendor: 'ACME Corp', amount: 15000, currency: 'USD' },
      tags: ['urgent', 'finance'],
    },
  }

  it('coercing interpolateObject result produces string env values for object inputs', () => {
    const raw = interpolateObject(
      { KB_INVOICE_PAYLOAD: '${{ inputs.invoice_payload }}' },
      ctx,
    )
    const envVars = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, coerceToString(v)])
    )
    expect(envVars['KB_INVOICE_PAYLOAD']).toBe('{"vendor":"ACME Corp","amount":15000,"currency":"USD"}')
    expect(envVars['KB_INVOICE_PAYLOAD']).not.toContain('[object Object]')
  })

  it('coercing interpolateObject result produces string env values for array inputs', () => {
    const raw = interpolateObject(
      { KB_TAGS: '${{ inputs.tags }}' },
      ctx,
    )
    const envVars = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, coerceToString(v)])
    )
    expect(envVars['KB_TAGS']).toBe('["urgent","finance"]')
  })

  it('string env values pass through unchanged after coercion', () => {
    const raw = interpolateObject(
      { KB_ENV: 'production', KB_VERSION: '1.2.3' },
      ctx,
    )
    const envVars = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, coerceToString(v)])
    )
    expect(envVars['KB_ENV']).toBe('production')
    expect(envVars['KB_VERSION']).toBe('1.2.3')
  })

  it('with.env object inputs coerced to strings (secondary path — worker.ts:382)', () => {
    // Mirrors the with.env spread fix: builtin:shell steps using explicit
    // `with: { env: { KEY: '${{ inputs.obj }}' } }` must also coerce values.
    const raw = interpolateObject(
      { env: { KB_PAYLOAD: '${{ inputs.invoice_payload }}' } },
      ctx,
    )
    const withEnv = raw['env'] as Record<string, unknown>
    const coerced = Object.fromEntries(
      Object.entries(withEnv).map(([k, v]) => [k, coerceToString(v)])
    )
    expect(coerced['KB_PAYLOAD']).toBe('{"vendor":"ACME Corp","amount":15000,"currency":"USD"}')
    expect(coerced['KB_PAYLOAD']).not.toContain('[object Object]')
  })
})

// ─── buildShellSafeCommand ───────────────────────────────────────────────────
// Regression tests for shell injection via ${{ }} in run: blocks.
//
// Root cause: issue titles (and other user-supplied strings) can contain shell
// metacharacters — backticks, $(), quotes. When ${{ steps.issue.outputs.title }}
// is substituted raw into a shell script, those metacharacters are evaluated.
// buildShellSafeCommand injects values as _WF_* env vars instead, so the shell
// script reads them via ${_WF_...} references where backtick expansion does NOT
// occur during variable expansion.

describe('buildShellSafeCommand', () => {
  const ctx: ExpressionContext = {
    env: {},
    trigger: { type: 'manual' },
    steps: {
      issue: {
        outputs: {
          title: 'Add `kb workflow runs cancel` command',
          body: 'Fix the $(broken) thing',
          number: '174',
        },
      },
      branch: {
        outputs: { branchName: 'issue-174-auto' },
      },
    },
    inputs: {
      issueNumber: 174,
      owner: 'kb-labs-team',
      repo: 'kb-labs',
    },
  }

  it('replaces ${{ expr }} with ${_WF_varname} in command', () => {
    const raw = 'echo "${{ steps.issue.outputs.title }}"'
    const { command } = buildShellSafeCommand(raw, ctx)
    expect(command).toBe('echo "${_WF_steps_issue_outputs_title}"')
    expect(command).not.toContain('${{')
  })

  it('injects resolved value into shellEnvVars', () => {
    const raw = 'echo "${{ steps.issue.outputs.title }}"'
    const { shellEnvVars } = buildShellSafeCommand(raw, ctx)
    expect(shellEnvVars['_WF_steps_issue_outputs_title']).toBe(
      'Add `kb workflow runs cancel` command',
    )
  })

  it('shellEnvVar value contains raw backticks — NOT executed by the outer shell', () => {
    // This is the key invariant: the env var value must be the literal string.
    // When the shell evaluates `echo "${_WF_...}"`, variable expansion does
    // not re-evaluate backticks inside the value — they are literal characters.
    const raw = 'echo "${{ steps.issue.outputs.title }}"'
    const { shellEnvVars } = buildShellSafeCommand(raw, ctx)
    expect(shellEnvVars['_WF_steps_issue_outputs_title']).toContain('`kb workflow runs cancel`')
  })

  it('handles $() in values (dollar-paren injection)', () => {
    const raw = 'echo "${{ steps.issue.outputs.body }}"'
    const { command, shellEnvVars } = buildShellSafeCommand(raw, ctx)
    expect(command).toBe('echo "${_WF_steps_issue_outputs_body}"')
    expect(shellEnvVars['_WF_steps_issue_outputs_body']).toBe('Fix the $(broken) thing')
  })

  it('handles multiple expressions in one command', () => {
    const raw = 'gh pr create --title "feat: ${{ steps.issue.outputs.title }}" --repo "${{ inputs.owner }}/${{ inputs.repo }}"'
    const { command, shellEnvVars } = buildShellSafeCommand(raw, ctx)
    expect(command).toBe(
      'gh pr create --title "feat: ${_WF_steps_issue_outputs_title}" --repo "${_WF_inputs_owner}/${_WF_inputs_repo}"',
    )
    expect(shellEnvVars['_WF_steps_issue_outputs_title']).toBe('Add `kb workflow runs cancel` command')
    expect(shellEnvVars['_WF_inputs_owner']).toBe('kb-labs-team')
    expect(shellEnvVars['_WF_inputs_repo']).toBe('kb-labs')
  })

  it('deduplicates repeated expressions — same var name, same value', () => {
    const raw = 'echo "${{ inputs.issueNumber }}" && echo "${{ inputs.issueNumber }}"'
    const { command, shellEnvVars } = buildShellSafeCommand(raw, ctx)
    expect(command).toBe(
      'echo "${_WF_inputs_issueNumber}" && echo "${_WF_inputs_issueNumber}"',
    )
    // Only one env var entry for the repeated expression
    expect(Object.keys(shellEnvVars).filter(k => k.includes('issueNumber'))).toHaveLength(1)
  })

  it('produces a safe variable name from dotted expression', () => {
    const raw = '${{ steps.branch.outputs.branchName }}'
    const { command, shellEnvVars } = buildShellSafeCommand(raw, ctx)
    expect(command).toBe('${_WF_steps_branch_outputs_branchName}')
    expect(shellEnvVars['_WF_steps_branch_outputs_branchName']).toBe('issue-174-auto')
  })

  it('handles numeric inputs — coerces to string in env var', () => {
    const raw = 'echo "${{ inputs.issueNumber }}"'
    const { shellEnvVars } = buildShellSafeCommand(raw, ctx)
    expect(typeof shellEnvVars['_WF_inputs_issueNumber']).toBe('string')
    expect(shellEnvVars['_WF_inputs_issueNumber']).toBe('174')
  })

  it('leaves the command unchanged when there are no ${{ }} expressions', () => {
    const raw = 'echo "hello world" && git status'
    const { command, shellEnvVars } = buildShellSafeCommand(raw, ctx)
    expect(command).toBe(raw)
    expect(shellEnvVars).toEqual({})
  })

  it('resolves missing step output to empty string — does not throw', () => {
    const raw = 'echo "${{ steps.nonexistent.outputs.value }}"'
    const { command, shellEnvVars } = buildShellSafeCommand(raw, ctx)
    expect(command).toBe('echo "${_WF_steps_nonexistent_outputs_value}"')
    expect(shellEnvVars['_WF_steps_nonexistent_outputs_value']).toBe('')
  })
})

describe('buildShellSafeCommand — JSON object inputs (BUG-001)', () => {
  const ctx: ExpressionContext = {
    env: {},
    trigger: { type: 'manual' },
    steps: {},
    inputs: {
      invoice_payload: { vendor: 'ACME Corp', amount: 15000, currency: 'USD' },
    },
  }

  it("single-quoted ${{ expr }} becomes double-quoted \"${_WF_var}\" — shell expansion works", () => {
    // ${{ }} written as string concat to avoid JS template literal interpretation
    const expr = '${{' + ' inputs.invoice_payload ' + '}}'
    const raw = "jq --argjson payload '" + expr + "' '{\"x\":1}'"
    const { command } = buildShellSafeCommand(raw, ctx)
    // Single-quote wrapper must be replaced with double-quote so ${} expands in bash
    expect(command).toBe('jq --argjson payload "${_WF_inputs_invoice_payload}" \'{"x":1}\'')
    expect(command).not.toContain("'${_WF_")
  })

  it('shellEnvVar for object input contains valid JSON string', () => {
    const expr = '${{' + ' inputs.invoice_payload ' + '}}'
    const raw = "jq --argjson payload '" + expr + "' -n '$payload'"
    const { shellEnvVars } = buildShellSafeCommand(raw, ctx)
    const value = shellEnvVars['_WF_inputs_invoice_payload']
    expect(() => JSON.parse(value!)).not.toThrow()
    expect(JSON.parse(value!)).toEqual({ vendor: 'ACME Corp', amount: 15000, currency: 'USD' })
  })

  it('double-quoted ${{ expr }} remains double-quoted — unaffected', () => {
    const expr = '${{' + ' inputs.invoice_payload ' + '}}'
    const raw = 'jq --argjson payload "' + expr + '" -n \'$payload\''
    const { command } = buildShellSafeCommand(raw, ctx)
    expect(command).toBe('jq --argjson payload "${_WF_inputs_invoice_payload}" -n \'$payload\'')
  })
})
