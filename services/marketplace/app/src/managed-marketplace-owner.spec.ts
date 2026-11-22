import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createManagedPlatformMutationDispatcher, isManagedPlatformRoot } from './managed-marketplace-owner.js';

describe('managed Marketplace owner dispatcher', () => {
  let root = '';
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('uses the configured binary and physical generation root with a typed stdin request', async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'managed-owner-dispatch-')));
    const platformRoot = path.join(root, 'install', 'versions', 'old');
    await mkdir(platformRoot, { recursive: true });
    const owner = path.join(root, 'kb-create-owner');
    await writeFile(owner, `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.KB_OWNER_CAPTURE, JSON.stringify({args:process.argv.slice(2), cwd:process.cwd(), input:fs.readFileSync(0,'utf8')}));\nprocess.stdout.write(JSON.stringify({ok:true,activeRoot:'/install/versions/next'}));\n`);
    await chmod(owner, 0o700);
    const capture = path.join(root, 'captured.json');
    const previous = process.env.KB_OWNER_CAPTURE;
    process.env.KB_OWNER_CAPTURE = capture;
    try {
      const dispatch = createManagedPlatformMutationDispatcher({ ownerBinary: owner, platformRoot });
      const result = await dispatch({ operation: 'install', specs: ['@kb-labs/sample-adapter@1.2.3'], dev: true });
      expect(result).toEqual({ ok: true, activeRoot: '/install/versions/next' });
      expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual({
        args: ['marketplace-owner', '--platform-root', platformRoot, '--json'],
        cwd: platformRoot,
        input: JSON.stringify({ mutation: { operation: 'install', specs: ['@kb-labs/sample-adapter@1.2.3'], dev: true } }),
      });
      const update = await dispatch({ operation: 'update', packageIds: ['@kb-labs/sample-adapter'] });
      expect(update).toEqual({ ok: true, activeRoot: '/install/versions/next' });
      expect(JSON.parse(await readFile(capture, 'utf8'))).toMatchObject({
        input: JSON.stringify({ mutation: { operation: 'update', packageIds: ['@kb-labs/sample-adapter'] } }),
      });
    } finally {
      if (previous === undefined) delete process.env.KB_OWNER_CAPTURE;
      else process.env.KB_OWNER_CAPTURE = previous;
    }
  });

  it('rejects request-scoped credentials before launching the owner', async () => {
    const dispatch = createManagedPlatformMutationDispatcher({ ownerBinary: undefined, platformRoot: '/install/versions/old' });
    await expect(dispatch({ operation: 'install', specs: ['@kb-labs/sample-adapter'], shareToken: 'request-secret' })).rejects.toThrow(/share tokens/);
  });

  it('recognizes a managed version root even without Host-provided environment markers', async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'managed-owner-layout-')));
    const active = path.join(root, 'versions', '1.0.0');
    await mkdir(active, { recursive: true });
    await symlink(active, path.join(root, 'current'));
    expect(await isManagedPlatformRoot(active)).toBe(true);
    await unlink(path.join(root, 'current'));
    expect(await isManagedPlatformRoot(active)).toBe(true);
    expect(await isManagedPlatformRoot(root)).toBe(false);
  });
});
