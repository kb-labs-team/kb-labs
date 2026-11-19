import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const cases = ['S-298.1'];

export function nativeInstallCommands({ workspace = workspaceRoot, tempRoot, platformRoot, registryUrl }) {
  if (!registryUrl) throw new Error('Registry URL is required; run e2e/journey/native-macos-smoke.sh.');
  const createPath = path.join(tempRoot, 'kb-create');
  const createModule = path.join(workspace, 'tools/kb-create');
  const indexPath = path.join(workspace, '.journey/release/journey-candidate/release-index.json');
  const installedCLI = path.join(tempRoot, 'kb');
  return [
    { command: 'make', args: ['build', `BINARY=${createPath}`], cwd: createModule },
    {
      command: createPath,
      args: [
        'install', '--json', '--index', indexPath, '--platform-root', platformRoot,
        '--project-root', workspace, '--scenario', 'explore', '--scenario-answers', '{"access.mode":"local"}',
        '--registry', registryUrl,
      ],
      cwd: workspace,
    },
    { command: installedCLI, args: ['--version'], cwd: workspace },
    { command: installedCLI, args: ['commit', '--help'], cwd: workspace },
    { command: installedCLI, args: ['project', 'add', workspace, '--json'], cwd: workspace },
    { command: installedCLI, args: ['qa', 'cases', 'list', '--json'], cwd: workspace },
  ];
}

export function redactCommandOutput(value, env = process.env) {
  if (!value) return '';
  const result = spawnSync('python3', ['-c', 'import sys; import redaction; sys.stdout.write(redaction.redact_text(sys.stdin.read()))'], {
    cwd: path.join(workspaceRoot, 'e2e/journey'),
    encoding: 'utf8',
    env,
    input: value,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not redact native journey output: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  return result.stdout;
}

function run() {
  const tempRoot = process.env.KB_JOURNEY_NATIVE_ROOT;
  if (!tempRoot) throw new Error('KB_JOURNEY_NATIVE_ROOT is required; run e2e/journey/native-macos-smoke.sh.');
  const registryUrl = process.env.KB_JOURNEY_REGISTRY_URL;
  if (!registryUrl) throw new Error('KB_JOURNEY_REGISTRY_URL is required; run e2e/journey/native-macos-smoke.sh.');
  const platformRoot = path.join(tempRoot, 'platform');
  const reportPath = process.env.KB_JOURNEY_CASE_REPORT;
  let status = 'PASS';
  let caseStatus = 'FAIL';
  let failure = '';
  const logRoot = path.join(workspaceRoot, '.journey/reports/invocations/native-macos');
  mkdirSync(logRoot, { recursive: true });
  for (const [index, step] of nativeInstallCommands({ tempRoot, platformRoot, registryUrl }).entries()) {
    const result = spawnSync(step.command, step.args, { cwd: step.cwd, encoding: 'utf8' });
    const label = `${String(index + 1).padStart(2, '0')}-${path.basename(step.command)}`;
    const stdout = redactCommandOutput(result.stdout ?? '');
    const stderr = redactCommandOutput(result.stderr ?? '');
    writeFileSync(path.join(logRoot, `${label}.stdout.log`), stdout);
    writeFileSync(path.join(logRoot, `${label}.stderr.log`), stderr);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (result.error) {
      status = 'FAIL';
      failure = result.error.message;
      break;
    }
    if (result.status !== 0) {
      status = 'FAIL';
      failure = `${step.command} exited with ${result.status ?? 'no status'}`;
      break;
    }
    if (step.command.endsWith('/kb-create')) {
      try {
        verifyMarketplaceInstall(platformRoot);
      } catch (error) {
        status = 'FAIL';
        failure = error instanceof Error ? error.message : String(error);
        break;
      }
    }
  }

  if (status === 'PASS') caseStatus = 'PASS';

  if (reportPath) {
    const resolvedReport = path.resolve(workspaceRoot, reportPath);
    mkdirSync(path.dirname(resolvedReport), { recursive: true });
    writeFileSync(resolvedReport, `${JSON.stringify({
      case_run: { mode: 'local', claims: cases.map(claimId => ({ claimId, kind: 'journey', status: caseStatus })) },
      steps: [{
        stepId: 'native-macos-marketplace-corepack',
        name: 'Install scenario plugin through Marketplace with Node 24 Corepack',
        mode: 'local',
        cases,
        status: caseStatus,
        ...(caseStatus === 'FAIL' && failure ? { message: failure } : {}),
      }],
    }, null, 2)}\n`);
  }
  if (status !== 'PASS') throw new Error(failure || 'Native macOS Marketplace install did not pass.');
}

export function verifyMarketplaceInstall(installRoot) {
  const currentPlatformRoot = path.join(installRoot, 'current');
  const receiptPath = path.join(currentPlatformRoot, '.kb', 'v2', 'receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const record = receipt.marketplaceInstalls?.find(item => item.id === '@kb-labs/commit');
  if (!record?.version || record.source !== 'npm' || record.spec !== '@kb-labs/commit') {
    throw new Error('Install receipt does not record the Commit scenario plugin from a Marketplace source.');
  }

  const storeRoot = path.join(installRoot, 'state', 'home', 'store');
  const entryDir = path.join(storeRoot, 'entries', `@kb-labs+commit@${record.version}`);
  const corepackHome = path.join(storeRoot, 'cas', '.corepack');
  const pinnedPnpmManifest = path.join(corepackHome, 'v1', 'pnpm', '11.4.0', 'package.json');
  if (!existsSync(path.join(entryDir, 'entry.json'))) {
    throw new Error('Marketplace plugin entry was not published to the platform extension store.');
  }
  if (!existsSync(pinnedPnpmManifest)) {
    throw new Error('Corepack did not cache the release-pinned pnpm 11.4.0 under the platform extension-store cache.');
  }
  const pinnedPnpm = JSON.parse(readFileSync(pinnedPnpmManifest, 'utf8'));
  if (pinnedPnpm.name !== 'pnpm' || pinnedPnpm.version !== '11.4.0') {
    throw new Error('Corepack cached a package-manager version other than the release-pinned pnpm 11.4.0.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
