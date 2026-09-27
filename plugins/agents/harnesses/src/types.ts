import type { ExternalHarnessId, SubAgentPreset } from '@kb-labs/agent-contracts';

export interface HarnessLaunchInput {
  harness: ExternalHarnessId;
  workingDir: string;
  prompt: string;
  preset: SubAgentPreset;
  maxIterations: number;
}

export interface HarnessMcpAccess {
  url: string;
  accessToken: string;
}

export interface PreparedHarnessMcpConfig {
  args: string[];
  env?: NodeJS.ProcessEnv;
  cleanup?: () => Promise<void>;
}

export interface HarnessLaunch {
  command: string;
  args: string[];
}

export interface ParsedHarnessLine {
  summary?: string;
  iterations?: number;
  tokensUsed?: number;
  error?: string;
  activity?: {
    type: 'message' | 'tool' | 'progress' | 'thinking' | 'status' | 'error';
    action: string;
    detail?: string;
  };
}

export interface ExternalHarnessAdapter {
  launch(input: HarnessLaunchInput): HarnessLaunch;
  /** Create a per-run, non-persistent connection to the platform MCP lease. */
  prepareMcpConfig?(input: HarnessLaunchInput, access: HarnessMcpAccess): Promise<PreparedHarnessMcpConfig>;
  parseLine(line: string): ParsedHarnessLine;
}
