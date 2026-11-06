import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectRegistry } from '@kb-labs/core-project-registry';

export async function registerTestProject(projectPath: string): Promise<void> {
  await createProjectRegistry().add(await realpath(projectPath));
}

export async function useIsolatedProjectRegistry(
  projectPath: string,
): Promise<() => Promise<void>> {
  const registryHome = await mkdtemp(join(tmpdir(), 'kb-bundle-registry-'));
  const previousKbHome = process.env.KB_HOME;
  process.env.KB_HOME = registryHome;

  try {
    await registerTestProject(projectPath);
  } catch (error) {
    if (previousKbHome === undefined) {delete process.env.KB_HOME;}
    else {process.env.KB_HOME = previousKbHome;}
    await rm(registryHome, { recursive: true, force: true });
    throw error;
  }

  return async () => {
    if (previousKbHome === undefined) {delete process.env.KB_HOME;}
    else {process.env.KB_HOME = previousKbHome;}
    await rm(registryHome, { recursive: true, force: true });
  };
}
