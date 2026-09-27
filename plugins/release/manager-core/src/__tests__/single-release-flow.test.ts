import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { planRelease } from '../planner';
import { resolveFlowFromTag } from '../tag';
import type { ReleaseConfig } from '../types';

const repoRoot = resolve(__dirname, '../../../../..');

/** Strip // and block comments (string-aware) plus trailing commas. */
function parseJsonc(src: string): unknown {
  const withoutComments = src.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_match, str: string | undefined) => str ?? '',
  );
  return JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, '$1'));
}

function makeMonorepo(packages: Array<{ name: string; dir: string; version: string }>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kb-single-flow-')));
  execSync('git init -q', { cwd: root });
  execSync('git config user.email "test@test.com"', { cwd: root });
  execSync('git config user.name "Test"', { cwd: root });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n  - "sdk/*"\n');
  for (const pkg of packages) {
    mkdirSync(join(root, pkg.dir), { recursive: true });
    writeFileSync(join(root, pkg.dir, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version }));
  }
  execSync('git add -A && git commit -q -m "chore: initial"', { cwd: root });
  return root;
}

describe('single platform release flow', () => {
  const config: ReleaseConfig = {
    flows: {
      platform: { versioningStrategy: 'lockstep', packages: { exclude: ['@kb-labs/adapters-fs'] } },
    },
  };

  it('plans one version for every package including the SDK packages', async () => {
    const root = makeMonorepo([
      { name: '@kb-labs/core-runtime', dir: 'packages/core-runtime', version: '2.120.0' },
      { name: '@kb-labs/sdk', dir: 'sdk/sdk', version: '2.120.0' },
      { name: '@kb-labs/platform-client', dir: 'sdk/platform-client', version: '2.120.0' },
    ]);
    try {
      execSync('git tag platform-v2.120.0', { cwd: root });
      writeFileSync(join(root, 'sdk/sdk/feature.txt'), 'x');
      execSync('git add -A && git commit -q -m "feat: new sdk helper"', { cwd: root });

      const plan = await planRelease({ cwd: root, config, flow: 'platform' });
      const names = plan.packages.map(p => p.name).sort();
      expect(names).toEqual(['@kb-labs/core-runtime', '@kb-labs/platform-client', '@kb-labs/sdk']);
      expect(new Set(plan.packages.map(p => p.nextVersion))).toEqual(new Set(['2.121.0']));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still resolves platform-vX tags and no longer resolves sdk-vX tags', () => {
    expect(resolveFlowFromTag(config, 'platform-v2.121.0')).toEqual({ flowName: 'platform', channel: 'stable' });
    expect(resolveFlowFromTag(config, 'sdk-v2.121.0')).toBeNull();
  });
});

describe('no remaining reference to an sdk release flow', () => {
  it('release.flows in .kb/kb.config.jsonc has only platform and it includes the SDK packages', () => {
    const cfg = parseJsonc(readFileSync(join(repoRoot, '.kb/kb.config.jsonc'), 'utf8')) as {
      profiles: Array<{ id: string; products?: { release?: ReleaseConfig } }>;
    };
    const flows = cfg.profiles.find(p => p.id === 'default')?.products?.release?.flows ?? {};
    expect(Object.keys(flows)).toEqual(['platform']);
    const excluded = flows.platform?.packages?.exclude ?? [];
    expect(excluded).not.toContain('@kb-labs/sdk');
    expect(excluded).not.toContain('@kb-labs/platform-client');
    expect(flows.platform?.packages?.include ?? []).toEqual([]);
  });

  it('release workflows do not offer or accept an sdk flow', () => {
    const files = [
      '.kb/workflows/release-prepare.yml',
      '.kb/workflows/release-promote.yml',
      ...readdirSync(join(repoRoot, '.github/workflows'))
        .filter(name => /^release-.*\.yml$/.test(name))
        .map(name => `.github/workflows/${name}`),
    ];
    for (const file of files) {
      const text = readFileSync(join(repoRoot, file), 'utf8');
      expect(text, file).not.toMatch(/options:\s*\[[^\]]*\bsdk\b/);
      expect(text, file).not.toMatch(/platform\|sdk/);
      expect(text, file).not.toMatch(/flow[^\n]*"sdk"/);
    }
  });
});
