import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostAgentTransport } from './host-agent-transport.js';

describe('HostAgentTransport', () => {
  it('returns a catalogued host failure when the IPC socket is unavailable', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kb-host-agent-socket-'));
    const transport = new HostAgentTransport(path.join(directory, 'missing.sock'));
    try {
      await expect(transport.execute({
        projectId: 'project-1', pluginId: '@example/plugin', commandPath: 'example run', input: {},
      })[Symbol.asyncIterator]().next()).rejects.toMatchObject({
        envelope: {
          code: 'KB_HOST_UNREACHABLE',
          message: `The KB Labs host is not running: cannot connect to ${path.join(directory, 'missing.sock')}.`,
          hint: 'Run "kb-create start", or "kb-create doctor" if the host should already be running.',
        },
      });
    } finally {
      await transport.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
