/**
 * Analytics event constants for agent system
 */

/**
 * Analytics event IDs
 */
export const AGENT_ANALYTICS_EVENTS = {
  // Run lifecycle
  RUN_STARTED: 'agent.run.started',
  RUN_COMPLETED: 'agent.run.completed',
  RUN_FAILED: 'agent.run.failed',
  RUN_STOPPED: 'agent.run.stopped',

  // Corrections
  CORRECTION_SENT: 'agent.correction.sent',
  CORRECTION_APPLIED: 'agent.correction.applied',
  CORRECTION_REJECTED: 'agent.correction.rejected',

  // WebSocket
  WS_CONNECTED: 'agent.ws.connected',
  WS_DISCONNECTED: 'agent.ws.disconnected',

  // Agent execution
  AGENT_SPAWNED: 'agent.spawned',
  AGENT_COMPLETED: 'agent.completed',
  TOOL_CALLED: 'agent.tool.called',
  TIER_ESCALATED: 'agent.tier.escalated',
} as const;

export type AgentAnalyticsEvent = typeof AGENT_ANALYTICS_EVENTS[keyof typeof AGENT_ANALYTICS_EVENTS];
