import type { Phase, TaskPlan } from '../../contracts/index.js';
import type { ResultMapper, ResultMapperResult } from '../../sdk/index.js';

export interface PlanResultMapperOptions {
  task: string;
  complexity: 'simple' | 'medium' | 'complex';
  existingPlan?: TaskPlan | null;
}

export function createPlanResultMapper(options: PlanResultMapperOptions): ResultMapper {
  return {
    id: 'plan-result-mapper',
    map(input) {
      const sessionId = input.sessionId ?? options.existingPlan?.sessionId ?? `session-${Date.now()}`;
      const { markdown, incomplete } = extractMarkdownPlan(
        input.answer,
        options.task,
        options.existingPlan?.markdown,
      );
      const plan = buildTaskPlan({
        sessionId,
        task: options.task,
        complexity: options.complexity,
        markdown,
        existingPlan: options.existingPlan ?? null,
      });
      if (incomplete) {
        plan.status = 'failed';
      }
      const result: ResultMapperResult = {
        taskResult: {
          plan,
          summary: markdown,
        },
        runtimeMetadata: {
          plan,
          planMarkdown: markdown,
        },
        summary: markdown,
      };
      return result;
    },
  };
}

function extractMarkdownPlan(summary: string, task: string, existingMarkdown?: string): { markdown: string; incomplete: boolean } {
  const text = (summary || '').trim();
  if (!text) {
    return { markdown: buildIncompleteMarkdown(task, existingMarkdown), incomplete: true };
  }

  const hasStructure = (value: string) => /^#{1,3}\s+/m.test(value) && value.split('\n').filter((line) => /^#{1,3}\s+/.test(line)).length >= 2;
  if (hasStructure(text)) {
    return { markdown: text, incomplete: false };
  }

  const fenced = /^```(?:markdown|md)\n([\s\S]*?)```\s*$/i.exec(text);
  const candidate = fenced?.[1]?.trim() || text;
  if (hasStructure(candidate)) {
    return { markdown: candidate, incomplete: false };
  }

  return { markdown: buildIncompleteMarkdown(task, candidate), incomplete: true };
}

function buildTaskPlan(input: {
  sessionId: string;
  task: string;
  complexity: 'simple' | 'medium' | 'complex';
  markdown: string;
  existingPlan: TaskPlan | null;
}): TaskPlan {
  const now = new Date().toISOString();
  const planId = input.existingPlan?.id || `plan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const phases = parsePhasesFromMarkdown(input.markdown, planId);
  return {
    id: planId,
    sessionId: input.sessionId,
    task: input.task,
    mode: 'plan',
    phases,
    estimatedDuration: input.existingPlan?.estimatedDuration || 'Unknown',
    complexity: input.complexity,
    createdAt: input.existingPlan?.createdAt || now,
    updatedAt: now,
    status: 'draft',
    markdown: input.markdown,
  };
}

function parsePhasesFromMarkdown(markdown: string, planId?: string): Phase[] {
  const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n');
  const headingIndexes: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^###\s+/.test(lines[i] || '') || /^##\s+Phase\b/i.test(lines[i] || '')) {
      headingIndexes.push(i);
    }
  }

  const extractBullets = (chunk: string[]): string[] =>
    chunk
      .map((line) => {
        const bullet = /^\s*[-*]\s+(.+)\s*$/.exec(line);
        if (bullet?.[1]) {
          return bullet[1].trim();
        }
        const numbered = /^\s*\d+\.\s+(.+)\s*$/.exec(line);
        return numbered?.[1]?.trim() || '';
      })
      .filter(Boolean);

  const anchorPrefix = planId ? `${planId}:` : '';

  if (headingIndexes.length === 0) {
    const bullets = extractBullets(lines);
    return [{
      id: 'phase-1',
      name: 'Plan Execution',
      description: 'Execute the drafted plan.',
      dependencies: [],
      status: 'pending',
      anchor: `${anchorPrefix}phase-1`,
      steps: (bullets.length > 0 ? bullets : ['Execute approved plan changes']).slice(0, 20).map((item, idx) => ({
        id: `step-1-${idx + 1}`,
        action: item,
        expectedOutcome: `Completed: ${item}`,
        status: 'pending',
        anchor: `${anchorPrefix}phase-1:step-${idx + 1}`,
      })),
    }];
  }

  return headingIndexes.map((start, idx) => {
    const end = headingIndexes[idx + 1] ?? lines.length;
    const title = (lines[start] || '').replace(/^#{2,3}\s+/, '').trim() || `Phase ${idx + 1}`;
    const body = lines.slice(start + 1, end);
    const bullets = extractBullets(body);
    const description = body.find((line) => line.trim().length > 0 && !/^\s*(?:[-*]|\d+\.)\s+/.test(line))?.trim()
      || `Execute ${title}`;
    const phaseNum = idx + 1;
    return {
      id: `phase-${phaseNum}`,
      name: title,
      description,
      dependencies: idx === 0 ? [] : [`phase-${idx}`],
      status: 'pending',
      anchor: `${anchorPrefix}phase-${phaseNum}`,
      steps: (bullets.length > 0 ? bullets : [`Execute ${title}`]).slice(0, 20).map((item, stepIdx) => ({
        id: `step-${phaseNum}-${stepIdx + 1}`,
        action: item,
        expectedOutcome: `Completed: ${item}`,
        status: 'pending',
        anchor: `${anchorPrefix}phase-${phaseNum}:step-${stepIdx + 1}`,
      })),
    };
  });
}

function buildIncompleteMarkdown(task: string, capturedText?: string): string {
  const details = (capturedText || '').trim();
  const researchNotes = details
    ? details.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 10)
    : [];

  return [
    `# Plan: ${task}`,
    '',
    '> **WARNING:** This is an incomplete plan. The agent could not generate a proper plan within the iteration budget.',
    '',
    '## Status: INCOMPLETE',
    '',
    '## Task',
    `- User request: ${task}`,
    '- The agent was unable to produce a concrete, actionable plan.',
    '',
    ...(researchNotes.length > 0
      ? [
          '## Research Notes (raw)',
          'The following notes were captured during exploration but do not constitute a plan:',
          '',
          ...researchNotes.map((line) => `- ${line}`),
          '',
        ]
      : []),
    '## Next Steps',
    '- Re-run plan mode with a more focused task description',
    '- Provide additional context or constraints to guide the agent',
    '- Consider breaking the task into smaller sub-tasks',
  ].join('\n');
}
