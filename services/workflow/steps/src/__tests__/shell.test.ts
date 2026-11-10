import { WORKFLOW_ACTIVITY_META_KEY } from '@kb-labs/workflow-contracts'
/**
 * Unit tests for the shell built-in output extraction.
 *
 * Tests cover mergeJsonOutputs and parseOutputMarkerLine — the two
 * functions responsible for extracting structured outputs from shell stdout.
 */
import { describe, it, expect, expectTypeOf, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestContext, type MockLoggerInstance } from '@kb-labs/sdk/testing'
import type { ShellInput, ShellOutput } from '../shell.js'
import { mergeJsonOutputs, parseOutputMarkerLine, tail, LineBatcher } from '../shell.js'
import shellModule from '../shell.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeOutput(stdout: string, exitCode = 0): ShellOutput {
  return {
    stdout,
    stderr: '',
    exitCode,
    ok: exitCode === 0,
  }
}

/**
 * A real PluginContextV3 built by the SDK's test factory (mockLogger +
 * createMockPluginAPI under the hood), not a hand-rolled shape — so it stays
 * correct as the contract evolves instead of drifting out of sync with it.
 */
function makeShellTestContext() {
  // shellHandler only touches ctx.platform.logger and ctx.api.events — it
  // never reads the global adapter singleton, so skip syncing it (avoids
  // noisy "Adapters initialised" logging per test).
  const { ctx, cleanup } = createTestContext({ host: 'workflow', syncSingleton: false })
  return { ctx, cleanup, logger: ctx.platform.logger as MockLoggerInstance }
}

// ---------------------------------------------------------------------------
// Tests: parseOutputMarkerLine
// ---------------------------------------------------------------------------
describe('parseOutputMarkerLine', () => {
  it('returns null for a line with no marker', () => {
    expect(parseOutputMarkerLine('just a log line')).toBeNull()
    expect(parseOutputMarkerLine('')).toBeNull()
    expect(parseOutputMarkerLine('{ "foo": 1 }')).toBeNull()
  })

  it('parses a plain ::kb-output:: marker', () => {
    expect(parseOutputMarkerLine('::kb-output::{"passed":true,"score":95}')).toEqual({ passed: true, score: 95 })
  })

  it('throws a descriptive error for malformed JSON in plain marker (F6)', () => {
    // Silent drop was the bug — must now throw so callers can warn
    expect(() => parseOutputMarkerLine('::kb-output::not json')).toThrow(/malformed/i)
    expect(() => parseOutputMarkerLine('::kb-output::{"key": }')).toThrow()
  })

  it('throws a descriptive error when plain marker JSON is an array (not object)', () => {
    expect(() => parseOutputMarkerLine('::kb-output::[1,2,3]')).toThrow(/array/i)
  })

  it('parses ::kb-output:base64:: with valid base64-encoded JSON (F7)', () => {
    const payload = Buffer.from(JSON.stringify({ plan: 'line 1\nline 2\n"quotes"' })).toString('base64')
    const result = parseOutputMarkerLine(`::kb-output:base64::${payload}`)
    expect(result).toEqual({ plan: 'line 1\nline 2\n"quotes"' })
  })

  it('handles multi-line text safely via base64 — the F7 fix', () => {
    // This is the scenario that was broken: embedding raw multi-line text in plain marker
    // breaks JSON.parse.  Base64 variant handles it correctly.
    const multiline = 'line 1\nline 2\n"quotes" and \\backslash'
    const payload = Buffer.from(JSON.stringify({ content: multiline })).toString('base64')
    const result = parseOutputMarkerLine(`::kb-output:base64::${payload}`)
    expect(result).toEqual({ content: multiline })
  })

  it('throws on invalid base64 in base64 marker', () => {
    expect(() => parseOutputMarkerLine('::kb-output:base64::!!!not-base64!!!')).toThrow()
  })

  it('throws when base64 decodes to non-object JSON', () => {
    const payload = Buffer.from(JSON.stringify([1, 2, 3])).toString('base64')
    expect(() => parseOutputMarkerLine(`::kb-output:base64::${payload}`)).toThrow(/array/i)
  })

  it('base64 marker takes priority when both markers appear on the same line', () => {
    // ::kb-output:base64:: contains ::kb-output:: as a substring — base64 wins
    const payload = Buffer.from(JSON.stringify({ source: 'base64' })).toString('base64')
    const result = parseOutputMarkerLine(`::kb-output:base64::${payload}`)
    expect(result?.source).toBe('base64')
  })
})

// ---------------------------------------------------------------------------
// Tests: mergeJsonOutputs — ::kb-output:: marker (plain JSON)
// ---------------------------------------------------------------------------
describe('mergeJsonOutputs — ::kb-output:: marker', () => {
  it('extracts outputs from ::kb-output:: marker line', () => {
    const output = makeOutput('some logs\n::kb-output::{"passed":true,"score":95}\nmore logs')
    const result = mergeJsonOutputs(output)

    expect(result.passed).toBe(true)
    expect(result.score).toBe(95)
  })

  it('works with marker as the only line', () => {
    const output = makeOutput('::kb-output::{"status":"ok"}')
    const result = mergeJsonOutputs(output)

    expect(result.status).toBe('ok')
  })

  it('extracts from marker even with pnpm noise before it', () => {
    const stdout = [
      'WARN  Issue while reading "/Users/x/.npmrc".',
      '> @kb-labs/workspace@0.0.1 kb /path',
      '> node ./platform/kb-labs-cli/packages/cli-bin/dist/bin.js "policy:check"',
      'Running checks...',
      '::kb-output::{"passed":true,"violations":0}',
    ].join('\n')
    const result = mergeJsonOutputs(makeOutput(stdout))

    expect(result.passed).toBe(true)
    expect(result.violations).toBe(0)
  })

  it('merges multiple marker lines', () => {
    const stdout = [
      '::kb-output::{"a":1}',
      'log line',
      '::kb-output::{"b":2}',
    ].join('\n')
    const result = mergeJsonOutputs(makeOutput(stdout))

    expect(result.a).toBe(1)
    expect(result.b).toBe(2)
  })

  it('later marker overrides earlier for same key', () => {
    const stdout = [
      '::kb-output::{"passed":false}',
      '::kb-output::{"passed":true}',
    ].join('\n')
    const result = mergeJsonOutputs(makeOutput(stdout))

    expect(result.passed).toBe(true)
  })

  it('calls warn callback and skips key on malformed marker JSON (F6 fix)', () => {
    const warn = vi.fn()
    const stdout = [
      '::kb-output::not json',
      '::kb-output::{"valid":true}',
    ].join('\n')
    const result = mergeJsonOutputs(makeOutput(stdout), warn)

    // Valid marker still processed
    expect(result.valid).toBe(true)
    // Warn called exactly once for the malformed line
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/malformed/i)
  })

  it('without warn callback, malformed marker is silently skipped (no throw)', () => {
    const stdout = '::kb-output::not json'
    // Must not throw even without a warn callback
    expect(() => mergeJsonOutputs(makeOutput(stdout))).not.toThrow()
  })

  it('ignores marker with array JSON and calls warn', () => {
    const warn = vi.fn()
    const stdout = '::kb-output::[1,2,3]'
    const result = mergeJsonOutputs(makeOutput(stdout), warn)

    expect(result[0]).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('preserves base ShellOutput fields', () => {
    const output = makeOutput('logs\n::kb-output::{"custom":"value"}')
    const result = mergeJsonOutputs(output)

    expect(result.stdout).toBe('logs\n::kb-output::{"custom":"value"}')
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.custom).toBe('value')
  })

  it('marker takes priority over fallback JSON parse', () => {
    // stdout ends with valid JSON but also has marker — marker wins
    const stdout = '::kb-output::{"source":"marker"}\n{"source":"fallback"}'
    const result = mergeJsonOutputs(makeOutput(stdout))

    expect(result.source).toBe('marker')
  })
})

// ---------------------------------------------------------------------------
// Tests: mergeJsonOutputs — ::kb-output:base64:: (JSON-safe, F7 fix)
// ---------------------------------------------------------------------------
describe('mergeJsonOutputs — ::kb-output:base64:: marker', () => {
  it('extracts outputs from a base64-encoded marker', () => {
    const payload = Buffer.from(JSON.stringify({ plan: 'my plan', passed: true })).toString('base64')
    const result = mergeJsonOutputs(makeOutput(`::kb-output:base64::${payload}`))

    expect(result.plan).toBe('my plan')
    expect(result.passed).toBe(true)
  })

  it('handles multi-line text values safely (F7 regression guard)', () => {
    const multiline = '# Plan\n- Step 1\n- Step 2\n"quoted" value'
    const payload = Buffer.from(JSON.stringify({ plan: multiline })).toString('base64')
    const result = mergeJsonOutputs(makeOutput(`::kb-output:base64::${payload}`))

    expect(result.plan).toBe(multiline)
  })

  it('handles special chars and unicode safely', () => {
    const special = 'hello\t\r\n"world"\\ ← → ✓'
    const payload = Buffer.from(JSON.stringify({ v: special })).toString('base64')
    const result = mergeJsonOutputs(makeOutput(`::kb-output:base64::${payload}`))

    expect(result.v).toBe(special)
  })

  it('merges multiple base64 markers', () => {
    const p1 = Buffer.from(JSON.stringify({ a: 1 })).toString('base64')
    const p2 = Buffer.from(JSON.stringify({ b: 2 })).toString('base64')
    const stdout = [`::kb-output:base64::${p1}`, 'log', `::kb-output:base64::${p2}`].join('\n')
    const result = mergeJsonOutputs(makeOutput(stdout))

    expect(result.a).toBe(1)
    expect(result.b).toBe(2)
  })

  it('calls warn on invalid base64 and continues processing other lines', () => {
    const warn = vi.fn()
    const validPayload = Buffer.from(JSON.stringify({ ok: true })).toString('base64')
    const stdout = [
      '::kb-output:base64::!!!invalid!!!',
      `::kb-output:base64::${validPayload}`,
    ].join('\n')
    const result = mergeJsonOutputs(makeOutput(stdout), warn)

    expect(result.ok).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('base64 and plain markers can coexist in the same stdout', () => {
    const b64Payload = Buffer.from(JSON.stringify({ fromBase64: true })).toString('base64')
    const stdout = [
      '::kb-output::{"fromPlain":true}',
      `::kb-output:base64::${b64Payload}`,
    ].join('\n')
    const result = mergeJsonOutputs(makeOutput(stdout))

    expect(result.fromPlain).toBe(true)
    expect(result.fromBase64).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests: Fallback (entire stdout as JSON — backward compat)
// ---------------------------------------------------------------------------
describe('mergeJsonOutputs — fallback (backward compat)', () => {
  it('merges a flat JSON object from stdout into the output record', () => {
    const output = makeOutput('{"passed": true, "score": 95}')
    const result = mergeJsonOutputs(output)

    expect(result.passed).toBe(true)
    expect(result.score).toBe(95)
  })

  it('preserves the base ShellOutput fields even when merging', () => {
    const output = makeOutput('{"custom": "value"}')
    const result = mergeJsonOutputs(output)

    expect(result.stdout).toBe('{"custom": "value"}')
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.custom).toBe('value')
  })

  it('ignores invalid JSON and returns the base output unchanged', () => {
    const output = makeOutput('not json at all')
    const result = mergeJsonOutputs(output)

    expect(result.stdout).toBe('not json at all')
    expect(Object.keys(result)).toEqual(['stdout', 'stderr', 'exitCode', 'ok'])
  })

  it('ignores partial / malformed JSON and returns the base output unchanged', () => {
    const output = makeOutput('{"key": }')
    const result = mergeJsonOutputs(output)

    expect(result.stdout).toBe('{"key": }')
    expect(result.key).toBeUndefined()
  })

  it('does NOT merge JSON arrays — only plain objects are merged', () => {
    const output = makeOutput('[1, 2, 3]')
    const result = mergeJsonOutputs(output)

    expect(result[0]).toBeUndefined()
    expect(result.stdout).toBe('[1, 2, 3]')
  })

  it('does NOT merge primitive JSON values (string, number, boolean)', () => {
    expect(mergeJsonOutputs(makeOutput('"hello"')).stdout).toBe('"hello"')
    expect(Object.keys(mergeJsonOutputs(makeOutput('"hello"')))).toEqual([
      'stdout', 'stderr', 'exitCode', 'ok',
    ])
    expect(mergeJsonOutputs(makeOutput('42')).stdout).toBe('42')
    expect(mergeJsonOutputs(makeOutput('true')).stdout).toBe('true')
  })

  it('returns base output unchanged when stdout is empty', () => {
    const result = mergeJsonOutputs(makeOutput(''))
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0, ok: true })
  })

  it('returns base output unchanged when stdout is only whitespace', () => {
    const result = mergeJsonOutputs(makeOutput('   \n  '))
    expect(result.stdout).toBe('   \n  ')
    expect(Object.keys(result)).toEqual(['stdout', 'stderr', 'exitCode', 'ok'])
  })

  it('merges nested objects from JSON stdout', () => {
    const output = makeOutput('{"meta": {"version": "1.0", "stable": true}}')
    const result = mergeJsonOutputs(output)

    expect(result.meta).toEqual({ version: '1.0', stable: true })
  })

  it('handles stdout with leading/trailing whitespace around valid JSON', () => {
    const output = makeOutput('  {"trimmed": true}  ')
    const result = mergeJsonOutputs(output)

    expect(result.trimmed).toBe(true)
  })

  it('works correctly when command fails (exitCode != 0)', () => {
    const output = makeOutput('{"error": "something went wrong"}', 1)
    const result = mergeJsonOutputs(output)

    expect(result.error).toBe('something went wrong')
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Type shape tests
// ---------------------------------------------------------------------------
describe('ShellInput type shape', () => {
  it('accepts a minimal input with only command', () => {
    const input: ShellInput = { command: 'echo hello' }
    expectTypeOf(input.command).toBeString()
    expectTypeOf(input.env).toEqualTypeOf<Record<string, string> | undefined>()
    expectTypeOf(input.throwOnError).toEqualTypeOf<boolean | undefined>()
  })

  it('accepts a fully specified input', () => {
    const input: ShellInput = {
      command: 'npm test',
      env: { NODE_ENV: 'test' },
      throwOnError: true,
    }
    expect(input.command).toBe('npm test')
  })
})

describe('ShellOutput type shape', () => {
  it('has the expected fields', () => {
    const output: ShellOutput = {
      stdout: 'hello',
      stderr: '',
      exitCode: 0,
      ok: true,
    }
    expectTypeOf(output.stdout).toBeString()
    expectTypeOf(output.stderr).toBeString()
    expectTypeOf(output.exitCode).toBeNumber()
    expectTypeOf(output.ok).toBeBoolean()
  })
})

// ---------------------------------------------------------------------------
// Execution cancellation is owned by the workflow step boundary. The handler
// must stop its child process group when that boundary aborts the context.
// ---------------------------------------------------------------------------
describe('shellHandler — execution-boundary cancellation', () => {
  // case: S-243.5
  it('stops the child process group on boundary abort and flushes captured output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-shell-timeout-'))
    const pidFile = join(directory, 'child.pid')
    const { ctx, cleanup } = makeShellTestContext()
    const controller = new AbortController()
    Object.defineProperty(ctx, 'signal', { value: controller.signal })
    let childPid: number | undefined
    const execution = shellModule.execute(ctx, {
      command: `printf 'working...\\n'; sleep 30 & echo $! > '${pidFile}'; wait`,
      throwOnError: true,
    })
    const settled = execution.then(() => undefined, () => undefined)
    try {
      await vi.waitFor(async () => {
        childPid = Number(await readFile(pidFile, 'utf8'))
        expect(childPid).toBeGreaterThan(1)
      }, { timeout: 1000 })
      controller.abort()
      await expect(execution).rejects.toThrow('execution aborted')
      await vi.waitFor(() => {
        expect(() => process.kill(childPid!, 0)).toThrow()
      }, { timeout: 1000 })
      expect(ctx.platform.logger.info).toHaveBeenCalledWith('Shell output (stdout)', expect.objectContaining({ text: 'working...' }))
    } finally {
      controller.abort()
      if (childPid) { try { process.kill(childPid, 'SIGKILL') } catch { /* test cleanup: process may already be gone */ } }
      await settled
      cleanup()
      await rm(directory, { recursive: true, force: true })
    }
  }, 5000)

  it('keeps successful stderr diagnostics at warn level', async () => {
    const { ctx, cleanup } = makeShellTestContext()
    try {
      const result = await shellModule.execute(ctx, {
        command: `node -e "process.stderr.write('discovery diagnostic\\n')"`,
      })

      expect(result.workflowStepResult).toMatchObject({ exitCode: 0, ok: true, stderr: 'discovery diagnostic\n' })
      expect(ctx.api.events.emit).toHaveBeenCalledWith('log.line', {
        stream: 'stderr',
        line: 'discovery diagnostic',
        lineNo: 1,
        level: 'warn',
      })
    } finally {
      cleanup()
    }
  })

  // Regression: `kb workflow runs logs` showed only exitCode + a line count
  // for a failed step, never the actual command output — debugging meant
  // re-running the command by hand outside the workflow. `Shell command
  // failed`/`Shell command timed out` must carry the real output.
  it('includes the actual stderr in the failure log entry, not just its shape', async () => {
    const { ctx, cleanup } = makeShellTestContext()
    try {
      await shellModule.execute(ctx, {
        command: `node -e "process.stderr.write('boom: assertion failed\\n'); process.exit(1)"`,
      })

      expect(ctx.platform.logger.warn).toHaveBeenCalledWith(
        'Shell command failed',
        expect.objectContaining({ stderrTail: expect.stringContaining('boom: assertion failed') }),
      )
    } finally {
      cleanup()
    }
  })

})

describe('shellHandler environment isolation', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // case: S-028.4, S-028.5
  it('does not inherit an undeclared parent variable and keeps its value out of captured logs', async () => {
    const sentinel = 'w01-parent-secret-should-not-escape'
    vi.stubEnv('KB_W01_PARENT_SENTINEL', sentinel)
    const { ctx, cleanup, logger } = makeShellTestContext()
    try {
      const result = await shellModule.execute(ctx, {
        command: `node -e "process.stdout.write(process.env.KB_W01_PARENT_SENTINEL ? 'present' : 'absent')"`,
        env: { DECLARED_VALUE: 'declared' },
      })

      expect(result.workflowStepResult.stdout).toBe('absent')
      expect(JSON.stringify(logger.messages)).not.toContain(sentinel)
      expect(ctx.api.events.emit).toHaveBeenCalledWith('log.line', expect.objectContaining({ line: 'absent' }))
    } finally {
      cleanup()
    }
  })
})

describe('tail', () => {
  it('returns the text unchanged when under the limit', () => {
    expect(tail('short', 100)).toBe('short')
  })

  it('keeps the END of the text, not the start — the actionable error is usually last', () => {
    const text = 'first line\n'.repeat(100) + 'Error: this is the actual failure'
    const result = tail(text, 50)
    expect(result).toContain('Error: this is the actual failure')
    expect(result).not.toContain('first line\nfirst line\nfirst line') // start of the repeated block, not the tail-adjacent copies
  })

  it('marks truncated output so it is not mistaken for the full log', () => {
    const result = tail('x'.repeat(200), 50)
    expect(result).toMatch(/^…\(truncated, showing last 50 of 200 chars\)\n/)
    expect(result.endsWith('x'.repeat(50))).toBe(true)
  })

  it('surfaces a ::kb-output:: line even when a trailing wrapper banner would otherwise push it out of the tail', () => {
    // Mirrors a real `pnpm kb <cmd> --json` failure: the command's own
    // structured result comes first, then pnpm appends its generic banner —
    // which becomes the literal last bytes once padded past maxChars.
    const payload = JSON.stringify({ ok: false, failed: ['dist-exports'] })
    const text = `::kb-output::${payload}\n` + 'padding line\n'.repeat(500) + '[ELIFECYCLE] Command failed with exit code 1.\n'
    const result = tail(text, 200)
    expect(result).toContain(`::kb-output::${payload}`)
    expect(result).toContain('[ELIFECYCLE] Command failed with exit code 1.')
  })

  it('surfaces a ::kb-output:base64:: line the same way', () => {
    const payload = Buffer.from(JSON.stringify({ ok: false, failed: ['pack-install'] }), 'utf8').toString('base64')
    const text = `::kb-output:base64::${payload}\n` + 'padding line\n'.repeat(500) + '[ELIFECYCLE] Command failed with exit code 1.\n'
    const result = tail(text, 200)
    expect(result).toContain(`::kb-output:base64::${payload}`)
  })

  it('does not duplicate the marker line when it already falls inside the raw tail window', () => {
    const payload = JSON.stringify({ ok: false })
    const text = `::kb-output::${payload}\n[ELIFECYCLE] Command failed with exit code 1.\n`
    const result = tail(text, 10000)
    expect(result.split(`::kb-output::${payload}`).length - 1).toBe(1)
  })

  it('truncates an overlong marker line instead of blowing the whole budget on it', () => {
    const hugePayload = JSON.stringify({ ok: false, failed: Array.from({ length: 500 }, (_, i) => `pkg-${i}`) })
    const text = `::kb-output::${hugePayload}\n` + 'padding line\n'.repeat(500) + '[ELIFECYCLE] Command failed with exit code 1.\n'
    const result = tail(text, 200)
    expect(result).toContain('marker line truncated')
    expect(result).toContain('[ELIFECYCLE] Command failed with exit code 1.')
  })
})

// ---------------------------------------------------------------------------
// LineBatcher: batches per-line output for durable persistence without
// turning every line into its own logger write (the daemon's ring buffer is
// a fixed number of records shared across the whole daemon).
// ---------------------------------------------------------------------------
describe('LineBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not flush before maxLines or maxMs is reached', () => {
    const onFlush = vi.fn()
    const batcher = new LineBatcher('stdout', onFlush, 5, 500)

    batcher.add('line 1', 1)
    batcher.add('line 2', 2)

    expect(onFlush).not.toHaveBeenCalled()
  })

  it('flushes exactly once when maxLines lines arrive, not once per line', () => {
    const onFlush = vi.fn()
    const batcher = new LineBatcher('stdout', onFlush, 3, 500)

    batcher.add('a', 1)
    batcher.add('b', 2)
    batcher.add('c', 3)

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush).toHaveBeenCalledWith({
      stream: 'stdout',
      fromLine: 1,
      toLine: 3,
      text: 'a\nb\nc',
    })
  })

  it('flushes on the time window even if maxLines was never reached', () => {
    const onFlush = vi.fn()
    const batcher = new LineBatcher('stderr', onFlush, 50, 500)

    batcher.add('only line', 1)
    expect(onFlush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(500)

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush).toHaveBeenCalledWith({
      stream: 'stderr',
      fromLine: 1,
      toLine: 1,
      text: 'only line',
    })
  })

  it('starts a fresh batch (and timer) after a flush', () => {
    const onFlush = vi.fn()
    const batcher = new LineBatcher('stdout', onFlush, 2, 500)

    batcher.add('a', 1)
    batcher.add('b', 2) // flush #1: lines 1-2
    batcher.add('c', 3)
    vi.advanceTimersByTime(500) // flush #2: line 3, via timer

    expect(onFlush).toHaveBeenCalledTimes(2)
    expect(onFlush).toHaveBeenNthCalledWith(1, expect.objectContaining({ fromLine: 1, toLine: 2 }))
    expect(onFlush).toHaveBeenNthCalledWith(2, expect.objectContaining({ fromLine: 3, toLine: 3 }))
  })

  it('manual flush() is a no-op when nothing is buffered', () => {
    const onFlush = vi.fn()
    const batcher = new LineBatcher('stdout', onFlush, 50, 500)

    batcher.flush()

    expect(onFlush).not.toHaveBeenCalled()
  })

  it('manual flush() emits whatever is buffered and cancels the pending timer', () => {
    const onFlush = vi.fn()
    const batcher = new LineBatcher('stdout', onFlush, 50, 500)

    batcher.add('a', 1)
    batcher.flush()

    expect(onFlush).toHaveBeenCalledTimes(1)

    // The timer that would have fired for the flushed batch must not fire again.
    vi.advanceTimersByTime(1000)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// shellHandler: durable per-line persistence via ctx.platform.logger.
//
// Before this fix, per-line output only reached ctx.api.events.emit('log.line', ...),
// an ephemeral pub/sub event consumed solely by live WebSocket watchers. A step's
// full output was unrecoverable after the run finished unless someone was
// watching live. This wires per-line output into the same logger pipeline
// used by lifecycle events (which already flows to the ring buffer + durable
// persistence), batched so it doesn't flood the daemon's shared ring buffer.
// ---------------------------------------------------------------------------
describe('shellHandler — durable per-line log persistence (batched)', () => {
  it("persists a small step's stdout as one batched logger call, not one per line", async () => {
    const { ctx, cleanup, logger } = makeShellTestContext()
    try {
      await shellModule.execute(ctx, {
        command: `node -e "console.log('one'); console.log('two'); console.log('three')"`,
      })

      const batches = logger.messages.filter((m) => m.msg === 'Shell output (stdout)')
      expect(batches).toHaveLength(1)
      expect(batches[0]?.meta).toMatchObject({
        stream: 'stdout',
        fromLine: 1,
        toLine: 3,
        text: 'one\ntwo\nthree',
      })

      // The live-streaming path must still fire once per line, unchanged.
      const lineEmits = (ctx.api.events.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === 'log.line' && call[1]?.meta?.[WORKFLOW_ACTIVITY_META_KEY] !== true,
      )
      expect(lineEmits).toHaveLength(3)
    } finally {
      cleanup()
    }
  })

  it('splits more than one batch worth of lines (>50) into multiple logger calls', async () => {
    const { ctx, cleanup, logger } = makeShellTestContext()
    try {
      // 120 lines: two full batches of 50 plus a 20-line tail flushed at the end.
      await shellModule.execute(ctx, {
        command: `node -e "for (let i = 1; i <= 120; i++) { console.log('line ' + i) }"`,
      })

      const batches = logger.messages.filter((m) => m.msg === 'Shell output (stdout)')
      expect(batches.length).toBeGreaterThanOrEqual(2)

      const totalLinesLogged = batches.reduce((sum, m) => {
        const meta = m.meta as { fromLine: number; toLine: number }
        return sum + (meta.toLine - meta.fromLine + 1)
      }, 0)
      expect(totalLinesLogged).toBe(120)

      // Still exactly one live-stream emit per line.
      const lineEmits = (ctx.api.events.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === 'log.line' && call[1]?.meta?.[WORKFLOW_ACTIVITY_META_KEY] !== true,
      )
      expect(lineEmits).toHaveLength(120)
    } finally {
      cleanup()
    }
  })

  it('routes stderr batches through logger.warn, matching the per-line level', async () => {
    const { ctx, cleanup, logger } = makeShellTestContext()
    try {
      await shellModule.execute(ctx, {
        command: `node -e "console.error('oops')"`,
      })

      const batches = logger.messages.filter(
        (m) => m.level === 'warn' && m.msg === 'Shell output (stderr)',
      )
      expect(batches).toHaveLength(1)
      expect(batches[0]?.meta).toMatchObject({ stream: 'stderr', text: 'oops' })
    } finally {
      cleanup()
    }
  })
})
