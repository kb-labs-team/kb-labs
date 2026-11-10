import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const binaryManifestTool = join(root, 'tools/kb-create/scripts/prepare-binary-manifest.mjs');
const releaseIndexTool = join(root, 'tools/kb-create/scripts/prepare-release-index.mjs');
const digestToolDirectory = mkdtempSync(join(tmpdir(), 'kb-release-manifest-digest-tool-'));
const digestTool = join(digestToolDirectory, 'kb-create-release-index');

execFileSync('go', ['build', '-trimpath', '-o', digestTool, './v2/cmd/kb-create-release-index'], {
  cwd: join(root, 'tools/kb-create'),
});
after(() => rmSync(digestToolDirectory, { recursive: true, force: true }));

// case: S-284.11
test('candidate binary manifest from release tooling passes release-index preparation', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'kb-journey-release-manifest-'));
  try {
    const artifacts = join(fixture, 'artifacts');
    mkdirSync(artifacts);
    const releaseDist = resolve(process.env.KBLABS_RELEASE_DIST ?? join(root, 'dist'));
    const binaryArtifacts = join(releaseDist, 'artifacts.json');
    const checksums = join(releaseDist, 'checksums.txt');
    const releasedBinaries = JSON.parse(readFileSync(binaryArtifacts, 'utf8'))
      .filter(item => item.type === 'Binary' && item.extra?.Checksum && item.extra.Binary === 'kb-create');
    assert.ok(releasedBinaries.length > 0, 'GoReleaser did not produce kb-create release artifacts');

    const binaryManifest = join(fixture, 'binary-manifest.json');
    execFileSync(process.execPath, [binaryManifestTool,
      '--artifacts', binaryArtifacts,
      '--checksums', checksums,
      '--repository', 'kb-labs-team/kb-labs',
      '--release-tag', 'journey-candidate',
      '--version', '1.0.0',
      '--asset-base-url', 'http://origin:8080/journey-candidate',
      '--output', binaryManifest,
    ]);

    const packages = [
      { name: '@kb-labs/core-runtime', dependencies: {} },
      { name: '@kb-labs/sdk', dependencies: { '@kb-labs/core-runtime': '^1.0.0' } },
      { name: '@kb-labs/host-app', bin: { 'kb-host': './dist/bin.js' } },
    ];
    const stage = packages.map(({ name, ...extra }) => {
      const packageRoot = join(fixture, name.replace(/^@/, '').replaceAll('/', '-'));
      const packageDir = join(packageRoot, 'package');
      mkdirSync(join(packageDir, 'dist'), { recursive: true });
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...extra }));
      writeFileSync(join(packageDir, 'dist/index.js'), `${name} fixture output`);
      if (name === '@kb-labs/host-app') writeFileSync(join(packageDir, 'dist/bin.js'), '#!/usr/bin/env node\n');
      const tarball = `${name.replace(/^@/, '').replaceAll('/', '-')}-1.0.0.tgz`;
      execFileSync('tar', ['-czf', join(artifacts, tarball), '-C', packageRoot, 'package']);
      return {
        name,
        version: '1.0.0',
        tarball,
        sha256: createHash('sha256').update(readFileSync(join(artifacts, tarball))).digest('hex'),
      };
    });
    writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(stage));
    const provenanceManifest = join(fixture, 'provenance.json');
    const provenance = execFileSync(digestTool, ['provenance', artifacts, 'journey-candidate'], {
      input: JSON.stringify(stage),
      encoding: 'utf8',
    });
    writeFileSync(provenanceManifest, provenance);

    const releaseIndex = join(fixture, 'release-index.json');
    const sealer = join(fixture, 'fixture-sealer.mjs');
    writeFileSync(sealer, '#!/usr/bin/env node\nimport { copyFileSync } from "node:fs";\nconst args = process.argv.slice(2);\ncopyFileSync(args[args.indexOf("--input") + 1], args[args.indexOf("--output") + 1]);\n');
    chmodSync(sealer, 0o755);
    execFileSync(process.execPath, [releaseIndexTool,
      '--flow', 'platform',
      '--artifacts-dir', artifacts,
      '--binary-manifest', binaryManifest,
      '--provenance-manifest', provenanceManifest,
      '--platform-package', '@kb-labs/core-runtime',
      '--sdk-package', '@kb-labs/sdk',
      '--host-package', '@kb-labs/host-app',
      '--platform-member-packages', '@kb-labs/core-runtime',
      '--registry', 'http://registry.fixture',
      '--output', releaseIndex,
      '--sealer-bin', sealer,
    ]);

    const index = JSON.parse(readFileSync(releaseIndex, 'utf8'));
    assert.equal(index.platforms[0].version, '1.0.0');
    const actualBinaries = index.platforms[0].binaries;
    assert.equal(actualBinaries.length, releasedBinaries.length);
    for (const artifact of releasedBinaries) {
      const binary = actualBinaries.find(item => item.os === artifact.goos && item.arch === artifact.goarch);
      assert.ok(binary, `missing ${artifact.goos}/${artifact.goarch}`);
      assert.equal(binary.id, artifact.extra.Binary);
      assert.equal(binary.version, '1.0.0');
      assert.equal(binary.url, `http://origin:8080/journey-candidate/${artifact.name}`);
      assert.equal(binary.sha256, createHash('sha256').update(readFileSync(artifact.path)).digest('hex'));
    }

  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
