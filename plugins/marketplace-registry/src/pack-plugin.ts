import * as fs from 'node:fs/promises';
import { execa } from 'execa';

/** Runs `pnpm pack` in the given directory and returns the tarball buffer. */
export async function packPlugin(dir: string): Promise<Buffer> {
  const { stdout } = await execa('pnpm', ['pack', '--pack-destination', '/tmp'], { cwd: dir });
  const tarballPath = stdout.trim().split('\n').at(-1)!.trim();
  const tarball = await fs.readFile(tarballPath);
  await fs.unlink(tarballPath).catch(() => { /* ignore cleanup failure */ });
  return tarball;
}
