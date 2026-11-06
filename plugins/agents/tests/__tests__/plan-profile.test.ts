import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { KernelState, TaskPlan } from '@kb-labs/agents/contracts';
import { createPlanRuntimeProfile } from '../../src/core/modes/plan-profile.js';
import { PlanDocumentService } from '../../src/core/planning/plan-document-service.js';

describe('createPlanRuntimeProfile', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('provides a blocking validator for incomplete plans', async () => {
    const profile = createPlanRuntimeProfile({ task: 'Verify runtime profile architecture' });
    const validator = profile.outputValidators?.[0];

    expect(validator).toBeDefined();

    const result = await validator?.validate({
      state: createKernelState('/tmp/plan-profile-test', 'session-plan-validator', 'Verify runtime profile architecture'),
      answer: '# Draft\n\nMissing structure.',
      mode: 'assistant',
      metadata: {
        planMarkdown: '# Draft\n\nMissing structure.',
      },
    });

    expect(result?.verdict).toBe('block');
    expect(result?.rationale.length).toBeGreaterThan(0);
  });

  it('maps final markdown into TaskResult.plan through the profile result mapper', async () => {
    const profile = createPlanRuntimeProfile({
      task: 'Verify runtime profile architecture',
      complexity: 'medium',
    });
    const mapper = profile.resultMappers?.[0];

    expect(mapper).toBeDefined();

    const mapped = await mapper?.map({
      state: null,
      answer: [
        '# Plan: Verify runtime profile architecture',
        '',
        '## Task',
        'Проверить архитектуру RuntimeProfile.',
        '',
        '## Steps',
        '### Phase 1',
        '- Read `packages/agent-runtime/src/profiles.ts`',
        '',
        '## Risks',
        '- Missing profile wiring.',
        '',
        '## Verification',
        '- `pnpm --filter @kb-labs/agents/core build`',
        '',
        '## Approval',
        'План готов к согласованию.',
      ].join('\n'),
      mode: 'assistant',
      task: 'Verify runtime profile architecture',
      sessionId: 'session-plan-mapper',
      workingDir: '/tmp/plan-profile-test',
    });

    expect(mapped?.taskResult?.plan?.task).toBe('Verify runtime profile architecture');
    expect(mapped?.taskResult?.plan?.status).toBe('draft');
    expect(mapped?.runtimeMetadata?.plan).toBeTruthy();
    expect(typeof mapped?.summary).toBe('string');
  });

  it('writes plan artifacts through the profile artifact writer', async () => {
    const workingDir = await mkdtemp(path.join(os.tmpdir(), 'plan-profile-'));
    tempDirs.push(workingDir);

    const profile = createPlanRuntimeProfile({
      workingDir,
      task: 'Verify runtime profile architecture',
    });
    const writer = profile.artifactWriters?.[0];

    expect(writer).toBeDefined();

    const plan: TaskPlan = {
      id: 'plan-test-123',
      sessionId: 'session-plan-writer',
      task: 'Verify runtime profile architecture',
      mode: 'plan',
      complexity: 'medium',
      status: 'draft',
      estimatedDuration: 'Unknown',
      createdAt: '2026-04-04T08:00:00.000Z',
      updatedAt: '2026-04-04T08:00:00.000Z',
      markdown: [
        '# Plan: Verify runtime profile architecture',
        '',
        '## Task',
        'Проверить архитектуру RuntimeProfile.',
        '',
        '## Steps',
        '### Phase 1',
        '- Read `packages/agent-runtime/src/profiles.ts`',
        '',
        '## Risks',
        '- Missing profile wiring.',
        '',
        '## Verification',
        '- `pnpm --filter @kb-labs/agents/core build`',
        '',
        '## Approval',
        'План готов к согласованию.',
      ].join('\n'),
      phases: [],
    };

    await writer?.write({
      state: createKernelState(workingDir, plan.sessionId, plan.task),
      sessionId: plan.sessionId,
      summary: plan.markdown ?? '',
      metadata: { plan },
    });

    const planPath = path.join(workingDir, '.kb', 'agents', 'sessions', plan.sessionId, 'plan.json');
    const planDocPath = new PlanDocumentService(workingDir).getPlanPath(plan);

    const savedPlan = JSON.parse(await readFile(planPath, 'utf-8')) as TaskPlan;
    const savedDoc = await readFile(planDocPath, 'utf-8');

    expect(savedPlan.task).toBe(plan.task);
    expect(savedDoc).toContain('## Table of Contents');
    expect(savedDoc).toContain('Проверить архитектуру RuntimeProfile.');
  });

  it('uses a scoped tool policy for narrow planning tasks', () => {
    const profile = createPlanRuntimeProfile({
      task: 'Составь план миграции plan-mode-handler.ts на thin adapter',
      complexity: 'medium',
    });

    expect(profile.toolPolicy!.allowedToolNames).toContain('plan_validate');
    expect(profile.toolPolicy!.allowedToolNames).toContain('report');
    expect(profile.toolPolicy!.allowedToolNames).not.toContain('task_submit');
    expect(profile.toolPolicy!.allowedToolNames).not.toContain('task_collect');
    expect(profile.toolPolicy!.allowedToolNames).not.toContain('todo_create');
  });

  it('keeps delegation tools for broad complex planning tasks', () => {
    const profile = createPlanRuntimeProfile({
      task: 'Составь план миграции across repositories for all packages in the entire workspace',
      complexity: 'complex',
    });

    expect(profile.toolPolicy!.allowedToolNames).toContain('task_submit');
    expect(profile.toolPolicy!.allowedToolNames).toContain('task_collect');
  });
});

function createKernelState(workingDir: string, sessionId: string, task: string): KernelState {
  return {
    version: 1,
    sessionId,
    workingDir,
    mode: 'assistant',
    currentTask: task,
    objective: task,
    constraints: [],
    memory: {
      corrections: [],
      assumptions: [],
      decisions: [],
      evidence: [],
      openQuestions: [],
      pendingActions: [],
    },
    childResults: [],
    updatedAt: new Date().toISOString(),
  };
}
