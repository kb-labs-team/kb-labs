import { describe, expect, it } from 'vitest';
import { TurnAssembler } from '../turn-assembler.js';

describe('TurnAssembler sub-agent projection', () => {
  it('projects shared start/activity/end events into one expandable sub-agent step', () => {
    const assembler = new TurnAssembler();
    assembler.processEvent({
      type: 'agent:start', timestamp: '2026-09-26T10:00:00.000Z', agentId: 'orchestrator',
      data: { task: 'Coordinate work', tier: 'medium', maxIterations: 5, toolCount: 2 },
    });

    const started = assembler.processEvent({
      type: 'subagent:start', timestamp: '2026-09-26T10:00:01.000Z', agentId: 'orchestrator',
      data: { subagentId: 'child-1', description: 'Review the API', harness: 'claude-code' },
    });
    expect(started?.steps).toMatchObject([{
      type: 'subagent', turnId: 'child-1', agentName: 'claude-code', status: 'running', lastAction: 'Started',
    }]);

    const active = assembler.processEvent({
      type: 'subagent:activity', timestamp: '2026-09-26T10:00:02.000Z', agentId: 'orchestrator',
      data: { subagentId: 'child-1', activityType: 'tool', action: 'Read file' },
    });
    expect(active?.steps[0]).toMatchObject({
      type: 'subagent', lastAction: 'Read file', activities: [{ type: 'tool', action: 'Read file' }],
    });

    const completed = assembler.processEvent({
      type: 'subagent:end', timestamp: '2026-09-26T10:00:03.000Z', agentId: 'orchestrator',
      data: { subagentId: 'child-1', status: 'completed', summary: 'Review passed.' },
    });
    expect(completed?.steps[0]).toMatchObject({ status: 'completed', summary: 'Review passed.' });
  });
});
