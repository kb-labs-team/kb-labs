import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createProjectRegistry } from '@kb-labs/core-project-registry';
import { loadPlatformConfig, type LoadPlatformConfigResult } from '@kb-labs/core-runtime';

export interface PlatformConfigFixtureOptions {
  cwd: string;
  home: string;
  rawConfig: Record<string, unknown>;
  projectScope?: 'required' | 'platform';
  registeredProjects?: string[];
}

export async function createPlatformConfigFixture(
  options: PlatformConfigFixtureOptions,
): Promise<LoadPlatformConfigResult> {
  const kbHome = path.join(options.home, '.kb');
  await mkdir(kbHome, { recursive: true });
  await writeFile(path.join(kbHome, 'kb.config.json'), JSON.stringify(options.rawConfig));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: options.home,
    KB_HOME: kbHome,
    KB_PLATFORM_ROOT: options.home,
  };
  delete env.KB_PROJECT_ROOT;
  delete env.KB_PROJECT_ID;

  if (options.registeredProjects?.length) {
    const projectRegistry = createProjectRegistry({ root: kbHome });
    const registered = new Set((await projectRegistry.list()).projects.map(({ project }) => project.path));
    for (const projectRoot of options.registeredProjects) {
      await mkdir(projectRoot, { recursive: true });
      if (!registered.has(projectRoot)) await projectRegistry.add(projectRoot);
    }
  }

  return loadPlatformConfig({
    startDir: options.cwd,
    env,
    loadEnvFile: false,
    projectScope: options.projectScope ?? 'platform',
    persistCatalogSnapshot: false,
  });
}
