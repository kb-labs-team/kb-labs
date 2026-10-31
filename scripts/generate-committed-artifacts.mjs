#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const check = process.argv.includes('--check');
const generators = [
  { command: ['node', 'scripts/test-catalog.mjs', ...(check ? ['--check'] : [])], outputs: ['docs/test-catalog.md'] },
  { command: ['node', 'scripts/generate-ports-doc.mjs'], outputs: ['docs/ports.md'] },
  { command: ['node', 'core/platform/scripts/generate-error-codes.mjs'], outputs: ['core/platform/src/error-envelope/error-codes.generated.ts'] },
  { command: ['corepack', 'pnpm', '--filter', '@kb-labs/studio-ui-kit', 'docs:catalog'], outputs: ['studio/ui-kit/src/catalog.generated.ts'] },
  { command: ['node', 'tools/clikit/toolchain/generate-node-policy.mjs', ...(check ? ['--check'] : [])], outputs: ['tools/clikit/toolchain/node_policy_gen.go', 'tools/clikit/toolchain/node_policy_gen.json'] },
  {
    command: ['node', 'tools/clikit/ui/generate-color-policy.mjs', ...(check ? ['--check'] : [])],
    outputs: [
      'tools/clikit/ui/color_policy_gen.go',
      'tools/clikit/ui/color_policy_cases_test.go',
      'tools/clikit/ui/color_policy_cases.sh',
      'templates/go-binary/cmd/color_policy_gen.go',
      'templates/go-binary/cmd/color_policy_cases_test.go',
      'tools/kb-dev/cmd/color_policy_cases_test.go',
      'tools/kb-create/install.sh',
      'tools/kb-dev/install.sh',
      'tools/kb-deploy/install.sh',
      'tools/kb-devkit/install.sh',
      'tools/kb-monitor/install.sh',
    ],
  },
  { command: ['go', 'generate', './diag'], cwd: 'tools/clikit', outputs: ['tools/clikit/diag/catalog_gen.go'] },
  { command: ['go', 'generate', './v2/cmd/kb-create-v2'], cwd: 'tools/kb-create', outputs: ['tools/kb-create/v2/cmd/kb-create-v2/gateway_bootstrap_gen.go'] },
];
const outputs = generators.flatMap(({ outputs: generated }) => generated);
const backup = mkdtempSync(path.join(os.tmpdir(), 'kb-generated-artifacts-'));
const snapshots = new Map();
try {
  for (const output of outputs) {
    const source = path.join(root, output);
    if (!existsSync(source)) throw new Error(`Generated output is missing: ${output}`);
    const saved = path.join(backup, output);
    snapshots.set(output, readFileSync(source));
    const savedDir = path.dirname(saved);
    mkdirSync(savedDir, { recursive: true });
    copyFileSync(source, saved);
  }

  for (const generator of generators) {
    const [command, ...args] = generator.command;
    const result = spawnSync(command, args, { cwd: path.join(root, generator.cwd ?? '.'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`${generator.command.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }

  const changed = outputs.filter((output) => !snapshots.get(output).equals(readFileSync(path.join(root, output))));
  if (check && changed.length) throw new Error(`Generated files are stale: ${changed.join(', ')}. Run: node scripts/generate-committed-artifacts.mjs`);
  process.stdout.write(`${check ? 'Committed generated artifacts are current' : 'Regenerated committed artifacts'} (${outputs.length} paths).\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (check) {
    for (const [output, content] of snapshots) {
      const current = path.join(root, output);
      if (existsSync(current) && !content.equals(readFileSync(current))) copyFileSync(path.join(backup, output), current);
    }
  }
  rmSync(backup, { recursive: true, force: true });
}
