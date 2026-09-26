import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const kbHome = mkdtempSync(join(tmpdir(), 'kb-registry-test-home-'));
process.env.KB_HOME = kbHome;

afterAll(() => {
  rmSync(kbHome, { recursive: true, force: true });
});
