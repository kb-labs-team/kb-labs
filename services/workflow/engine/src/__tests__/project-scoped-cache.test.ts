import { describe, expect, it } from 'vitest'
import { ErrorEnvelopeError } from '@kb-labs/core-platform/error-envelope'
import { InMemoryCache } from '@kb-labs/core-platform/inmemory'
import { ProjectScopedCache } from '../project-scoped-cache'

describe('ProjectScopedCache', () => {
  it('isolates queue, lock, and clear operations by registered project id', async () => {
    const backing = new InMemoryCache()
    const projectA = new ProjectScopedCache(backing, 'prj_0000000000000001')
    const projectB = new ProjectScopedCache(backing, 'prj_0000000000000002')

    await projectA.zadd('kb:jobqueue:normal', 10, 'project-a-job')
    await projectA.setIfNotExists('kb:lock:run:run-a', 'project-a-lock')

    await expect(projectA.zrangebyscore('kb:jobqueue:normal', 0, 20)).resolves.toEqual(['project-a-job'])
    await expect(projectB.zrangebyscore('kb:jobqueue:normal', 0, 20)).resolves.toEqual([])
    await expect(projectB.get('kb:lock:run:run-a')).resolves.toBeNull()

    await projectB.clear('kb:*')
    await expect(projectA.zrangebyscore('kb:jobqueue:normal', 0, 20)).resolves.toEqual(['project-a-job'])
  })

  it('refuses an empty project identity with a catalogued error', () => {
    expect(() => new ProjectScopedCache(new InMemoryCache(), '')).toThrowError(ErrorEnvelopeError)
    try {
      new ProjectScopedCache(new InMemoryCache(), '')
    } catch (error) {
      expect(error).toMatchObject({ envelope: { code: 'KB_RUNTIME_WORKFLOW_PROJECT_ID_REQUIRED' } })
    }
  })
})
