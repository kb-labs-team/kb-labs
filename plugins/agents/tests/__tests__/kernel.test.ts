import { describe, expect, it } from 'vitest';
import {
  createKernelState,
  ingestUserTurn,
  recordAssumption,
  recordCorrection,
  recordDecision,
  recordToolArtifact,
  summarizeAssistantTurn,
} from '../../src/kernel/index.js';

describe('agent-kernel', () => {
  it('invalidates assumptions via corrections', () => {
    let state = createKernelState({
      sessionId: 's-1',
      workingDir: '/tmp/project',
      mode: 'assistant',
      task: 'initial task',
    });

    state = recordAssumption(state, 'Need to modify auth flow');
    const assumptionId = state.memory.assumptions[0]!.id;
    state = recordCorrection(state, 'No auth changes needed', [assumptionId]);

    expect(state.memory.corrections).toHaveLength(1);
    expect(state.memory.assumptions[0]!.status).toBe('invalidated');
  });

  it('stores decisions, evidence, and working summary', () => {
    let state = createKernelState({
      sessionId: 's-2',
      workingDir: '/tmp/project',
      mode: 'assistant',
      task: 'fix continuity',
    });

    state = ingestUserTurn(state, 'fix continuity in session memory');
    state = recordDecision(state, 'Use kernel-backed continuity state');
    state = recordToolArtifact(state, {
      status: 'success',
      summary: 'Read session manager implementation',
      evidence: [{
        id: 'ev-1',
        summary: 'Read session manager implementation',
        source: 'fs_read',
        createdAt: new Date().toISOString(),
        toolName: 'fs_read',
        toolInputSummary: 'packages/agent-core/src/planning/session-manager.ts',
      }],
    });
    state = summarizeAssistantTurn(state, 'Implemented structured continuity state');

    expect(state.currentTask).toContain('continuity');
    expect(state.memory.decisions).toHaveLength(1);
    expect(state.memory.evidence).toHaveLength(1);
    expect(state.memory.latestSummary).toContain('structured continuity');
  });

  it('records baseline constraints directly without creating a pending commit', () => {
    let state = createKernelState({
      sessionId: 's-3',
      workingDir: '/tmp/project',
      mode: 'assistant',
      task: 'initial',
    });

    state = ingestUserTurn(state, {
      content: 'From now on, only answer questions about previous commands.',
      interpretation: {
        kind: 'constraint',
        shouldPersist: true,
        persistenceKind: 'constraint',
        persistStrategy: 'record_directly',
        content: 'Only answer questions about previous commands.',
        confidence: 0.9,
      },
    });

    expect(state.constraints).toContain('Only answer questions about previous commands.');
    expect(state.memory.corrections[0]?.content).toContain('Only answer questions about previous commands.');
    expect(state.memory.pendingActions).toHaveLength(0);
  });
});
