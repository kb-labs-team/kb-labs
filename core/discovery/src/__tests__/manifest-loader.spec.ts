import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadManifestFile } from '../manifest-loader.js';
import { DiagnosticCollector } from '../diagnostics.js';

describe('loadManifest', () => {
  let tmpDir: string;
  let diag: DiagnosticCollector;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-manifest-test-'));
    diag = new DiagnosticCollector();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Resolution via kb.plugin.json ────────────────────────────────────

  it('loads manifest from kb.plugin.json', async () => {
    const pkgDir = path.join(tmpDir, 'my-plugin');
    await fs.mkdir(pkgDir, { recursive: true });

    const manifest = {
      schema: 'kb.plugin/3',
      id: '@kb-labs/my-plugin',
      version: '1.0.0',
    };
    await fs.writeFile(path.join(pkgDir, 'kb.plugin.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@kb-labs/my-plugin' }));

    const result = await loadManifestFile(pkgDir, diag);

    expect(result.kind).toBe('manifest');
    if (result.kind === 'manifest') {
      expect(result.loaded.manifest.id).toBe('@kb-labs/my-plugin');
      expect(result.loaded.manifest.version).toBe('1.0.0');
    }
    expect(diag.hasErrors()).toBe(false);
  });

  it('returns a validation failure when kb.plugin.json is not valid ManifestV3', async () => {
    const pkgDir = path.join(tmpDir, 'bad-manifest');
    await fs.mkdir(pkgDir, { recursive: true });

    // Missing schema field → not a valid ManifestV3
    await fs.writeFile(path.join(pkgDir, 'kb.plugin.json'), JSON.stringify({ id: 'x', version: '1.0.0' }));
    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'x' }));

    const result = await loadManifestFile(pkgDir, diag);

    expect(result.kind).toBe('failed');
    const validationError = diag.getEvents().find(d => d.code === 'MANIFEST_VALIDATION_ERROR');
    expect(validationError).toBeDefined();
  });

  // ── No manifest found ────────────────────────────────────────────────

  it('returns not-plugin when no manifest declaration exists', async () => {
    const pkgDir = path.join(tmpDir, 'empty-plugin');
    await fs.mkdir(pkgDir, { recursive: true });
    // No kb.plugin.json or package.json declaration.
    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'empty' }));

    const result = await loadManifestFile(pkgDir, diag);

    expect(result.kind).toBe('not-plugin');
    expect(diag.getEvents().map(event => event.code)).toContain('MANIFEST_NOT_PLUGIN');
    expect(diag.getEvents().map(event => event.code)).not.toContain('MANIFEST_NOT_FOUND');
  });

  // ── Resolution via package.json field ────────────────────────────────

  it('ignores kbLabs.manifest and continues to the canonical static plugin manifest', async () => {
    const pkgDir = path.join(tmpDir, 'pkg-field');
    await fs.mkdir(pkgDir, { recursive: true });

    const manifest = {
      schema: 'kb.plugin/3',
      id: '@kb-labs/pkg-field',
      version: '2.0.0',
    };
    const manifestFile = 'custom-manifest.json';
    await fs.writeFile(path.join(pkgDir, manifestFile), JSON.stringify(manifest));
    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@kb-labs/pkg-field', kbLabs: { manifest: `./${manifestFile}` } }),
    );
    const fallback = { schema: 'kb.plugin/3', id: '@kb-labs/canonical-fallback', version: '1.0.0' };
    await fs.writeFile(path.join(pkgDir, 'kb.plugin.json'), JSON.stringify(fallback));

    const result = await loadManifestFile(pkgDir, diag);

    expect(result.kind).toBe('manifest');
    if (result.kind === 'manifest') {
      expect(result.loaded.manifest.id).toBe('@kb-labs/canonical-fallback');
      expect(result.loaded.manifest.version).toBe('1.0.0');
    }
  });

  it('loads manifest from package.json kb.manifest field', async () => {
    const pkgDir = path.join(tmpDir, 'kb-field');
    await fs.mkdir(pkgDir, { recursive: true });

    const manifest = {
      schema: 'kb.plugin/3',
      id: '@kb-labs/kb-field',
      version: '3.0.0',
    };
    await fs.writeFile(path.join(pkgDir, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@kb-labs/kb-field', kb: { manifest: './manifest.json' } }),
    );

    const result = await loadManifestFile(pkgDir, diag);

    expect(result.kind).toBe('manifest');
    if (result.kind === 'manifest') {expect(result.loaded.manifest.id).toBe('@kb-labs/kb-field');}
  });

  // ── Path traversal guard ─────────────────────────────────────────────

  it('rejects manifest path that escapes package root (path traversal)', async () => {
    const pkgDir = path.join(tmpDir, 'traversal');
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'x', kb: { manifest: '../../etc/passwd' } }),
    );

    const result = await loadManifestFile(pkgDir, diag);

    expect(result.kind).toBe('failed');
    const traversalError = diag.getEvents().find(d =>
      d.code === 'MANIFEST_VALIDATION_ERROR' && d.message.includes('path traversal'),
    );
    expect(traversalError).toBeDefined();
    expect(traversalError!.severity).toBe('error');
  });

  // ── Missing package.json (continues to next strategy) ────────────────

  it('continues to kb.plugin.json when package.json is missing', async () => {
    const pkgDir = path.join(tmpDir, 'no-pkg-json');
    await fs.mkdir(pkgDir, { recursive: true });

    const manifest = {
      schema: 'kb.plugin/3',
      id: '@kb-labs/fallback',
      version: '1.0.0',
    };
    await fs.writeFile(path.join(pkgDir, 'kb.plugin.json'), JSON.stringify(manifest));

    const result = await loadManifestFile(pkgDir, diag);

    expect(result.kind).toBe('manifest');
    if (result.kind === 'manifest') {expect(result.loaded.manifest.id).toBe('@kb-labs/fallback');}
  });

  // ── Priority order (package.json field wins over kb.plugin.json) ─────

  it('prefers package.json manifest field over kb.plugin.json', async () => {
    const pkgDir = path.join(tmpDir, 'priority');
    await fs.mkdir(pkgDir, { recursive: true });

    // kb.plugin.json has different ID
    await fs.writeFile(
      path.join(pkgDir, 'kb.plugin.json'),
      JSON.stringify({ schema: 'kb.plugin/3', id: 'from-kb-plugin-json', version: '1.0.0' }),
    );
    // package.json field points to a different manifest
    const customManifest = { schema: 'kb.plugin/3', id: 'from-pkg-field', version: '1.0.0' };
    await fs.writeFile(path.join(pkgDir, 'custom.json'), JSON.stringify(customManifest));
    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'priority', kb: { manifest: './custom.json' } }),
    );

    const result = await loadManifestFile(pkgDir, diag);

    expect(result.kind).toBe('manifest');
    if (result.kind === 'manifest') {expect(result.loaded.manifest.id).toBe('from-pkg-field');}
  });

  // case: S-203.25
  it('reports a missing adjacent JSON artifact without importing a declared module', async () => {
    const pkgDir = path.join(tmpDir, 'import-failure');
    await fs.mkdir(path.join(pkgDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@third-party/broken', kb: { manifest: './dist/manifest.js' } }));
    await fs.writeFile(path.join(pkgDir, 'dist/helper.js'), "throw new Error('helper was imported');\n");
    await fs.writeFile(path.join(pkgDir, 'dist/manifest.js'), "import './helper.js'; export const manifest = {};\n");

    const result = await loadManifestFile(pkgDir, diag);

    expect(result.kind).toBe('failed');
    expect(diag.getEvents().map(event => event.code)).toContain('MANIFEST_PARSE_ERROR');
    expect(diag.getEvents().map(event => event.message).join('\n')).toContain('manifest.json');
    expect(diag.getEvents().map(event => event.message).join('\n')).not.toContain('helper was imported');
    expect(diag.getEvents().map(event => event.code)).not.toContain('MANIFEST_NOT_FOUND');
  });

  // case: S-203.25
  it('requires a recognized schema in the adjacent JSON artifact', async () => {
    const pkgDir = path.join(tmpDir, 'default-only');
    await fs.mkdir(path.join(pkgDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@third-party/default-only', kb: { manifest: './dist/manifest.js' } }));
    await fs.writeFile(path.join(pkgDir, 'dist/manifest.json'), JSON.stringify({ schema: 'unknown', id: '@third-party/default-only' }));

    const result = await loadManifestFile(pkgDir, diag);

    expect(result).toMatchObject({ kind: 'failed', cause: expect.stringContaining('must declare a recognized schema') });
    expect(diag.getEvents().map(event => event.code)).toContain('MANIFEST_VALIDATION_ERROR');
  });

  // case: S-203.25
  it('requires a recognized schema instead of guessing an entity from legacy fields', async () => {
    const pkgDir = path.join(tmpDir, 'unknown-schema');
    await fs.mkdir(path.join(pkgDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@third-party/unknown-schema', kb: { manifest: './dist/manifest.js' } }));
    await fs.writeFile(path.join(pkgDir, 'dist/manifest.json'), JSON.stringify({ manifestVersion: '1.0.0', id: '@third-party/unknown-schema' }));

    const result = await loadManifestFile(pkgDir, diag);

    expect(result).toMatchObject({ kind: 'failed', cause: expect.stringContaining('recognized schema') });
    expect(diag.getEvents().map(event => event.code)).toContain('MANIFEST_VALIDATION_ERROR');
  });

  // case: S-203.25
  it('reports malformed declared kb.plugin.json as a parse failure', async () => {
    const pkgDir = path.join(tmpDir, 'invalid-static');
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, 'kb.plugin.json'), '{"schema":');

    const result = await loadManifestFile(pkgDir, diag);

    expect(result.kind).toBe('failed');
    expect(diag.getEvents().map(event => event.code)).toContain('MANIFEST_PARSE_ERROR');
  });

  // case: S-203.25
  it('does not infer a plugin from the package entry point', async () => {
    const pkgDir = path.join(tmpDir, 'entrypoint-only');
    await fs.mkdir(path.join(pkgDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@third-party/not-a-plugin', main: './dist/index.js' }));
    await fs.writeFile(path.join(pkgDir, 'dist/index.js'), 'export const manifest = { schema: "kb.plugin/3", id: "@third-party/not-a-plugin", version: "1.0.0" };');

    const result = await loadManifestFile(pkgDir, diag);

    expect(result.kind).toBe('not-plugin');
    expect(diag.getEvents().map(event => event.code)).not.toContain('MANIFEST_NOT_FOUND');
  });
});
