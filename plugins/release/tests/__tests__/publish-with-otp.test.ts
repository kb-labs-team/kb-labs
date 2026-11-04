import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

const capturedShell: Array<boolean | undefined> = [];

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn((_command: string, _args: string[], options: { shell?: boolean }) => {
    capturedShell.push(options.shell);
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  }),
}));

vi.mock('@kb-labs/sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@kb-labs/sdk')>(),
  useEnv: vi.fn(() => undefined),
}));

import { publishPackagesWithOTP } from '../../src/shared/publish-with-otp';

let packageDir: string;

describe('publishPackagesWithOTP process boundary', () => {
  beforeEach(() => {
    packageDir = mkdtempSync(join(tmpdir(), 'x241-publish-otp-'));
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@kb-labs/fixture', version: '1.0.0' }));
    capturedShell.length = 0;
  });

  afterEach(() => rmSync(packageDir, { recursive: true, force: true }));

  it('starts package managers without shell interpretation', async () => {
    await publishPackagesWithOTP({
      packages: [{ name: '@kb-labs/fixture', version: '1.0.0', path: packageDir }],
      packageManager: 'npm',
      ui: { write: () => undefined },
    });

    expect(capturedShell).toEqual([false]);
  });
});
