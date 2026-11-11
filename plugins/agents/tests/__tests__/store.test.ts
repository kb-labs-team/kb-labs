import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKernelState } from '@kb-labs/agents/kernel';
import { SessionArtifactStore } from '../../src/store/index';

describe('SessionArtifactStore', () => {
  it('creates canonical artifacts and persists kernel snapshots', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-store-'));
    const store = new SessionArtifactStore(cwd);
    const state = createKernelState({
      sessionId: 'session-1',
      workingDir: cwd,
      mode: 'assistant',
      task: 'improve continuity',
    });

    await store.saveKernelState('session-1', state);
    await store.appendTurn('session-1', {
      id: 'turn-1',
      sessionId: 'session-1',
      role: 'user',
      content: 'hello',
      timestamp: new Date().toISOString(),
    });

    const loaded = await store.loadKernelState('session-1');
    const turns = await readFile(store.getArtifactPath('session-1', 'turns.jsonl'), 'utf-8');

    expect(loaded?.sessionId).toBe('session-1');
    expect(turns).toContain('"role":"user"');
  });
});
