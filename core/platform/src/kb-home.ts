import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Root for per-user platform state. */
export function resolveKbHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KB_HOME?.trim();
  return resolve(override || join(homedir(), '.kb'));
}
export const credentialsFilePath = (): string => join(resolveKbHome(), 'credentials.json');
export const sessionFilePath = (): string => join(resolveKbHome(), 'session.json');
export const agentConfigPath = (): string => join(resolveKbHome(), 'agent.json');
export const completionCachePath = (): string => join(resolveKbHome(), 'completion.zsh');
export const agentSocketPath = (): string => join(resolveKbHome(), 'agent.sock');
export const projectSettingsFilePath = (root: string, projectId: string): string => join(root, 'state', projectId, 'config.jsonc');
export const projectOverlaysDirPath = (root: string, projectId: string): string => join(root, 'state', projectId, 'overlays');
