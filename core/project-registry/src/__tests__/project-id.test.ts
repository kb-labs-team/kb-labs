import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectRegistryError } from '../errors.js';
import { canonicalizeProjectPath, deriveProjectId, isProjectId } from '../project-id.js';

let sandbox: string;

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'kb-project-id-')));
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function isCaseInsensitiveFs(dir: string): boolean {
  const probe = join(dir, 'CaseProbe');
  mkdirSync(probe);
  try {
    realpathSync.native(join(dir, 'caseprobe'));
    return true;
  } catch {
    return false;
  }
}

describe('deriveProjectId', () => {
  it('is deterministic and has the documented shape', () => {
    const id = deriveProjectId('/work/app');
    expect(id).toBe(deriveProjectId('/work/app'));
    expect(isProjectId(id)).toBe(true);
    expect(id).toMatch(/^prj_[0-9a-f]{16}$/);
  });

  it('ignores a trailing slash', () => {
    expect(deriveProjectId('/work/app/')).toBe(deriveProjectId('/work/app'));
  });

  it('differs for different paths (a moved folder is a new project)', () => {
    expect(deriveProjectId('/work/app')).not.toBe(deriveProjectId('/elsewhere/app'));
  });

  it('rejects relative input', () => {
    expect(() => deriveProjectId('work/app')).toThrow(ProjectRegistryError);
  });
});

describe('canonicalizeProjectPath', () => {
  it('maps a symlink to the same canonical path and id as its target', async () => {
    const target = join(sandbox, 'real-project');
    mkdirSync(target);
    const link = join(sandbox, 'link-to-project');
    symlinkSync(target, link);

    const viaLink = await canonicalizeProjectPath(link);
    const direct = await canonicalizeProjectPath(target);
    expect(viaLink).toBe(direct);
    expect(deriveProjectId(viaLink)).toBe(deriveProjectId(direct));
  });

  it('accepts a trailing slash and dot segments', async () => {
    const target = join(sandbox, 'slashy');
    mkdirSync(target);
    const plain = await canonicalizeProjectPath(target);
    expect(await canonicalizeProjectPath(`${target}/`)).toBe(plain);
    expect(await canonicalizeProjectPath(join(target, '..', 'slashy', '.'))).toBe(plain);
  });

  it('maps a differently-cased spelling to one id on case-insensitive file systems', async () => {
    const dir = join(sandbox, 'case-fs');
    mkdirSync(dir);
    if (!isCaseInsensitiveFs(dir)) {
      // Case-sensitive FS: distinct spellings are distinct folders, nothing to unify.
      return;
    }
    const upper = await canonicalizeProjectPath(join(dir, 'CaseProbe'));
    const lower = await canonicalizeProjectPath(join(dir, 'caseprobe'));
    expect(lower).toBe(upper);
    expect(deriveProjectId(lower)).toBe(deriveProjectId(upper));
  });

  it('reports a missing path with a typed error', async () => {
    await expect(canonicalizeProjectPath(join(sandbox, 'nope'))).rejects.toMatchObject({
      code: 'KB_PROJECT_PATH_NOT_FOUND',
    });
  });

  it('reports a file as not a directory', async () => {
    const file = join(sandbox, 'a-file.txt');
    writeFileSync(file, 'x');
    await expect(canonicalizeProjectPath(file)).rejects.toMatchObject({ code: 'KB_PROJECT_NOT_A_DIRECTORY' });
  });
});
