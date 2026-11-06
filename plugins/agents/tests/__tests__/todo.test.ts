import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTodoCreateTool, createTodoGetTool, createTodoUpdateTool } from '../../src/tools/tools/planning/todo.js';
import type { ToolContext } from '../../src/tools/types.js';

function createCacheMock() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async <T>(key: string) => (store.get(key) as T) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(async () => {}),
    zadd: vi.fn(async () => {}),
    zrangebyscore: vi.fn(async () => []),
    zrem: vi.fn(async () => {}),
    setIfNotExists: vi.fn(async () => true),
  };
}

function ctx(cache?: ToolContext['cache']): ToolContext {
  return {
    workingDir: '/tmp/project',
    cache,
  };
}

describe('todo tools cache integration', () => {
  let cache: ReturnType<typeof createCacheMock>;

  beforeEach(() => {
    cache = createCacheMock();
  });

  it('should persist todo list to cache on create', async () => {
    const tool = createTodoCreateTool(ctx(cache as any));

    const result = await tool.executor({
      sessionId: 'session-1',
      items: [{ description: 'step 1' }],
    });

    expect(result.success).toBe(true);
    expect(cache.set).toHaveBeenCalledTimes(1);
    expect(cache.set.mock.calls[0]?.[0]).toBe('agent:todo:session-1');
  });

  it('should load from cache before update/get', async () => {
    const create = createTodoCreateTool(ctx(cache as any));
    await create.executor({
      sessionId: 'session-2',
      items: [{ description: 'step 1' }],
    });

    const update = createTodoUpdateTool(ctx(cache as any));
    const updateResult = await update.executor({
      sessionId: 'session-2',
      itemId: 'session-2-1',
      status: 'completed',
      notes: 'done',
    });

    const get = createTodoGetTool(ctx(cache as any));
    const getResult = await get.executor({ sessionId: 'session-2' });

    expect(updateResult.success).toBe(true);
    expect(getResult.success).toBe(true);
    expect(getResult.output).toContain('1/1 completed');
    expect(cache.get).toHaveBeenCalled();
  });
});

