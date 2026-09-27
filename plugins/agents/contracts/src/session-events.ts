import type { Turn, TurnDelta } from './turn.js';

export const AGENTS_SESSION_EVENT_TOPIC_PREFIX = 'agents.session.';

export function getAgentsSessionEventTopic(sessionId: string): string {
  return `${AGENTS_SESSION_EVENT_TOPIC_PREFIX}${sessionId}`;
}

/** Events delivered from agent runs to every live session connection. */
export type AgentsSessionEvent =
  | { kind: 'deltas'; deltas: TurnDelta[] }
  | { kind: 'cursor'; seq: number }
  | {
      kind: 'run:completed';
      runId: string;
      success: boolean;
      summary: string;
      durationMs: number;
      seq: number;
      turn?: Turn;
    };
