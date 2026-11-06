import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEntity } from '../src/loader/load-entity.js';
import { build } from '../src/engine.js';
import {
  writeFiles,
  inspectTarget,
  formatTree,
} from '../src/writer/write-files.js';
import type { RenderContext } from '@kb-labs/scaffold-contracts';

const here = dirname(fileURLToPath(import.meta.url));
const templatesRoot = resolve(here, '../../entry/templates');

const ctx: RenderContext = {
  name: 'demo',
  scope: '@kb-labs',
  vars: {
    description: 'A demo plugin',
    license: 'MIT',
    mode: 'in-workspace',
  },
  blocks: ['base'],
  mode: 'in-workspace',
  versions: { sdk: '2.18.0', devkit: '2.28.0' },
};

describe('engine e2e: plugin/base block', () => {
  let outDir: string;
  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'scaffold-e2e-'));
  });

  it('renders base block into a coherent tree', async () => {
    const entity = await loadEntity(templatesRoot, 'plugin');
    const result = await build({
      entity,
      selectedBlockIds: ['base'],
      context: ctx,
    });

    // Written paths should include the single package root and emitted manifest.
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toContain('package.json');
    expect(paths).toContain('README.md');
    expect(paths.filter((path) => path.endsWith('/package.json') || path === 'package.json')).toEqual(['package.json']);
    expect(paths).toContain('src/core/hello.ts');
    expect(paths).toContain('src/cli/commands/hello.ts');
    expect(paths).toContain('src/manifest.ts');

    // No skip-markers left in output.
    for (const f of result.files) {
      expect(f.contents).not.toContain('@@scaffold:skip@@');
    }

    // pnpm-workspace.yaml is always generated (plugins are self-contained workspaces).
    expect(paths).toContain('pnpm-workspace.yaml');
    const workspaceFile = result.files.find(
      (f) => f.path === 'pnpm-workspace.yaml',
    );
    expect(workspaceFile?.contents).toContain('allowBuilds:');
    expect(workspaceFile?.contents).toContain('onlyBuiltDependencies:');
    expect(workspaceFile?.contents).toContain("'@kb-labs/devkit': true");
    expect(workspaceFile?.contents).toContain('esbuild: true');

    const collisionsTree = formatTree(result.files);
    expect(collisionsTree).toBeTruthy();

    // The generated manifest.ts must reference the kb.plugin/3 schema.
    const manifestFile = result.files.find(
      (f) => f.path === 'src/manifest.ts',
    );
    expect(manifestFile).toBeDefined();
    expect(manifestFile!.contents).toContain('kb.plugin/3');
    expect(manifestFile!.contents).toContain('"id": "@kb-labs/demo"');
    expect(manifestFile!.contents).toContain('combinePermissions');
    expect(manifestFile!.contents).toContain('@kb-labs/sdk');
    const entryPackage = result.files.find(
      (f) => f.path === 'package.json',
    )!;
    expect(JSON.parse(entryPackage.contents).name).toBe('@kb-labs/demo');

    // No leaking internal imports anywhere in the generated tree.
    for (const f of result.files) {
      expect(f.contents).not.toMatch(
        /from\s+['"]@kb-labs\/(core-[a-z-]+|platform-[a-z-]+|core-platform)['"]/,
      );
    }
  });

  it('switches to standalone (one package with semver dependencies)', async () => {
    const entity = await loadEntity(templatesRoot, 'plugin');
    const standaloneCtx: RenderContext = {
      ...ctx,
      vars: { ...ctx.vars, mode: 'standalone' },
      mode: 'standalone',
    };
    const result = await build({
      entity,
      selectedBlockIds: ['base'],
      context: standaloneCtx,
    });
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain('pnpm-workspace.yaml');

    const entryPkg = result.files.find(
      (f) => f.path === 'package.json',
    )!;
    // The generated plugin is one package and depends on the public SDK.
    const packageJson = JSON.parse(entryPkg.contents);
    expect(packageJson.dependencies['@kb-labs/sdk']).toBe('^2.18.0');
    expect(Object.values(packageJson.dependencies)).not.toContain('workspace:*');
  });

  it('composes blocks: base + cli + rest + contracts', async () => {
    const entity = await loadEntity(templatesRoot, 'plugin');
    const result = await build({
      entity,
      selectedBlockIds: ['base', 'cli', 'rest', 'contracts'],
      context: { ...ctx, blocks: ['base', 'cli', 'rest', 'contracts'] },
    });
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain('src/cli/commands/ping.ts');
    expect(paths).toContain('src/rest/hello.ts');
    expect(paths).toContain('src/contracts/events.ts');

    const manifest = result.files.find(
      (f) => f.path === 'src/manifest.ts',
    )!;
    // Both commands present. Commands use `path:` (space-separated tokens) per
    // CliCommandDecl — discover.ts derives segments from path. The old `id:`+
    // `group:` shape produced empty segments → MANIFEST_VALIDATION_FAILED (B-013).
    expect(manifest.contents).toContain('"path": "demo hello"');
    expect(manifest.contents).toContain('"path": "demo ping"');
    // REST section present.
    expect(manifest.contents).toContain('"basePath": "/demo"');
    expect(manifest.contents).toContain('rest/hello.js');
  });

  it('renders adapter entity: base + provider-example', async () => {
    const entity = await loadEntity(templatesRoot, 'adapter');
    const adapterCtx: RenderContext = {
      name: 'my-llm',
      scope: '@kb-labs',
      vars: { description: 'Demo LLM', license: 'MIT', mode: 'in-workspace' },
      blocks: ['base', 'provider-example'],
      mode: 'in-workspace',
      versions: { sdk: '2.18.0', devkit: '2.28.0' },
    };
    const result = await build({
      entity,
      selectedBlockIds: ['base', 'provider-example'],
      context: adapterCtx,
    });
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toContain('src/manifest.ts');
    expect(paths).toContain('src/llm.ts');
    expect(paths).toContain('src/index.ts');

    // Adapter tree must NOT contain the plugin-emitted V3 manifest file.
    const emitted = result.files.find(
      (f) => f.path === 'src/manifest.ts' && f.contents.includes('kb.plugin/3'),
    );
    expect(emitted).toBeUndefined();

    // Must only import from @kb-labs/sdk / @kb-labs/sdk/adapters.
    for (const f of result.files) {
      expect(f.contents).not.toMatch(
        /from\s+['"]@kb-labs\/(core-[a-z-]+|platform-[a-z-]+|core-platform)['"]/,
      );
    }
    const llmSrc = result.files.find((f) => f.path === 'src/llm.ts')!;
    expect(llmSrc.contents).toContain("from '@kb-labs/sdk/adapters'");
  });

  it('actually writes the tree to disk', async () => {
    const entity = await loadEntity(templatesRoot, 'plugin');
    const result = await build({
      entity,
      selectedBlockIds: ['base'],
      context: ctx,
    });

    const target = join(outDir, 'demo-write');
    const state = await inspectTarget(target);
    expect(state.exists).toBe(false);

    await writeFiles({ outRoot: target, files: result.files });

    const helloSrc = await readFile(
      join(target, 'src/core/hello.ts'),
      'utf8',
    );
    expect(helloSrc).toContain('Hello,');
    expect(helloSrc).toContain('from demo');
  });
});
