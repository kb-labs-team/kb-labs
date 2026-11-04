import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { platformFlowPolicies } from '../../../src/core/platform-flow-policy.mjs';

const publishPackagesProgrammatic = vi.fn();
const verifyAgainstRegistry = vi.fn();
const findRepoRoot = vi.fn();

vi.mock('../../../src/core/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/core/index.js')>();
  return {
    ...actual,
    mergeConfigWithFlow: vi.fn((config: { flows: Record<string, unknown> }, flow: string) => config.flows[flow]),
    resolvePublishTag: vi.fn(() => 'latest'),
    verifyAgainstRegistry: (...args: unknown[]) => verifyAgainstRegistry(...args),
  };
});

vi.mock('../../../src/shared/utils.js', () => ({
  findRepoRoot: (...args: unknown[]) => findRepoRoot(...args),
}));

vi.mock('../../../src/shared/publish-programmatic.js', () => ({
  publishPackagesProgrammatic: (...args: unknown[]) => publishPackagesProgrammatic(...args),
}));

vi.mock('@kb-labs/sdk', async importOriginal => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...actual,
    useConfig: vi.fn(async () => ({ flows: { platform: {} } })),
    useEnv: vi.fn((name: string) => process.env[name]),
    useLoader: vi.fn(() => ({ start: vi.fn(), fail: vi.fn(), succeed: vi.fn() })),
  };
});

import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import deliverCommand from '../../../src/cli/commands/deliver.js';
import { createCandidateBundle } from '../../../src/shared/candidate-bundle.js';
import type { CandidateGateProvenance } from '../../../src/core/delivery-policy.js';

const testDeliveryTarget = Object.values(platformFlowPolicies)
  .flatMap(policy => Object.values(policy.deliveryTargets))
  .find(target => target.kind === 'test');
if (!testDeliveryTarget) throw new Error('Platform flow must declare a test delivery target');
const registry = testDeliveryTarget.registry;
const publicDeliveryTarget = Object.values(platformFlowPolicies)
  .flatMap(policy => Object.values(policy.deliveryTargets))
  .find(target => target.kind === 'public');
if (!publicDeliveryTarget) throw new Error('Platform flow must declare a public delivery target');
const packageName = '@kb-labs/fixture';
const packageVersion = '1.0.0';
const tarball = 'kb-labs-fixture-1.0.0.tgz';
let root: string;
let trusted: { candidateId: string; commit: string; flow: string; version: string; expectedDigest: string };

function writeBundle(
  channel: 'canary' | 'stable' = 'canary',
  gate: CandidateGateProvenance = { policy: 'none', result: 'skipped' },
): void {
  const sourceDir = join(root, 'source');
  mkdirSync(sourceDir, { recursive: true });
  const bytes = 'fixture tarball';
  writeFileSync(join(sourceDir, tarball), bytes);
  writeFileSync(join(sourceDir, 'manifest.json'), JSON.stringify([{
    name: packageName,
    version: packageVersion,
    tarball,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }]));
  const releaseIndexPath = join(root, 'release-index.json');
  writeFileSync(releaseIndexPath, JSON.stringify({ platforms: [{ id: 'platform', version: packageVersion }] }));
  const provenance = createCandidateBundle({
    candidateId: 'test-candidate',
    commit: '1234567890123456789012345678901234567890',
    flow: 'platform',
    version: packageVersion,
    channel,
    gate,
    workflowRunId: '1234',
    artifactsDir: sourceDir,
    releaseIndexPath,
    outputDir: join(root, 'bundle'),
  });
  trusted = {
    candidateId: 'test-candidate',
    commit: '1234567890123456789012345678901234567890',
    flow: 'platform',
    version: packageVersion,
    expectedDigest: provenance.bundleDigest,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'x241-deliver-'));
  writeBundle();
  findRepoRoot.mockResolvedValue(root);
  publishPackagesProgrammatic.mockResolvedValue({
    results: [{ name: packageName, version: packageVersion, success: true }],
    published: [`${packageName}@${packageVersion}`],
    alreadyPublished: [],
    failed: [],
    skipped: [],
    errors: [],
  });
  verifyAgainstRegistry.mockResolvedValue([{ issues: [] }]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('release:deliver candidate bundle', () => {
  // case: S-284.1
  it('publishes the bundle tarballs to the configured registry after validating the bundle root', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: root });

    const result = await deliverCommand.execute(ctx as never, mockCLIInput({ flags: {
      flow: 'platform',
      'bundle-dir': 'bundle',
      'expected-digest': trusted.expectedDigest,
      'candidate-id': trusted.candidateId,
      commit: trusted.commit,
      version: trusted.version,
      target: 'local',
      json: true,
    } }));

    expect(publishPackagesProgrammatic).toHaveBeenCalledWith(expect.objectContaining({
      registry,
      packages: [expect.objectContaining({
        name: packageName,
        version: packageVersion,
        tarballPath: join(root, 'bundle', 'npm', tarball),
      })],
    }));
    expect(verifyAgainstRegistry).toHaveBeenCalledWith(
      [expect.objectContaining({ name: packageName, version: packageVersion })],
      expect.objectContaining({ registry }),
    );
    expect(result).toMatchObject({ success: true, registry });
  });

  // case: S-284.5
  it('refuses a canary bundle at a public target with the catalogued policy error', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: root });

    const result = await deliverCommand.execute(ctx as never, mockCLIInput({ flags: {
      flow: 'platform',
      'bundle-dir': 'bundle',
      'expected-digest': trusted.expectedDigest,
      'candidate-id': trusted.candidateId,
      commit: trusted.commit,
      version: trusted.version,
      target: 'npm',
      json: true,
    } }));

    expect(result).toMatchObject({ ok: false, error: {
      code: 'KB_RELEASE_CANDIDATE_POLICY_REJECTED',
      hint: expect.stringContaining('--target local'),
    } });
    expect(publishPackagesProgrammatic).not.toHaveBeenCalled();
  });

  // case: S-284.5
  it('delivers a stable bundle with a passed release-case gate at a public target', async () => {
    rmSync(join(root, 'bundle'), { recursive: true, force: true });
    writeBundle('stable', { policy: 'release-cases', result: 'passed', runId: 'journey-run-17' });
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: root });

    const result = await deliverCommand.execute(ctx as never, mockCLIInput({ flags: {
      flow: 'platform',
      'bundle-dir': 'bundle',
      'expected-digest': trusted.expectedDigest,
      'candidate-id': trusted.candidateId,
      commit: trusted.commit,
      version: trusted.version,
      target: 'npm',
      json: true,
    } }));

    expect(result).toMatchObject({ success: true, registry: publicDeliveryTarget.registry });
    expect(publishPackagesProgrammatic).toHaveBeenCalledWith(expect.objectContaining({ registry: publicDeliveryTarget.registry }));
  });

  // case: S-284.5
  it('requires an explicit declared target and reports how to declare it', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: root });

    const result = await deliverCommand.execute(ctx as never, mockCLIInput({ flags: {
      flow: 'platform',
      'bundle-dir': 'bundle',
      'expected-digest': trusted.expectedDigest,
      'candidate-id': trusted.candidateId,
      commit: trusted.commit,
      version: trusted.version,
      json: true,
    } }));

    expect(result).toMatchObject({ ok: false, error: {
      code: 'KB_RELEASE_DELIVERY_TARGET_INVALID',
      hint: expect.stringContaining('release.flows.platform.deliveryTargets'),
    } });
    expect(publishPackagesProgrammatic).not.toHaveBeenCalled();
  });

  // case: S-284.5
  it('refuses a target name that the flow did not declare', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: root });

    const result = await deliverCommand.execute(ctx as never, mockCLIInput({ flags: {
      flow: 'platform',
      'bundle-dir': 'bundle',
      'expected-digest': trusted.expectedDigest,
      'candidate-id': trusted.candidateId,
      commit: trusted.commit,
      version: trusted.version,
      target: 'undeclared',
      json: true,
    } }));

    expect(result).toMatchObject({ ok: false, error: {
      code: 'KB_RELEASE_DELIVERY_TARGET_INVALID',
      hint: expect.stringContaining('deliveryTargets.undeclared'),
    } });
    expect(publishPackagesProgrammatic).not.toHaveBeenCalled();
  });

  // case: S-284.2
  it('refuses an immutable version that the registry already contains', async () => {
    publishPackagesProgrammatic.mockResolvedValueOnce({
      results: [{ name: packageName, version: packageVersion, success: true, alreadyPublished: true }],
      published: [],
      alreadyPublished: [`${packageName}@${packageVersion}`],
      failed: [],
      skipped: [],
      errors: [],
    });
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: root });

    const result = await deliverCommand.execute(ctx as never, mockCLIInput({ flags: {
      flow: 'platform',
      'bundle-dir': 'bundle',
      'expected-digest': trusted.expectedDigest,
      'candidate-id': trusted.candidateId,
      commit: trusted.commit,
      version: trusted.version,
      target: 'local',
      json: true,
    } }));

    expect(result).toMatchObject({ ok: false, error: { code: 'KB_RELEASE_VERSION_CONFLICT' } });
    expect(verifyAgainstRegistry).not.toHaveBeenCalled();
  });

  // case: S-284.1
  it('reports missing registry credentials with the registry login and exact retry command', async () => {
    publishPackagesProgrammatic.mockResolvedValueOnce({
      results: [{
        name: packageName,
        version: packageVersion,
        success: false,
        error: 'No registry auth token found.',
        errorCode: 'E401',
        errorHint: 'Registry authentication failed.',
      }],
      published: [],
      alreadyPublished: [],
      failed: [`${packageName}@${packageVersion}`],
      skipped: [],
      errors: ['No registry auth token found.'],
    });
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: root });

    const result = await deliverCommand.execute(ctx as never, mockCLIInput({ flags: {
      flow: 'platform',
      'bundle-dir': 'bundle',
      'expected-digest': trusted.expectedDigest,
      'candidate-id': trusted.candidateId,
      commit: trusted.commit,
      version: trusted.version,
      target: 'local',
      json: true,
    } }));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_COMMAND_FAILED',
        message: expect.stringContaining(`${packageName}@${packageVersion}`),
        hint: expect.stringContaining(`npm adduser --registry "${registry}" --auth-type=legacy`),
      },
    });
    expect(verifyAgainstRegistry).not.toHaveBeenCalled();
  });

  // case: S-284.1
  it('rejects a bundle whose recomputed seal differs from the hosted trust anchor before running a command', async () => {
    const attackerDir = join(root, 'attacker-source');
    mkdirSync(attackerDir);
    const attackerBytes = 'attacker tarball';
    writeFileSync(join(attackerDir, tarball), attackerBytes);
    writeFileSync(join(attackerDir, 'manifest.json'), JSON.stringify([{
      name: packageName,
      version: packageVersion,
      tarball,
      sha256: createHash('sha256').update(attackerBytes).digest('hex'),
    }]));
    const indexPath = join(root, 'attacker-index.json');
    writeFileSync(indexPath, JSON.stringify({ platforms: [{ id: 'platform', version: packageVersion }] }));
    createCandidateBundle({
      candidateId: trusted.candidateId,
      commit: trusted.commit,
      flow: trusted.flow,
      version: trusted.version,
      channel: 'canary',
      gate: { policy: 'none', result: 'skipped' },
      workflowRunId: '1234',
      artifactsDir: attackerDir,
      releaseIndexPath: indexPath,
      outputDir: join(root, 'attacker-bundle'),
    });
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: root });

    const result = await deliverCommand.execute(ctx as never, mockCLIInput({ flags: {
      flow: trusted.flow,
      'bundle-dir': 'attacker-bundle',
      'expected-digest': trusted.expectedDigest,
      'candidate-id': trusted.candidateId,
      commit: trusted.commit,
      version: trusted.version,
      target: 'local',
      json: true,
    } }));

    expect(result).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID' } });
    expect(publishPackagesProgrammatic).not.toHaveBeenCalled();
    expect(verifyAgainstRegistry).not.toHaveBeenCalled();
  });

  // case: S-284.1
  it('refuses a shell metacharacter tarball path without invoking publish or exposing the registry token', async () => {
    const sentinel = 'x241-registry-token-sentinel';
    const npmDir = join(root, 'bundle', 'npm');
    const maliciousTarball = 'kb-labs-fixture-1.0.0.tgz;printenv NODE_AUTH_TOKEN > x241-token-leak';
    const originalTarball = join(npmDir, tarball);
    const bytes = readFileSync(originalTarball);
    writeFileSync(join(npmDir, maliciousTarball), bytes);
    const manifestPath = join(npmDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Array<{ tarball: string; sha256: string }>;
    manifest[0]!.tarball = maliciousTarball;
    manifest[0]!.sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    rmSync(originalTarball);
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: root });
    const previousToken = process.env.NODE_AUTH_TOKEN;
    process.env.NODE_AUTH_TOKEN = sentinel;

    let result: Awaited<ReturnType<typeof deliverCommand.execute>>;
    try {
      result = await deliverCommand.execute(ctx as never, mockCLIInput({ flags: {
        flow: trusted.flow,
        'bundle-dir': 'bundle',
        'expected-digest': trusted.expectedDigest,
        'candidate-id': trusted.candidateId,
        commit: trusted.commit,
        version: trusted.version,
        target: 'local',
        json: true,
      } }));
    } finally {
      if (previousToken === undefined) delete process.env.NODE_AUTH_TOKEN;
      else process.env.NODE_AUTH_TOKEN = previousToken;
    }

    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('digest') } });
    expect(publishPackagesProgrammatic).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(sentinel);
    const files = readdirSync(root, { recursive: true, withFileTypes: true });
    expect(files.some(entry => entry.name === 'x241-token-leak')).toBe(false);
    for (const entry of files) {
      if (!entry.isFile()) continue;
      expect(readFileSync(join(entry.parentPath, entry.name)).toString()).not.toContain(sentinel);
    }
  });
});
