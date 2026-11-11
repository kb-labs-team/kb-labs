import { mkdir, mkdtemp, rm, writeFile, copyFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * An isolated temporary project root with its own `.kb/` directory.
 *
 * Used by marketplace/plugin e2e tests so real workspace `.kb/marketplace.lock`
 * and `.kb/plugins.json` are never mutated.
 *
 * Pass the returned `root` via `KB_PROJECT_ROOT` env when starting kb-dev.
 */
export interface IsolatedProjectRoot {
  /** Absolute path to the temp project root. */
  root: string;
  /** Absolute path to `<root>/.kb/devservices.yaml`. */
  devConfigPath: string;
  /** Delete the temp dir. Safe to call multiple times. */
  cleanup(): Promise<void>;
}

export interface IsolatedProjectRootOptions {
  /**
   * If given, copies the devservices.yaml from this existing workspace root.
   * If omitted, a minimal config with only `state-daemon` is written.
   */
  copyDevConfigFrom?: string;
  /** Prefix for the temp dir name (for human diagnosis). */
  prefix?: string;
}

const MINIMAL_DEV_CONFIG = `name: KB Labs E2E Isolated Root

groups:
  infra: [state-daemon]

services:
  state-daemon:
    name: State Daemon
    description: Distributed state management
    group: infra
    type: node
    command: node ./services/state/daemon/dist/bin.cjs
    healthCheck: http://localhost:7777/health
    port: 7777
    url: http://localhost:7777
    env:
      KB_STATE_DAEMON_PORT: "7777"
      KB_STATE_DAEMON_HOST: localhost

settings:
  logsDir: .kb/logs/tmp
  pidDir: .kb/tmp
  startTimeout: 30000
  healthCheckInterval: 1000
`;

export async function createIsolatedProjectRoot(
  opts: IsolatedProjectRootOptions = {},
): Promise<IsolatedProjectRoot> {
  const prefix = opts.prefix ?? 'kb-e2e-';
  const root = await mkdtemp(join(tmpdir(), prefix));
  const kbDir = join(root, '.kb');
  await mkdir(kbDir, { recursive: true });
  await mkdir(join(kbDir, 'tmp'), { recursive: true });
  await mkdir(join(kbDir, 'logs', 'tmp'), { recursive: true });

  const devConfigPath = join(kbDir, 'devservices.yaml');

  if (opts.copyDevConfigFrom) {
    const source = resolve(opts.copyDevConfigFrom, '.kb/devservices.yaml');
    if (!existsSync(source)) {
      throw new Error(`copyDevConfigFrom: no devservices.yaml at ${source}`);
    }
    // Read to validate it exists and is readable.
    await readFile(source, 'utf8');
    await copyFile(source, devConfigPath);
  } else {
    await writeFile(devConfigPath, MINIMAL_DEV_CONFIG, 'utf8');
  }

  let disposed = false;
  const cleanup = async () => {
    if (disposed) {return;}
    disposed = true;
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      // intentionally empty: best-effort cleanup, tmpdir will be reaped eventually
    }
  };

  return { root, devConfigPath, cleanup };
}
