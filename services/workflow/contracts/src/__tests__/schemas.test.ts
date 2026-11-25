import { describe, it, expect } from 'vitest'
import { ExecutionTargetSchema, RunMetadataSchema, StepSpecSchema, WorkflowSpecSchema, WorkflowTriggerSchema } from '../schemas'
import { WorkflowRunRequestSchema } from '../rest-api'

describe('WorkflowTriggerSchema', () => {
  it('accepts manual workflows and rejects unreachable ingress triggers', () => {
    expect(WorkflowTriggerSchema.safeParse({ manual: true }).success).toBe(true)
    expect(WorkflowTriggerSchema.safeParse({ push: true }).success).toBe(false)
    expect(WorkflowTriggerSchema.safeParse({ webhook: true }).success).toBe(false)
    expect(WorkflowTriggerSchema.safeParse({ webhook: { path: '/incoming' } }).success).toBe(false)
  })
})

describe('ExecutionTargetSchema', () => {
  // case: S-325.2
  it('preserves an explicit source ref for isolated workspace materialization', () => {
    expect(ExecutionTargetSchema.parse({ sourceRef: 'HEAD' })).toEqual({ sourceRef: 'HEAD' })
    expect(ExecutionTargetSchema.safeParse({ sourceRef: '' }).success).toBe(false)
  })

  // case: S-325.2
  it('accepts sourceRef on workflow run API targets', () => {
    expect(WorkflowRunRequestSchema.parse({ target: { sourceRef: 'HEAD' } })).toMatchObject({
      target: { sourceRef: 'HEAD' },
    })
  })

  // case: S-325.2
  it('accepts sourceRef at both workflow and job scope', () => {
    const parsed = WorkflowSpecSchema.parse({
      name: 'native-agent-qa-dogfood',
      version: '1.0.0',
      on: { manual: true },
      target: { sourceRef: 'workflow-ref' },
      jobs: {
        dogfood: {
          runsOn: 'local',
          target: { sourceRef: 'job-ref' },
          steps: [{ name: 'Run', uses: 'builtin:shell', with: { command: 'true' } }],
        },
      },
    })
    expect(parsed.target?.sourceRef).toBe('workflow-ref')
    expect(parsed.jobs.dogfood?.target?.sourceRef).toBe('job-ref')
  })
})

describe('RunMetadataSchema', () => {
  // case: S-325.5
  it('preserves the workspace source ref and resolved commit when run metadata is parsed', () => {
    const metadata = {
      executionWorkspace: {
        workspaceId: 'wt_parent',
        rootPath: '/tmp/worktree',
        sourceRef: 'HEAD',
        sourceRefCommit: 'a'.repeat(40),
      },
    }
    expect(RunMetadataSchema.parse(metadata)).toEqual(metadata)
  })
})

describe('StepSpecSchema', () => {
  describe('run: shorthand', () => {
    it('converts run: to builtin:shell', () => {
      const result = StepSpecSchema.safeParse({ name: 'My step', run: 'echo hello' })
      expect(result.success).toBe(true)
      expect(result.data).toMatchObject({
        name: 'My step',
        uses: 'builtin:shell',
        with: { command: 'echo hello' },
      })
    })

    it('merges existing with: fields when converting run:', () => {
      const result = StepSpecSchema.safeParse({
        name: 'My step',
        run: 'echo hello',
        with: { env: 'production' },
      })
      expect(result.success).toBe(true)
      expect(result.data).toMatchObject({
        uses: 'builtin:shell',
        with: { command: 'echo hello', env: 'production' },
      })
    })

    it('does not override existing uses: when run: is present', () => {
      // uses takes precedence over run
      const result = StepSpecSchema.safeParse({
        name: 'My step',
        uses: 'builtin:approval',
        run: 'echo hello',
      })
      expect(result.success).toBe(true)
      // uses: is already set, run: is ignored
      expect(result.data?.uses).toBe('builtin:approval')
    })

    it('passes through uses: builtin:shell as-is', () => {
      const result = StepSpecSchema.safeParse({
        name: 'My step',
        uses: 'builtin:shell',
        with: { command: 'pnpm build' },
      })
      expect(result.success).toBe(true)
      expect(result.data?.uses).toBe('builtin:shell')
    })
  })

  it('accepts the opt-in workspace patch builtin', () => {
    const result = StepSpecSchema.safeParse({ name: 'Save patch', uses: 'builtin:workspace-patch' })
    expect(result.success).toBe(true)
    expect(result.data?.uses).toBe('builtin:workspace-patch')
  })

  describe('uses: plugin: syntax', () => {
    it('accepts non-scoped plugin reference', () => {
      const result = StepSpecSchema.safeParse({
        name: 'Step',
        uses: 'plugin:quality/audit',
      })
      expect(result.success).toBe(true)
      expect(result.data?.uses).toBe('plugin:quality/audit')
    })

    it('accepts scoped plugin reference (@scope/name/handler)', () => {
      const result = StepSpecSchema.safeParse({
        name: 'Step',
        uses: 'plugin:@kb-labs/commit/status',
      })
      expect(result.success).toBe(true)
      expect(result.data?.uses).toBe('plugin:@kb-labs/commit/status')
    })

    it('accepts scoped plugin with nested handler path', () => {
      const result = StepSpecSchema.safeParse({
        name: 'Step',
        uses: 'plugin:@kb-labs/marketplace/cli/list',
      })
      expect(result.success).toBe(true)
      expect(result.data?.uses).toBe('plugin:@kb-labs/marketplace/cli/list')
    })
  })

  describe('uses: command: syntax', () => {
    // CLI command paths contain spaces (e.g. manifest path 'review run'); the
    // runtime resolver matches the post-prefix remainder verbatim against the
    // manifest path, so the schema must accept spaces in the command form.
    it('accepts a command reference with a space in the path', () => {
      const result = StepSpecSchema.safeParse({
        name: 'AI Code Review',
        uses: 'command:review run',
      })
      expect(result.success).toBe(true)
      expect(result.data?.uses).toBe('command:review run')
    })

    it('accepts a command reference with a deeper space-separated path', () => {
      const result = StepSpecSchema.safeParse({
        name: 'Trace stats',
        uses: 'command:agent trace stats show',
      })
      expect(result.success).toBe(true)
      expect(result.data?.uses).toBe('command:agent trace stats show')
    })
  })

  describe('builtins', () => {
    it('accepts builtin:approval', () => {
      const result = StepSpecSchema.safeParse({ name: 'Approve', uses: 'builtin:approval' })
      expect(result.success).toBe(true)
    })

    it('accepts builtin:gate', () => {
      const result = StepSpecSchema.safeParse({ name: 'Gate', uses: 'builtin:gate' })
      expect(result.success).toBe(true)
    })
  })

  describe('validation', () => {
    it('requires name', () => {
      const result = StepSpecSchema.safeParse({ uses: 'builtin:shell' })
      expect(result.success).toBe(false)
    })

    it('accepts step with neither uses nor run (noop)', () => {
      const result = StepSpecSchema.safeParse({ name: 'Noop step' })
      expect(result.success).toBe(true)
    })
  })
})

describe('WorkflowSpecSchema — run: in jobs', () => {
  it('parses workflow with run: steps', () => {
    const result = WorkflowSpecSchema.safeParse({
      name: 'test-workflow',
      version: '1.0.0',
      on: { manual: true },
      jobs: {
        build: {
          runsOn: 'local',
          steps: [
            { name: 'Install', run: 'pnpm install' },
            { name: 'Build', run: 'pnpm build' },
          ],
        },
      },
    })
    expect(result.success).toBe(true)
    const steps = result.data?.jobs.build?.steps
    expect(steps?.[0]).toMatchObject({ uses: 'builtin:shell', with: { command: 'pnpm install' } })
    expect(steps?.[1]).toMatchObject({ uses: 'builtin:shell', with: { command: 'pnpm build' } })
  })
})
