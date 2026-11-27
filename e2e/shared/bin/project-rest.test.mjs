import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

test('project REST client authenticates and uses the registered project with one API prefix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'project-rest-'))
  try {
    const source = await readFile(new URL('../src/project-rest.ts', import.meta.url), 'utf8')
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
    await writeFile(join(dir, 'package.json'), '{"type":"module"}')
    await writeFile(join(dir, 'auth.js'), 'export async function loginAdmin(request) { await request.login() }')
    await writeFile(join(dir, 'urls.js'), 'export const GATEWAY = "http://gateway.test"')
    await writeFile(join(dir, 'project-rest.js'), compiled)
    const { projectRest } = await import(pathToFileURL(join(dir, 'project-rest.js')).href)
    const calls = []
    const request = {
      async login() { calls.push('login') },
      async get(url) {
        calls.push(url)
        return { ok: () => true, json: async () => ({ ok: true, data: [{ id: 'prj_a', path: '/workspace/kb-e2e' }] }) }
      },
    }
    const client = await projectRest(request)
    await client.get('/platform/config')
    await client.get('/plugins/registry')
    assert.deepEqual(calls, ['login', 'http://gateway.test/api/v1/projects', 'http://gateway.test/api/v1/projects/prj_a/rest/platform/config', 'http://gateway.test/api/v1/projects/prj_a/rest/plugins/registry'])
    assert.throws(() => client.get('/api/v1/platform/config'), /service-relative/)
    await assert.rejects(() => projectRest(request, '/missing'), /exactly one registered project/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
