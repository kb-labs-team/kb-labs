import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { mirrorStreamsToFile } from './remote-stage-output.mjs';

test('remote stage mirrors console streams to the requested stage log', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'remote-stage-stream-'));
  const logPath = path.join(temporary, 'build.log');

  try {
    let consoleOutput = '';
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        consoleOutput += chunk.toString();
        callback();
      },
    });
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        consoleOutput += chunk.toString();
        callback();
      },
    });

    mirrorStreamsToFile(logPath, [stdout, stderr]);
    stdout.write('build stdout fixture\n');
    stderr.write('build stderr fixture\n');

    assert.equal(consoleOutput, 'build stdout fixture\nbuild stderr fixture\n');
    assert.equal(readFileSync(logPath, 'utf8'), consoleOutput);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
