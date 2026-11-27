import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

test('installed E2E suites can use project and host routes through Gateway', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'project-routes-'))
  const previous = Object.fromEntries(['GATEWAY_URL', 'REST_URL', 'WORKFLOW_URL', 'MCP_URL', 'STATE_URL', 'MARKETPLACE_URL'].map((key) => [key, process.env[key]]))
  try {
    const source = await readFile(new URL('../src/urls.ts', import.meta.url), 'utf8')
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
    await writeFile(join(dir, 'package.json'), '{"type":"module"}')
    await writeFile(join(dir, 'urls.js'), compiled)

    Object.assign(process.env, {
      GATEWAY_URL: 'http://localhost:4000',
      REST_URL: 'http://localhost:4000/api/v1/projects/prj_fixture/rest',
      WORKFLOW_URL: 'http://localhost:4000/api/v1/projects/prj_fixture/workflow',
      MCP_URL: 'http://localhost:4000/api/v1/projects/prj_fixture/mcp',
      STATE_URL: 'http://localhost:4000/api/v1/state',
      MARKETPLACE_URL: 'http://localhost:4000',
    })

    const urls = await import(`${pathToFileURL(join(dir, 'urls.js')).href}?installed-routes`)
    assert.equal(urls.REST + urls.REST_API_PREFIX + '/plugins/registry', 'http://localhost:4000/api/v1/projects/prj_fixture/rest/plugins/registry')
    assert.equal(urls.WORKFLOW + urls.WORKFLOW_API_PREFIX + '/workflows', 'http://localhost:4000/api/v1/projects/prj_fixture/workflow/workflows')
    assert.equal(urls.MCP + '/api/v1/mcp', 'http://localhost:4000/api/v1/projects/prj_fixture/mcp/api/v1/mcp')
    assert.equal(urls.STATE + '/state/key', 'http://localhost:4000/api/v1/state/state/key')
    assert.equal(urls.MARKETPLACE + '/api/v1/marketplace/packages', 'http://localhost:4000/api/v1/marketplace/packages')

    delete process.env.REST_URL
    delete process.env.WORKFLOW_URL
    const direct = await import(`${pathToFileURL(join(dir, 'urls.js')).href}?direct-routes`)
    assert.equal(direct.REST_API_PREFIX, '/api/v1')
    assert.equal(direct.WORKFLOW_API_PREFIX, '/api/v1')
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
})
