/** Common measured result contract for native and externally hosted agent runs. */
export type AgentRoundOutcome = 'done' | 'partial' | 'plan-question' | 'blocked';

export type AgentRunFailureKind =
  | 'rate_limit'
  | 'preflight'
  | 'permission_denied'
  | 'timeout'
  | 'cancelled'
  | 'process'
  | 'invalid_output'
  | 'unknown_runner'
  | 'budget_unmeasurable';

export interface AgentRunFailure {
  kind: AgentRunFailureKind;
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}

export interface AgentRunUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  wallTimeMs: number;
  rounds: number;
  cost?: { amount: number; currency: string };
}

export interface AgentRunnerCapabilities {
  reportsUsage: boolean;
}

