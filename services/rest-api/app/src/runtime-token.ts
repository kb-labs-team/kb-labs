import { PROJECT_RUNTIME_TOKEN_ENV } from '@kb-labs/shared-daemon';

/** Consume the guard credential so it cannot be inherited by plugin work. */
export function consumeProjectRuntimeToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env[PROJECT_RUNTIME_TOKEN_ENV];
  delete env[PROJECT_RUNTIME_TOKEN_ENV];
  return token;
}
