import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/contracts/index.js';
import { recordDecision } from '../../src/kernel/index.js';
import { AgentSDK } from '../../src/sdk/sdk.js';
import { SessionArtifactStore } from '../../src/store/index.js';
import { RuntimeEngine } from '../../src/runtime/index';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-runtime-'));
  tempDirs.push(dir);
  return dir;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf-8')) as T;
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const content = await readFile(filePath, 'utf-8');
  return content
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

describe('RuntimeEngine', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('persists kernel, turns, tool evidence and run handoff in canonical session artifacts', async () => {
    const workingDir = await createTempDir();
    const sdk = new AgentSDK();
    const seenUpdates: string[] = [];
    const seenTools: string[] = [];

    sdk.registerMemoryCapability({
      id: 'seed-decision',
      apply(state) {
        return recordDecision(state, 'Prefer kernel-backed continuity', 'agent');
      },
    });
    sdk.registerPromptProjector({
      id: 'custom-projector',
      project({ state }) {
        return `# Extension\nTask: ${state.currentTask}`;
      },
    });
    sdk.registerObserver({
      id: 'test-observer',
      onKernelUpdated(state) {
        seenUpdates.push(state.updatedAt);
      },
      onToolCall(record) {
        seenTools.push(record.toolName);
      },
    });
    sdk.registerTurnInterpreter({
      id: 'test-interpreter',
      supports() {
        return true;
      },
      interpret() {
        return {
          kind: 'constraint',
          shouldPersist: true,
          persistenceKind: 'constraint',
          persistStrategy: 'record_directly',
          content: 'Preserve extensibility and record important user instructions.',
          confidence: 0.95,
          suggestedMode: 'spec',
          suggestedSkills: ['spec-analysis', 'session-recall'],
          suggestedPromptProfile: 'spec-planning',
          suggestedToolCapabilities: ['planning', 'session-memory'],
        };
      },
    });

    const store = new SessionArtifactStore(workingDir);
    const runtime = new RuntimeEngine(sdk, store);

    const kernel = await runtime.loadOrCreateKernel({
      sessionId: 'session-test',
      workingDir,
      mode: 'execute',
      task: 'Investigate regression and keep context stable',
    });

    expect(kernel.mode).toBe('autonomous');
    expect(kernel.memory.decisions.some((item) => item.content.includes('kernel-backed continuity'))).toBe(true);
    expect(kernel.routingHints?.suggestedMode).toBe('spec');
    expect(kernel.routingHints?.suggestedSkills).toEqual(['spec-analysis', 'session-recall']);

    const prompt = await runtime.projectPrompt([]);
    expect(prompt).toContain('# Objective');
    expect(prompt).toContain('# Extension');
    expect(prompt).toContain('# Repository Context');
    expect(prompt).toContain('# Routing Hints');
    expect(prompt).toContain('Suggested prompt profile: spec-planning');

    await runtime.recordEvent({
      type: 'tool:start',
      timestamp: new Date().toISOString(),
      runId: 'run-1',
      toolCallId: 'tool-1',
      data: {
        toolName: 'fs_read',
        input: {
          path: 'packages/agent-core/src/core/runner.ts',
        },
      },
    } as AgentEvent);

    const toolEvent: AgentEvent = {
      type: 'tool:end',
      timestamp: new Date().toISOString(),
      runId: 'run-1',
      toolCallId: 'tool-1',
      data: {
        toolName: 'fs_read',
        success: true,
        output: 'Loaded runner implementation',
        metadata: {
          summary: 'Read runner implementation from source',
          filePath: 'packages/agent-core/src/core/runner.ts',
        },
      },
    } as AgentEvent;

    await runtime.recordEvent(toolEvent);
    await runtime.recordEvent({
      type: 'status:change',
      timestamp: new Date().toISOString(),
      runId: 'run-1',
      data: {
        status: 'executing',
        message: 'User correction: preserve extensibility and remove stale assumptions',
      },
    } as AgentEvent);

    await runtime.completeRun({
      sessionId: 'session-test',
      runId: 'run-1',
      mode: 'execute',
      summary: 'Kernel continuity path completed successfully.',
      filesRead: ['packages/agent-core/src/core/runner.ts'],
      filesModified: ['packages/agent-runtime/src/index.ts'],
    });

    const sessionDir = store.getSessionDir('session-test');
    const savedKernel = await readJson<{
      constraints: string[];
      memory: {
        decisions: Array<{ content: string }>;
        corrections: Array<{ content: string }>;
        evidence: Array<{ summary: string; toolInputSummary?: string; toolName?: string }>;
        pendingActions: Array<{ content: string }>;
        latestSummary?: string;
      };
      handoff?: { summary?: string };
      routingHints?: {
        suggestedMode?: string;
        suggestedSkills?: string[];
        suggestedPromptProfile?: string;
      };
    }>(path.join(sessionDir, 'kernel-state.json'));
    const savedMemory = await readJson<{ latestSummary?: string }>(path.join(sessionDir, 'memory.json'));
    const turns = await readJsonl<Array<{ role: string; content: string; metadata?: { interpretation?: { kind?: string } } }>[number]>(path.join(sessionDir, 'turns.jsonl'));
    const toolRecords = await readJsonl<Array<{ toolName: string; input: Record<string, unknown>; artifact: { evidence: Array<{ toolInputSummary?: string }> } }>[number]>(path.join(sessionDir, 'tool-ledger.jsonl'));
    const runRecords = await readJsonl<Array<{ summary: string; mode: string }>[number]>(path.join(sessionDir, 'run-ledger.jsonl'));

    expect(savedKernel.memory.evidence.some((item) => item.summary.includes('packages/agent-core/src/core/runner.ts'))).toBe(true);
    expect(savedKernel.constraints).toContain('Preserve extensibility and record important user instructions.');
    expect(savedKernel.routingHints?.suggestedMode).toBe('spec');
    expect(savedKernel.routingHints?.suggestedSkills).toEqual(['spec-analysis', 'session-recall']);
    expect(savedKernel.routingHints?.suggestedPromptProfile).toBe('spec-planning');
    expect(savedKernel.memory.evidence.some((item) => item.toolInputSummary === 'packages/agent-core/src/core/runner.ts')).toBe(true);
    expect(savedKernel.memory.evidence.some((item) => item.toolName === 'fs_read')).toBe(true);
    expect(savedKernel.memory.corrections.length).toBeGreaterThanOrEqual(1);
    expect(savedKernel.memory.pendingActions.some((item) => item.content.includes('memory_correction'))).toBe(false);
    expect(savedKernel.memory.latestSummary).toContain('Kernel continuity path completed successfully');
    expect(savedKernel.handoff?.summary).toContain('Kernel continuity path completed successfully');
    expect(savedMemory.latestSummary).toContain('Kernel continuity path completed successfully');
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(turns[0]?.metadata?.interpretation?.kind).toBe('constraint');
    expect(toolRecords).toHaveLength(1);
    expect(toolRecords[0]?.toolName).toBe('fs_read');
    expect(toolRecords[0]?.input.path).toBe('packages/agent-core/src/core/runner.ts');
    expect(toolRecords[0]?.artifact.evidence[0]?.toolInputSummary).toBe('packages/agent-core/src/core/runner.ts');
    expect(runRecords[0]?.mode).toBe('autonomous');
    expect(seenUpdates.length).toBeGreaterThanOrEqual(2);
    expect(seenTools).toEqual(['fs_read']);
  });

  it('creates a compacted session rollup for long sessions without losing prompt continuity', async () => {
    const workingDir = await createTempDir();
    const sdk = new AgentSDK();
    sdk.registerTurnInterpreter({
      id: 'follow-up-interpreter',
      supports() {
        return true;
      },
      interpret(input) {
        return {
          kind: input.kernel ? 'follow_up' : 'new_task',
          shouldPersist: false,
          confidence: 0.9,
        };
      },
    });

    const store = new SessionArtifactStore(workingDir);
    const runtime = new RuntimeEngine(sdk, store);

    for (let index = 0; index < 4; index += 1) {
      await runtime.loadOrCreateKernel({
        sessionId: 'session-rollup',
        workingDir,
        mode: 'plan',
        task: index === 0 ? 'Investigate runtime continuity' : `Follow-up ${index}`,
      });
      await runtime.recordEvent({
        type: 'tool:start',
        timestamp: new Date().toISOString(),
        runId: `run-${index}`,
        toolCallId: `tool-${index}`,
        data: {
          toolName: 'shell_exec',
          input: {
            command: index % 2 === 0 ? 'pwd' : 'ls',
          },
        },
      } as AgentEvent);
      await runtime.recordEvent({
        type: 'tool:end',
        timestamp: new Date().toISOString(),
        runId: `run-${index}`,
        toolCallId: `tool-${index}`,
        data: {
          toolName: 'shell_exec',
          success: true,
          output: index % 2 === 0 ? '/tmp/project' : 'README.md\nsrc',
          metadata: {
            summary: index % 2 === 0 ? '/tmp/project' : 'README.md\nsrc',
          },
        },
      } as AgentEvent);
      await runtime.completeRun({
        sessionId: 'session-rollup',
        runId: `run-${index}`,
        mode: 'plan',
        summary: `Completed loop ${index}`,
      });
    }

    const sessionDir = store.getSessionDir('session-rollup');
    const savedKernel = await readJson<{
      rollup?: { summary?: string; turnCount?: number; toolCallCount?: number };
      memory: { evidence: Array<{ summary: string }> };
    }>(path.join(sessionDir, 'kernel-state.json'));
    const savedRollup = await readJson<{ summary?: string; turnCount?: number; toolCallCount?: number } | null>(
      path.join(sessionDir, 'memory-rollup.json'),
    );

    expect(savedKernel.rollup?.summary).toContain('Session activity');
    expect(savedKernel.rollup?.turnCount).toBeGreaterThanOrEqual(8);
    expect(savedKernel.rollup?.toolCallCount).toBeGreaterThanOrEqual(4);
    expect(savedKernel.memory.evidence.length).toBeLessThanOrEqual(8);
    expect(savedRollup?.summary).toBe(savedKernel.rollup?.summary);

    const prompt = await runtime.projectPrompt([]);
    expect(prompt).toContain('# Evidence');
    expect(prompt).toContain('# Previous Run Tool Usage');
    expect(prompt).toContain('shell_exec');
  });

  it('can resolve direct file recall from persisted tool evidence without rereading files', async () => {
    const workingDir = await createTempDir();
    const sdk = new AgentSDK();
    sdk.registerTurnInterpreter({
      id: 'recall-interpreter',
      supports() {
        return true;
      },
      interpret(input) {
        return {
          kind: input.kernel ? 'follow_up' : 'new_task',
          shouldPersist: false,
          confidence: 0.95,
        };
      },
    });

    const store = new SessionArtifactStore(workingDir);
    const runtime = new RuntimeEngine(sdk, store);

    await runtime.loadOrCreateKernel({
      sessionId: 'session-direct-recall',
      workingDir,
      mode: 'plan',
      task: 'Inspect runtime file',
    });
    await runtime.recordEvent({
      type: 'tool:start',
      timestamp: new Date().toISOString(),
      runId: 'run-1',
      toolCallId: 'tool-1',
      data: {
        toolName: 'fs_read',
        input: {
          path: 'plugins/kb-labs-agents/packages/agent-runtime/src/index.ts',
        },
      },
    } as AgentEvent);
    await runtime.recordEvent({
      type: 'tool:end',
      timestamp: new Date().toISOString(),
      runId: 'run-1',
      toolCallId: 'tool-1',
      data: {
        toolName: 'fs_read',
        success: true,
        output: 'Read runtime file',
        metadata: {
          summary: 'Read runtime file',
          filePath: 'plugins/kb-labs-agents/packages/agent-runtime/src/index.ts',
        },
      },
    } as AgentEvent);
    await runtime.completeRun({
      sessionId: 'session-direct-recall',
      runId: 'run-1',
      mode: 'plan',
      summary: 'Inspected runtime file.',
      filesRead: ['plugins/kb-labs-agents/packages/agent-runtime/src/index.ts'],
    });

    await runtime.loadOrCreateKernel({
      sessionId: 'session-direct-recall',
      workingDir,
      mode: 'plan',
      task: 'Which files did you inspect, exactly?',
    });

    const directAnswer = await runtime.tryResolveDirectAnswer([]);
    expect(directAnswer?.answer).toContain('plugins/kb-labs-agents/packages/agent-runtime/src/index.ts');
    expect(directAnswer?.filesRead).toEqual(['plugins/kb-labs-agents/packages/agent-runtime/src/index.ts']);
  });

  it('supports custom session recall resolvers via the SDK extension surface', async () => {
    const workingDir = await createTempDir();
    const sdk = new AgentSDK();
    sdk.registerSessionRecallResolver({
      id: 'custom-session-recall',
      resolve(input) {
        if (!/what did you already inspect/i.test(input.task)) {
          return null;
        }
        return {
          answer: 'I already inspected the custom resolver path.',
          confidence: 0.99,
          filesRead: ['custom/path.ts'],
        };
      },
    });

    const store = new SessionArtifactStore(workingDir);
    const runtime = new RuntimeEngine(sdk, store);

    await runtime.loadOrCreateKernel({
      sessionId: 'session-custom-direct-recall',
      workingDir,
      mode: 'plan',
      task: 'Inspect something custom',
    });

    const directAnswer = await runtime.tryResolveDirectAnswer([
      { role: 'user', content: 'What did you already inspect?' },
    ]);

    expect(directAnswer?.answer).toContain('custom resolver path');
    expect(directAnswer?.filesRead).toEqual(['custom/path.ts']);
  });

  it('resolves and applies runtime profiles for prompt selectors, projectors, and evaluators', async () => {
    const workingDir = await createTempDir();
    await writeFile(path.join(workingDir, 'composer.json'), JSON.stringify({ name: 'demo/app' }));
    const sdk = new AgentSDK();
    sdk.registerRuntimeProfile({
      id: 'assistant-custom-profile',
      mode: 'assistant',
      promptContextSelectors: [{
        id: 'profile-selector',
        select() {
          return {
            includeObjective: true,
            includeSessionRollup: false,
            includeConstraints: false,
            includeRoutingHints: false,
            includeCorrections: false,
            includeDecisions: false,
            includeEvidence: false,
            includePreviousRunToolUsage: false,
            includePreviousRunHandoff: false,
            includeWorkingSummary: false,
            includePendingActions: false,
            correctionWindow: 0,
            decisionWindow: 0,
            evidenceWindow: 0,
            toolUsageWindow: 0,
            pendingActionWindow: 0,
            rationale: 'Profile-scoped selector',
          };
        },
      }],
      promptProjectors: [{
        id: 'profile-projector',
        project({ repositoryModel }) {
          return `# Profile Projector\nPrimary ecosystem: ${repositoryModel?.fingerprints.ecosystems[0]?.name ?? 'unknown'}`;
        },
      }],
      runEvaluators: [{
        id: 'profile-evaluator',
        evaluate() {
          return {
            evidenceGain: 1,
            readinessScore: 0.95,
            repeatedStrategy: false,
            recommendation: 'synthesize',
            rationale: 'Profile evaluator decided the run is ready.',
          };
        },
      }],
    });

    const store = new SessionArtifactStore(workingDir);
    const runtime = new RuntimeEngine(sdk, store);

    await runtime.loadOrCreateKernel({
      sessionId: 'session-runtime-profile',
      workingDir,
      mode: 'plan',
      task: 'Profile scoped prompt behavior',
    });

    expect(runtime.getActiveProfile()?.id).toBe('assistant-custom-profile');

    const prompt = await runtime.projectPrompt([]);
    expect(prompt).toContain('# Objective');
    expect(prompt).toContain('# Profile Projector');
    expect(prompt).toContain('Primary ecosystem: php-ecosystem');
    expect(prompt).not.toContain('# Constraints');
    expect(runtime.getActiveProfile()?.runEvaluators?.[0]?.id).toBe('profile-evaluator');
  });

  it('runs profile-scoped completion validators and artifact writers in completeRun', async () => {
    const workingDir = await createTempDir();
    const sdk = new AgentSDK();
    const artifactPath = path.join(workingDir, 'completion-artifact.json');

    sdk.registerRuntimeProfile({
      id: 'assistant-completion-profile',
      mode: 'assistant',
      outputValidators: [{
        id: 'completion-validator',
        validate(input) {
          if (input.metadata?.kind === 'blocked') {
            return {
              verdict: 'block',
              rationale: 'Blocked by completion validator.',
            };
          }
          return {
            verdict: 'allow',
            rationale: 'Completion validator passed.',
          };
        },
      }],
      artifactWriters: [{
        id: 'completion-writer',
        async write(input) {
          await writeFile(
            artifactPath,
            JSON.stringify({ sessionId: input.sessionId, summary: input.summary, metadata: input.metadata }, null, 2),
            'utf-8',
          );
        },
      }],
      completionPolicy: {
        requireValidatorsToPass: true,
      },
    });

    const store = new SessionArtifactStore(workingDir);
    const runtime = new RuntimeEngine(sdk, store);

    await runtime.loadOrCreateKernel({
      sessionId: 'session-runtime-completion',
      workingDir,
      mode: 'plan',
      task: 'Profile completion flow',
    });

    const blocked = await runtime.completeRun({
      sessionId: 'session-runtime-completion',
      runId: 'run-blocked',
      mode: 'plan',
      summary: 'Blocked summary',
      metadata: { kind: 'blocked' },
    });

    expect(blocked.blockedByPolicy).toBe(true);
    expect(blocked.persisted).toBe(false);
    expect(blocked.validationResults[0]?.verdict).toBe('block');

    const allowed = await runtime.completeRun({
      sessionId: 'session-runtime-completion',
      runId: 'run-allowed',
      mode: 'plan',
      summary: 'Allowed summary',
      metadata: { kind: 'allowed' },
    });

    expect(allowed.blockedByPolicy).toBe(false);
    expect(allowed.persisted).toBe(true);

    const artifact = await readJson<{ summary: string; metadata?: { kind?: string } }>(artifactPath);
    expect(artifact.summary).toBe('Allowed summary');
    expect(artifact.metadata?.kind).toBe('allowed');
  });

  it('builds repository diagnostics from probes without assuming a node-only repository', async () => {
    const workingDir = await createTempDir();
    await writeFile(path.join(workingDir, 'composer.json'), JSON.stringify({ name: 'demo/app' }));
    await writeFile(path.join(workingDir, 'phpunit.xml'), '<phpunit />');
    await writeFile(path.join(workingDir, 'artisan'), '');

    const sdk = new AgentSDK();
    const store = new SessionArtifactStore(workingDir);
    const runtime = new RuntimeEngine(sdk, store);

    await runtime.loadOrCreateKernel({
      sessionId: 'session-php',
      workingDir,
      mode: 'plan',
      task: 'Inspect this repository and explain its stack',
    });

    const model = runtime.getRepositoryModel();
    expect(model?.fingerprints.ecosystems[0]?.name).toBe('php-ecosystem');
    expect(model?.fingerprints.packageManagers.some((signal) => signal.name === 'composer')).toBe(true);
    expect(model?.fingerprints.frameworks.some((signal) => signal.name === 'laravel')).toBe(true);
    expect(model?.stack.languages).toContain('php');
  });

  it('merges repository probes through the default diagnostics provider', async () => {
    const workingDir = await createTempDir();
    await writeFile(path.join(workingDir, 'go.mod'), 'module demo');

    const sdk = new AgentSDK();
    sdk.registerRepositoryProbe({
      id: 'custom-risk-probe',
      probe({ workingDir: probeWorkingDir }) {
        return {
          riskSignals: ['custom_repo_risk'],
          sources: [path.join(probeWorkingDir, 'go.mod')],
        };
      },
    });

    const store = new SessionArtifactStore(workingDir);
    const runtime = new RuntimeEngine(sdk, store);

    await runtime.loadOrCreateKernel({
      sessionId: 'session-go',
      workingDir,
      mode: 'plan',
      task: 'Understand the repository diagnostics',
    });

    const model = runtime.getRepositoryModel();
    expect(model?.fingerprints.languages[0]?.name).toBe('go');
    expect(model?.riskSignals).toContain('custom_repo_risk');
    expect(model?.sources.some((source) => source.endsWith('go.mod'))).toBe(true);
  });
});
