import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveWorkspaceRoot } from './workspace-root.js';

const FLAG_NAME = 'KB_AGENTS_E2E_DEEP';

/**
 * Resolve the shared deep-agent-E2E flag. A process environment variable wins
 * over the workspace `.env`; only this one key is read from that file.
 */
export function isDeepAgentE2EEnabled(): boolean {
  const processValue = process.env[FLAG_NAME];
  const value = processValue === undefined ? readWorkspaceFlag() : processValue;
  return value?.trim().toLowerCase() === '1' || value?.trim().toLowerCase() === 'true';
}

function readWorkspaceFlag(): string | undefined {
  let workspaceRoot: string;
  try {
    workspaceRoot = resolveWorkspaceRoot();
  } catch {
    return undefined;
  }

  try {
    const content = readFileSync(resolve(workspaceRoot, '.env'), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*KB_AGENTS_E2E_DEEP\s*=\s*(.*?)\s*$/);
      if (match) {
        return match[1]?.replace(/^(['"])(.*)\1$/, '$2').split('#', 1)[0]?.trim();
      }
    }
  } catch {
    // A missing workspace .env is normal in CI and fresh checkouts.
  }
  return undefined;
}
