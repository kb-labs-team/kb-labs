import { basename, dirname, join } from 'node:path';
import { mkdtemp, rename, rm, stat } from 'node:fs/promises';

/** Write generated files as a recoverable directory transaction. */
export async function writeScaffoldTransaction(
  outRoot: string,
  write: () => Promise<void>,
): Promise<void> {
  let backupDir: string | undefined;
  let previousPath: string | undefined;

  try {
    await stat(outRoot);
    backupDir = await mkdtemp(join(dirname(outRoot), `.${basename(outRoot)}.kb-scaffold-`));
    previousPath = join(backupDir, 'previous');
    await rename(outRoot, previousPath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      if (backupDir) { await rm(backupDir, { recursive: true, force: true }); }
      throw error;
    }
  }

  try {
    await write();
  } catch (error) {
    try {
      await rm(outRoot, { recursive: true, force: true });
      if (previousPath) { await rename(previousPath, outRoot); }
    } catch (rollbackError) {
      if (backupDir) { await rm(backupDir, { recursive: true, force: true }); }
      const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(`Scaffold failed and output rollback failed: ${detail}`);
    }
    if (backupDir) { await rm(backupDir, { recursive: true, force: true }); }
    throw error;
  }

  if (backupDir) { await rm(backupDir, { recursive: true, force: true }); }
}
