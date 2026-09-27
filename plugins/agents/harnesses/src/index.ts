import type { ExternalHarnessId } from '@kb-labs/agent-contracts';
import type { ExternalHarnessAdapter } from './types.js';
import { claudeCodeAdapter } from './adapters/claude-code.js';
import { codexCliAdapter } from './adapters/codex-cli.js';

const adapters: Record<ExternalHarnessId, ExternalHarnessAdapter> = {
  'codex-cli': codexCliAdapter,
  'claude-code': claudeCodeAdapter,
};

export function getExternalHarnessAdapter(id: ExternalHarnessId): ExternalHarnessAdapter {
  return adapters[id];
}

export type { ExternalHarnessAdapter, HarnessLaunch, HarnessLaunchInput, HarnessMcpAccess, PreparedHarnessMcpConfig, ParsedHarnessLine } from './types.js';
