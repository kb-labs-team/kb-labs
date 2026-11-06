import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { writeCliResultTo } from './result-serializer.js';

describe('CLI result serializer', () => {
  let pathToOutput: string | undefined;
  let outputFd: number | undefined;

  afterEach(() => {
    if (outputFd !== undefined) closeSync(outputFd);
    if (pathToOutput !== undefined) unlinkSync(pathToOutput);
    outputFd = undefined;
    pathToOutput = undefined;
  });

  it('finishes writing a result synchronously before the caller exits', () => {
    pathToOutput = path.join(tmpdir(), `kb-cli-result-${randomUUID()}`);
    outputFd = openSync(pathToOutput, 'wx', 0o600);

    writeCliResultTo(outputFd, { ok: false, error: { code: 'KB_CLI_RESULT_UNAVAILABLE' } });

    expect(readFileSync(pathToOutput, 'utf8')).toBe('{"ok":false,"error":{"code":"KB_CLI_RESULT_UNAVAILABLE"}}\n');
  });
});
