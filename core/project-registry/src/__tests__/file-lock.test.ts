import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withFileLock } from '../file-lock.js'

let root: string

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('withFileLock live owner preservation', () => {
  it('does not expire an old lock while its owner process is alive', async () => {
    root = mkdtempSync(join(tmpdir(), 'kb-file-lock-'))
    const lockPath = join(root, 'import.lock')
    const payload = JSON.stringify({
      pid: process.pid,
      token: 'still-running',
      createdAt: Date.now() - 60_000,
    })
    writeFileSync(lockPath, payload)

    await expect(
      withFileLock(lockPath, async () => undefined, {
        timeoutMs: 30,
        retryMs: 1,
        staleMs: 1,
        preserveLiveOwner: true,
      }),
    ).rejects.toMatchObject({ code: 'KB_PROJECT_REGISTRY_LOCKED' })
    expect(readFileSync(lockPath, 'utf8')).toBe(payload)
  })
})
