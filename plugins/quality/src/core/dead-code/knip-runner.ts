/**
 * Knip integration — runs `knip --reporter json` and parses output.
 *
 * Knip is already installed at the workspace root and configured via knip.config.ts.
 * We invoke it as a shell command and parse its JSON report.
 */

import type { ShellAPI } from '@kb-labs/sdk';
import type { KnipReport } from '../../contracts/index.js';

interface KnipJsonOutput {
  files?: string[];
  exports?: Array<{
    file: string;
    exports: Array<{ symbol: string }>;
  }>;
  dependencies?: Array<{
    name: string;
    packages?: string[];
  }>;
  devDependencies?: Array<{
    name: string;
    packages?: string[];
  }>;
  unlisted?: Array<{
    name: string;
    packages?: string[];
  }>;
}

export interface RunKnipOptions {
  shell: ShellAPI;
  rootDir: string;
}

/**
 * Run knip and return parsed report.
 * Knip exits non-zero when issues are found — that is expected, not an error.
 */
export async function runKnip(opts: RunKnipOptions): Promise<KnipReport> {
  const { shell, rootDir } = opts;

  // Run knip; ignore non-zero exit code since knip exits 1 when issues are found
  const result = await shell.exec('pnpm', ['knip', '--reporter', 'json'], { cwd: rootDir }).catch(() => null);

  if (!result) {return emptyReport();}

  const raw = result.stdout.trim();
  if (!raw || raw === '{}' || raw === '[]') {return emptyReport();}

  let parsed: KnipJsonOutput;
  try {
    parsed = JSON.parse(raw) as KnipJsonOutput;
  } catch {
    return emptyReport();
  }

  return parseKnipOutput(parsed, rootDir);
}

function parseKnipOutput(out: KnipJsonOutput, rootDir: string): KnipReport {
  const unusedFiles: string[] = (out.files ?? []).map(f =>
    f.startsWith('/') ? f : `${rootDir}/${f}`
  );

  const unusedExports = (out.exports ?? []).flatMap(entry =>
    (entry.exports ?? []).map(exp => ({
      file: entry.file,
      symbol: exp.symbol,
    }))
  );

  const unusedDependencies = (out.dependencies ?? []).flatMap(dep =>
    (dep.packages ?? [rootDir]).map(workspace => ({
      package: dep.name,
      workspace,
    }))
  );

  const unlistedDependencies = (out.unlisted ?? []).flatMap(dep =>
    (dep.packages ?? [rootDir]).map(workspace => ({
      package: dep.name,
      workspace,
    }))
  );

  const totalIssues =
    unusedFiles.length +
    unusedExports.length +
    unusedDependencies.length +
    unlistedDependencies.length;

  return { unusedFiles, unusedExports, unusedDependencies, unlistedDependencies, totalIssues };
}

function emptyReport(): KnipReport {
  return {
    unusedFiles: [],
    unusedExports: [],
    unusedDependencies: [],
    unlistedDependencies: [],
    totalIssues: 0,
  };
}
