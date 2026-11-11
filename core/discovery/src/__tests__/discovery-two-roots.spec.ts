/**
 * Tests for DiscoveryManager with two roots (platformRoot + root).
 *
 * This covers the installed ("prod") mode where the platform lives at a
 * different path from the user's project:
 *   - platformRoot = ~/kb-platform  (installed platform, basic plugins)
 *   - root         = ~/my-project   (user project, workspace plugins)
 *
 * Project lock wins on conflict; paths are resolved against the correct root.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { DiscoveryManager } from '../discovery-manager.js';
import { writeMarketplaceLock, createEmptyLock, createMarketplaceEntry } from '../marketplace-lock.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makePlugin(
  dir: string,
  id: string,
  version = '1.0.0',
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: id, version }),
    'utf-8',
  );
  await fs.writeFile(
    path.join(dir, 'kb.plugin.json'),
    JSON.stringify({ schema: 'kb.plugin/3', id, version }),
    'utf-8',
  );
  return dir;
}

async function integrity(dir: string): Promise<string> {
  const content = await fs.readFile(path.join(dir, 'package.json'));
  return `sha256-${crypto.createHash('sha256').update(content).digest('base64')}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiscoveryManager — two-root mode (platformRoot + root)', () => {
  let platformDir: string;
  let projectDir: string;

  beforeEach(async () => {
    platformDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-platform-'));
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-project-'));
  });

  afterEach(async () => {
    await fs.rm(platformDir, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------

  it('discovers plugins from platform lock when only platformRoot has a lock', async () => {
    const pluginDir = path.join(platformDir, 'node_modules', '@kb-labs', 'commit');
    await makePlugin(pluginDir, '@kb-labs/commit');

    const platformLock = createEmptyLock();
    platformLock.plugins['@kb-labs/commit'] = createMarketplaceEntry({
      version: '1.0.0',
      integrity: await integrity(pluginDir),
      package: '@kb-labs/commit',
      resolvedPath: './node_modules/@kb-labs/commit',
      source: 'platform',
      primaryKind: 'plugin',
      provides: ['plugin'],
    });
    await writeMarketplaceLock(platformDir, platformLock);

    // No project lock
    const dm = new DiscoveryManager({ root: projectDir, platformRoot: platformDir, verifyIntegrity: true });
    const result = await dm.discover();

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]!.id).toBe('@kb-labs/commit');
    expect(result.plugins[0]!.packageRoot).toBe(
      path.resolve(platformDir, './node_modules/@kb-labs/commit'),
    );
  });

  // -------------------------------------------------------------------------

  it('discovers plugins from project lock when project has entries not in platform lock', async () => {
    // Platform: only commit
    const platformPluginDir = path.join(platformDir, 'node_modules', '@kb-labs', 'commit');
    await makePlugin(platformPluginDir, '@kb-labs/commit');
    const platformLock = createEmptyLock();
    platformLock.plugins['@kb-labs/commit'] = createMarketplaceEntry({
      version: '1.0.0',
      integrity: await integrity(platformPluginDir),
      package: '@kb-labs/commit',
      resolvedPath: './node_modules/@kb-labs/commit',
      source: 'platform',
      primaryKind: 'plugin',
      provides: ['plugin'],
    });
    await writeMarketplaceLock(platformDir, platformLock);

    // Project: mind (workspace, not in platform)
    const projectPluginDir = path.join(projectDir, 'plugins', 'mind');
    await makePlugin(projectPluginDir, '@kb-labs/mind');
    const projectLock = createEmptyLock();
    projectLock.plugins['@kb-labs/mind'] = createMarketplaceEntry({
      version: '2.0.0',
      integrity: await integrity(projectPluginDir),
      resolvedPath: './plugins/mind',
      source: 'local',
      primaryKind: 'plugin',
      provides: ['plugin'],
    });
    await writeMarketplaceLock(projectDir, projectLock);

    const dm = new DiscoveryManager({ root: projectDir, platformRoot: platformDir, verifyIntegrity: true });
    const result = await dm.discover();

    expect(result.plugins).toHaveLength(2);
    const ids = result.plugins.map(p => p.id).sort();
    expect(ids).toEqual(['@kb-labs/commit', '@kb-labs/mind']);
  });

  // -------------------------------------------------------------------------

  it('project entry wins over platform entry for the same package id', async () => {
    // Platform: commit at ./node_modules/@kb-labs/commit (older version)
    const platformCommitDir = path.join(platformDir, 'node_modules', '@kb-labs', 'commit');
    await makePlugin(platformCommitDir, '@kb-labs/commit', '0.1.0');
    const platformLock = createEmptyLock();
    platformLock.plugins['@kb-labs/commit'] = createMarketplaceEntry({
      version: '0.1.0',
      integrity: await integrity(platformCommitDir),
      package: '@kb-labs/commit',
      resolvedPath: './node_modules/@kb-labs/commit',
      source: 'platform',
      primaryKind: 'plugin',
      provides: ['plugin'],
    });
    await writeMarketplaceLock(platformDir, platformLock);

    // Project: commit at ./plugins/commit (newer workspace version)
    const projectCommitDir = path.join(projectDir, 'plugins', 'commit');
    await makePlugin(projectCommitDir, '@kb-labs/commit', '2.0.0');
    const projectLock = createEmptyLock();
    projectLock.plugins['@kb-labs/commit'] = createMarketplaceEntry({
      version: '2.0.0',
      integrity: await integrity(projectCommitDir),
      resolvedPath: './plugins/commit',
      source: 'local',
      primaryKind: 'plugin',
      provides: ['plugin'],
    });
    await writeMarketplaceLock(projectDir, projectLock);

    const dm = new DiscoveryManager({ root: projectDir, platformRoot: platformDir, verifyIntegrity: true });
    const result = await dm.discover();

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]!.id).toBe('@kb-labs/commit');
    // Project version wins
    expect(result.plugins[0]!.version).toBe('2.0.0');
    // Resolved against projectDir, not platformDir
    expect(result.plugins[0]!.packageRoot).toBe(
      path.resolve(projectDir, './plugins/commit'),
    );
  });

  // -------------------------------------------------------------------------

  it('resolves platform entry paths relative to platformRoot, not projectRoot', async () => {
    const platformPluginDir = path.join(platformDir, 'node_modules', '@kb-labs', 'workflow-entry');
    await makePlugin(platformPluginDir, '@kb-labs/workflow');

    const platformLock = createEmptyLock();
    platformLock.plugins['@kb-labs/workflow'] = createMarketplaceEntry({
      version: '1.0.0',
      integrity: await integrity(platformPluginDir),
      package: '@kb-labs/workflow-entry',
      resolvedPath: './node_modules/@kb-labs/workflow-entry',
      source: 'platform',
      primaryKind: 'plugin',
      provides: ['plugin'],
    });
    await writeMarketplaceLock(platformDir, platformLock);

    const dm = new DiscoveryManager({ root: projectDir, platformRoot: platformDir, verifyIntegrity: true });
    const result = await dm.discover();

    expect(result.plugins).toHaveLength(1);
    // Path resolves against platformDir
    expect(result.plugins[0]!.packageRoot).toBe(
      path.resolve(platformDir, './node_modules/@kb-labs/workflow-entry'),
    );
    // NOT against projectDir
    expect(result.plugins[0]!.packageRoot).not.toBe(
      path.resolve(projectDir, './node_modules/@kb-labs/workflow-entry'),
    );
  });

  // -------------------------------------------------------------------------

  it('resolves project entry paths relative to projectRoot, not platformRoot', async () => {
    const projectPluginDir = path.join(projectDir, 'plugins', 'review');
    await makePlugin(projectPluginDir, '@kb-labs/review');

    const projectLock = createEmptyLock();
    projectLock.plugins['@kb-labs/review'] = createMarketplaceEntry({
      version: '3.0.0',
      integrity: await integrity(projectPluginDir),
      resolvedPath: './plugins/review',
      source: 'local',
      primaryKind: 'plugin',
      provides: ['plugin'],
    });
    await writeMarketplaceLock(projectDir, projectLock);

    // Platform lock has nothing relevant
    await writeMarketplaceLock(platformDir, createEmptyLock());

    const dm = new DiscoveryManager({ root: projectDir, platformRoot: platformDir, verifyIntegrity: true });
    const result = await dm.discover();

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]!.packageRoot).toBe(
      path.resolve(projectDir, './plugins/review'),
    );
  });

  // -------------------------------------------------------------------------

  it('returns empty result when both locks are missing', async () => {
    const dm = new DiscoveryManager({ root: projectDir, platformRoot: platformDir });
    const result = await dm.discover();

    expect(result.plugins).toEqual([]);
    expect(result.manifests.size).toBe(0);
  });

  // -------------------------------------------------------------------------

  it('does not add platformRoot entries twice when root === platformRoot', async () => {
    // Same directory passed for both root and platformRoot
    const pluginDir = path.join(projectDir, 'plugins', 'qa');
    await makePlugin(pluginDir, '@kb-labs/qa');

    const lock = createEmptyLock();
    lock.plugins['@kb-labs/qa'] = createMarketplaceEntry({
      version: '1.0.0',
      integrity: await integrity(pluginDir),
      resolvedPath: './plugins/qa',
      source: 'local',
      primaryKind: 'plugin',
      provides: ['plugin'],
    });
    await writeMarketplaceLock(projectDir, lock);

    const dm = new DiscoveryManager({
      root: projectDir,
      platformRoot: projectDir, // same as root → treated as single-root mode
      verifyIntegrity: true,
    });
    const result = await dm.discover();

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]!.id).toBe('@kb-labs/qa');
  });
});
