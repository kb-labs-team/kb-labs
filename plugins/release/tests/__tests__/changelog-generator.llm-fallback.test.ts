import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { ILLM } from '@kb-labs/sdk';
import type { Change, PackageRelease } from '../../src/changelog/types';
import { packageToTemplateData } from '../../src/changelog/templates/types';

function makePkg(overrides: Partial<PackageRelease> = {}): PackageRelease {
  return {
    name: '@scope/alpha',
    prev: '1.0.0',
    next: '1.1.0',
    bump: 'minor',
    reason: 'feat',
    breaking: [],
    changes: [],
    ...overrides,
  };
}

function makeChange(overrides: Partial<Change>): Change {
  return {
    sha: randomBytes(4).toString('hex'),
    type: 'feat',
    subject: 'does a thing',
    refs: [],
    author: { name: 'test', email: 't@t.com' },
    coAuthors: [],
    packages: [],
    filesChanged: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function slowLLM(delayMs: number): ILLM {
  return {
    async complete() {
      await new Promise(resolve => { setTimeout(resolve, delayMs); });
      return { content: 'should never arrive in time', model: 'test', usage: { promptTokens: 1, completionTokens: 1 } };
    },
  } as unknown as ILLM;
}

function throwingLLM(): ILLM {
  return {
    async complete() {
      throw new Error('LLM backend unavailable');
    },
  } as unknown as ILLM;
}

const groups = [
  { title: 'Gateway', scopes: ['gateway'] },
  { title: 'QA', scopes: ['qa'] },
  { title: 'Adapters', scopes: ['adapters'] },
];

describe('corporate-ai render — per-group LLM timeout resilience', () => {
  it('degrades a single slow group to a plain bullet list instead of hanging indefinitely', async () => {
    const { render } = await import('../../src/changelog/templates/builtin/corporate-ai');
    // Single scope → single group → single enhanceGroup() call, so this
    // isolates the per-call budget from the (separate, expected) fact that
    // N slow groups still take N sequential budgets to fully resolve.
    const pkg = makePkg({
      changes: [makeChange({ type: 'feat', scope: 'gateway', subject: 'add health endpoint' })],
    });
    const data = packageToTemplateData(pkg, 'en', undefined, groups);

    const start = Date.now();
    const markdown = await render(data, { llm: slowLLM(25_000) });
    const elapsed = Date.now() - start;

    expect(markdown).toContain('add health endpoint');
    // Bounded by the per-group timeout (20s), not the 25s LLM delay.
    expect(elapsed).toBeLessThan(23_000);
  }, 25_000);

  it('degrades to a plain bullet list when the LLM call throws outright', async () => {
    const { render } = await import('../../src/changelog/templates/builtin/corporate-ai');
    const pkg = makePkg({
      changes: [makeChange({ type: 'feat', scope: 'gateway', subject: 'add health endpoint' })],
    });
    const data = packageToTemplateData(pkg, 'en', undefined, groups);

    const markdown = await render(data, { llm: throwingLLM() });

    expect(markdown).toContain('add health endpoint');
  });

  it('produces real commit content with no LLM configured at all', async () => {
    const { render } = await import('../../src/changelog/templates/builtin/corporate-ai');
    const pkg = makePkg({
      changes: [makeChange({ type: 'feat', scope: 'gateway', subject: 'add health endpoint' })],
    });
    const data = packageToTemplateData(pkg, 'en', undefined, groups);

    const markdown = await render(data);

    expect(markdown).toContain('add health endpoint');
  });
});

// ─── generateChangelog outer safety net ────────────────────────────────────

function makeGitRepo(): string {
  const root = join(tmpdir(), `kb-changelog-gen-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(root, { recursive: true });
  execSync('git init -q', { cwd: root });
  execSync('git config user.email "test@test.com"', { cwd: root });
  execSync('git config user.name "Test"', { cwd: root });

  const commit = (msg: string) => {
    writeFileSync(join(root, `f-${randomBytes(3).toString('hex')}.txt`), msg);
    execSync('git add -A', { cwd: root });
    execSync(`git commit -q -m ${JSON.stringify(msg)}`, { cwd: root });
  };

  commit('chore: init');
  commit('feat(gateway): add health endpoint');

  return root;
}

vi.mock('../../src/changelog/templates/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/changelog/templates/index.js')>();
  return {
    ...actual,
    loadTemplate: vi.fn(async () => ({
      version: '1.0' as const,
      render: async () => {
        throw new Error('template render is broken');
      },
    })),
  };
});

describe('generateChangelog — outer render fallback', () => {
  let root: string;

  beforeEach(() => {
    root = makeGitRepo();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to a plain commit list instead of throwing when template.render() itself fails', async () => {
    const { generateChangelog } = await import('../../src/changelog/changelog-generator.js');

    const result = await generateChangelog({
      repoRoot: root,
      gitCwd: root,
      packages: [{ name: '@scope/alpha', path: root, currentVersion: '1.0.0', nextVersion: '1.1.0', bump: 'minor' }],
      changelog: { locale: 'en', groups },
    });

    expect(result.markdown).toContain('add health endpoint');
  });
});
