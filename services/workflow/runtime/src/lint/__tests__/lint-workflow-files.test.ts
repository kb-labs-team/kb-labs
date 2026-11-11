import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { lintWorkflowFiles } from '../lint-workflow-files.js'

const createdDirectories: string[] = []

async function workflowDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kb-workflow-lint-'))
  createdDirectories.push(directory)
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(directory, name), content)))
  return directory
}

const workflow = (name: string, uses?: string) => `name: ${name}
version: 1.0.0
on:
  manual: true
jobs:
  main:
    runsOn: local
    steps:
      - name: step
        ${uses ? `uses: ${uses}` : 'run: echo ok'}
`

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('lintWorkflowFiles invocation graph', () => {
  it('reports project-relative file paths for default workflow-directory linting', async () => {
    const cwd = await workflowDirectory({});
    const workflows = join(cwd, '.kb', 'workflows');
    await mkdir(workflows, { recursive: true });
    await writeFile(join(workflows, 'hello.yml'), workflow('hello'));

    const [result] = await lintWorkflowFiles({ cwd });

    expect(result?.relativePath).toBe('.kb/workflows/hello.yml');
  });

  it('rejects a missing workspace child workflow', async () => {
    const path = await workflowDirectory({
      'parent.yaml': workflow('parent', 'workflow:workspace:missing'),
    })

    const [result] = await lintWorkflowFiles({ path })

    expect(result?.ok).toBe(false)
    expect(result?.errors).toContain('jobs: referenced workspace workflow "missing" was not found')
  })

  it('rejects an indirect invocation cycle', async () => {
    const path = await workflowDirectory({
      'a.yaml': workflow('a', 'workflow:workspace:b'),
      'b.yaml': workflow('b', 'workflow:workspace:a'),
    })

    const results = await lintWorkflowFiles({ path })

    expect(results.some((result) => result.errors.some((error) => error.includes('workflow invocation cycle: a -> b -> a')))).toBe(true)
  })
})
