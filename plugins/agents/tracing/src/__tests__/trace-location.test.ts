import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRuntimeStatePath } from '@kb-labs/core-project-registry';
import { IncrementalTraceWriter } from '../incremental-trace-writer.js';
import { loadTrace, resolveTraceDir } from '../trace-loader.js';

let project: string;
let kbHome: string;
let previousKbHome: string | undefined;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'kb-trace-project-')));
  kbHome = realpathSync(mkdtempSync(join(tmpdir(), 'kb-trace-home-')));
  previousKbHome = process.env.KB_HOME;
  process.env.KB_HOME = kbHome;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousKbHome === undefined) {
    delete process.env.KB_HOME;
  } else {
    process.env.KB_HOME = previousKbHome;
  }
  rmSync(project, { recursive: true, force: true });
  rmSync(kbHome, { recursive: true, force: true });
});

describe('agent trace location (ADR-0044)', () => {
  it('resolves under the project state directory', () => {
    expect(resolveTraceDir(project)).toBe(resolveRuntimeStatePath(project, ['traces', 'incremental']));
  });

  it('loadTrace reads from the state directory', async () => {
    const dir = resolveTraceDir(project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'task-1.ndjson'), JSON.stringify({ type: 'task:start', seq: 1 }) + '\n');

    const result = await loadTrace('task-1', project);
    expect(result.ok).toBe(true);
  });

  it('loadTrace does not read a trace an older version left in the repository', async () => {
    const legacyDir = join(project, '.kb', 'traces', 'incremental');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'task-2.ndjson'), JSON.stringify({ type: 'task:start', seq: 1 }) + '\n');

    const result = await loadTrace('task-2', project);
    expect(result).toEqual({ ok: false, error: { kind: 'not_found', taskId: 'task-2' } });
  });

  it('the writer defaults to the state directory and leaves the repository clean', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    new IncrementalTraceWriter('task-3');

    expect(existsSync(resolveTraceDir(project))).toBe(true);
    expect(existsSync(join(project, '.kb'))).toBe(false);
  });
});
