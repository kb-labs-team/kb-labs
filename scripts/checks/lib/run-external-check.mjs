import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CHECK_RESULT_FILE_ENV } from './check-result.mjs';

/** Run one external-check script with kb-devkit's result-file contract. */
export function runExternalCheck(script, args = [], options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'kb-external-check-test-'));
  const resultPath = path.join(directory, 'result.json');
  try {
    const child = spawnSync(process.execPath, [script, ...args], {
      ...options,
      encoding: options.encoding ?? 'utf8',
      env: { ...process.env, ...options.env, [CHECK_RESULT_FILE_ENV]: resultPath },
    });
    return {
      exitCode: child.status,
      stdout: child.stdout,
      stderr: child.stderr,
      result: existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : undefined,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
