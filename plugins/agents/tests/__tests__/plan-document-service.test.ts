import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { TaskPlan } from '@kb-labs/agents/contracts';
import { PlanDocumentService } from '../../src/core/planning/plan-document-service';

const tempDirs: string[] = [];

function makePlan(phasesCount = 2): TaskPlan {
  const createdAt = '2026-02-21T12:00:00.000Z';
  return {
    id: 'plan-abc123',
    sessionId: 'session-1',
    task: 'Implement plan mode structure updates',
    mode: 'plan',
    estimatedDuration: '2 hours',
    complexity: 'medium',
    createdAt,
    updatedAt: createdAt,
    status: 'draft',
    phases: Array.from({ length: phasesCount }, (_, index) => ({
      id: `phase-${index + 1}`,
      name: `Phase ${index + 1} Name`,
      description: `Description for phase ${index + 1}`,
      dependencies: index === 0 ? [] : [`phase-${index}`],
      status: 'pending',
      steps: [
        {
          id: `step-${index + 1}-1`,
          action: `Action ${index + 1}.1`,
          tool: 'fs:read',
          args: { path: `src/file-${index + 1}.ts` },
          expectedOutcome: `Expected outcome ${index + 1}.1`,
          status: 'pending',
        },
      ],
    })),
  };
}

async function makeService(): Promise<{ dir: string; service: PlanDocumentService }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'plan-doc-service-'));
  tempDirs.push(dir);
  return {
    dir,
    service: new PlanDocumentService(dir),
  };
}

function extractTocLinks(markdown: string): string[] {
  const lines = markdown.split('\n');
  const tocStart = lines.findIndex((line) => line.trim() === '## Table of Contents');
  if (tocStart < 0) {
    return [];
  }

  const links: string[] = [];
  for (let i = tocStart + 1; i < lines.length; i++) {
    const line = lines[i] || '';
    if (/^##\s+/.test(line)) {
      break;
    }
    const match = /\(#([^)]+)\)/.exec(line);
    if (match?.[1]) {
      links.push(match[1]);
    }
  }
  return links;
}

function extractHeadingAnchors(markdown: string): Set<string> {
  const lines = markdown.split('\n');
  const seen = new Map<string, number>();
  const anchors = new Set<string>();

  for (const line of lines) {
    const match = /^(##|###)\s+(.+)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const heading = match[2]!.trim();
    if (/^table of contents$/i.test(heading)) {
      continue;
    }
    const base = heading
      .toLowerCase()
      .replace(/[`*_~[\]()>#+.!?,:;'"\\/]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }

  return anchors;
}

describe('PlanDocumentService', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('createDraft writes a plan with TOC and valid heading links', async () => {
    const { service } = await makeService();
    const plan = makePlan(3);

    const { path: filePath } = await service.createDraft(plan);
    const markdown = await readFile(filePath, 'utf-8');

    expect(markdown).toContain('## Table of Contents');
    const links = extractTocLinks(markdown);
    expect(links.length).toBeGreaterThan(0);

    const anchors = extractHeadingAnchors(markdown);
    for (const link of links) {
      expect(anchors.has(link)).toBe(true);
    }
  });

  it('reviseDraft recalculates TOC when sections are changed', async () => {
    const { service } = await makeService();
    const plan = makePlan(2);
    const { path: filePath } = await service.createDraft(plan);
    const original = await readFile(filePath, 'utf-8');

    const revisedInput = `${original}\n## Targeted Rework\n\n### Phase 3: Added During Revision\n\nUpdated details.\n`;
    const revised = await service.reviseDraft(filePath, revisedInput);
    const links = extractTocLinks(revised);

    expect(links).toContain('targeted-rework');
    expect(links).toContain('phase-3-added-during-revision');
  });

  it('refreshToc includes all phases for long plans (10+)', () => {
    const service = new PlanDocumentService('/tmp/project');
    const markdown = [
      '# Plan: Long Plan',
      '',
      '## Execution Plan',
      '',
      ...Array.from({ length: 12 }, (_, i) => `### Phase ${i + 1}: Big Section ${i + 1}`),
      '',
      '## Revision Log',
    ].join('\n');

    const updated = service.refreshToc(markdown);
    const links = extractTocLinks(updated);

    for (let i = 1; i <= 12; i++) {
      expect(links).toContain(`phase-${i}-big-section-${i}`);
    }
  });

  it('refreshToc is idempotent and does not duplicate TOC blocks', async () => {
    const { service } = await makeService();
    const filePath = path.join(service.getPlansDir(), 'manual.md');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      '# Plan: Manual\n\n## Task\n\n### Original Request\nText.\n\n## Execution Plan\n',
      'utf-8'
    );

    const first = service.refreshToc(await readFile(filePath, 'utf-8'));
    const second = service.refreshToc(first);

    expect(second).toBe(first);
    const tocCount = (second.match(/^## Table of Contents$/gm) || []).length;
    expect(tocCount).toBe(1);
  });

  it('createDraft prefers plan markdown body when provided', async () => {
    const { service } = await makeService();
    const plan = makePlan(1);
    plan.markdown = [
      '# Plan: Markdown First',
      '',
      '## Task',
      '',
      'Use markdown body from tool output.',
      '',
      '## Steps',
      '',
      '### Main Work',
      '',
      '- Do one thing',
      '',
      '## Risks',
      '',
      '- Scope drift',
      '',
      '## Verification',
      '',
      '- pnpm test',
      '',
      '## Approval',
      '',
      '- Approve?',
    ].join('\n');

    const { path: filePath } = await service.createDraft(plan);
    const markdown = await readFile(filePath, 'utf-8');

    expect(markdown).toContain('# Plan: Markdown First');
    expect(markdown).toContain('Use markdown body from tool output.');
    expect(markdown).toContain('## Table of Contents');
  });
});
