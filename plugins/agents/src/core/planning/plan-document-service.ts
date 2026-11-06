import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { TaskPlan } from '../../contracts/index.js';

interface PlanDocumentServiceOptions {
  plansDir?: string;
}

export class PlanDocumentService {
  private readonly workingDir: string;
  private readonly plansDir: string;

  constructor(workingDir: string, options: PlanDocumentServiceOptions = {}) {
    this.workingDir = workingDir;
    this.plansDir = options.plansDir ?? path.join(this.workingDir, 'docs', 'plans', 'agents');
  }

  getPlansDir(): string {
    return this.plansDir;
  }

  getPlanPath(plan: TaskPlan): string {
    const date = new Date(plan.createdAt || Date.now()).toISOString().slice(0, 10);
    const slug = this.slugify(plan.task || 'plan');
    const idSuffix = (plan.id || 'plan').replace(/[^a-zA-Z0-9-]/g, '').slice(-12) || 'plan';
    const filename = `${date}-${slug}-${idSuffix}.md`;
    return path.join(this.plansDir, filename);
  }

  async createDraft(plan: TaskPlan): Promise<{ path: string; markdown: string }> {
    const planPath = this.getPlanPath(plan);
    await fs.mkdir(path.dirname(planPath), { recursive: true });

    const source = typeof plan.markdown === 'string' && plan.markdown.trim().length > 0
      ? plan.markdown
      : this.renderDraft(plan);
    const markdown = this.refreshToc(source);
    await fs.writeFile(planPath, markdown, 'utf-8');

    return { path: planPath, markdown };
  }

  renderDraft(plan: TaskPlan): string {
    return this.buildDraftMarkdown(plan);
  }

  async reviseDraft(planPath: string, markdown: string): Promise<string> {
    const updated = this.refreshToc(markdown);
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, updated, 'utf-8');
    return updated;
  }

  async appendExecutionLog(planPath: string, entry: string): Promise<string> {
    let current = '';
    try {
      current = await fs.readFile(planPath, 'utf-8');
    } catch {
      current = '# Plan\n\n## Execution Log\n';
    }

    const marker = /^##\s+Execution Log\s*$/m;
    let next: string;
    if (marker.test(current)) {
      next = `${current.trimEnd()}\n\n${entry.trim()}\n`;
    } else {
      next = `${current.trimEnd()}\n\n## Execution Log\n\n${entry.trim()}\n`;
    }

    const updated = this.refreshToc(next);
    await fs.writeFile(planPath, updated, 'utf-8');
    return updated;
  }

  refreshToc(markdown: string): string {
    const normalized = markdown.replace(/\r\n/g, '\n');
    const withoutToc = this.removeExistingToc(normalized);
    const lines = withoutToc.split('\n');

    const titleIndex = lines.findIndex((line) => /^#\s+/.test(line));
    if (titleIndex < 0) {
      return withoutToc;
    }

    const headingEntries = this.collectHeadings(withoutToc);
    const tocLines = this.renderToc(headingEntries);
    const tocBlock = ['## Table of Contents', ...tocLines].join('\n');

    const before = lines.slice(0, titleIndex + 1).join('\n').trimEnd();
    const after = lines.slice(titleIndex + 1).join('\n').replace(/^\n+/, '');

    const combined = [before, '', tocBlock, '', after.trimEnd()]
      .filter((part) => part.length > 0)
      .join('\n');

    return `${combined}\n`;
  }

  private buildDraftMarkdown(plan: TaskPlan): string {
    const phaseCommands = this.collectVerificationCommands(plan);
    const phaseSections = plan.phases
      .map((phase, phaseIndex) => {
        const keySteps = this.expandPhaseKeySteps(phase).slice(0, 6);
        const expectedResults = this.collectPhaseExpectedResults(phase).slice(0, 3);

        return [
          `### ${phase.name || `Phase ${phaseIndex + 1}`}`,
          '',
          phase.description || '(scope not specified)',
          '',
          '**Steps:**',
          ...(keySteps.length > 0
            ? keySteps.map((step) => `- ${step}`)
            : ['- (no concrete steps provided)']),
          '',
          '**Expected outcome:**',
          ...(expectedResults.length > 0
            ? expectedResults.map((result) => `- ${result}`)
            : ['- Phase objectives delivered and validated.']),
          '',
        ].join('\n');
      })
      .join('\n');

    const dependencyRisks = plan.phases
      .filter((phase) => phase.dependencies.length > 0)
      .map((phase) => `- ${phase.name || phase.id}: depends on ${phase.dependencies.join(', ')}`);

    return [
      `# Plan: ${plan.task || 'Untitled Task'}`,
      '',
      '## Task',
      '',
      '### Request',
      plan.task || '(not specified)',
      '',
      '### Target Outcome',
      `Move from current state to requested result for: ${plan.task || 'this task'}.`,
      '',
      '## Steps',
      '',
      phaseSections.trim(),
      '',
      '## Risks',
      '',
      '- Unknown coupling or side effects in touched components.',
      ...(dependencyRisks.length > 0 ? dependencyRisks : ['- Hidden dependencies may require plan adjustments during execution.']),
      '',
      '## Verification',
      '',
      '- Run focused checks for touched scope after major changes.',
      ...(phaseCommands.length > 0
        ? phaseCommands.map((command) => `- \`${command}\``)
        : []),
      '',
      '## Approval',
      '',
      `- **Status:** ${plan.status}`,
      '- **Approval Question:** Approve this plan for execution?',
      '',
      '## Execution Log',
      '',
      '- Execution has not started.',
      '',
      '## Revision Log',
      '',
      '| Version | Timestamp | Changed By | Reason | Summary |',
      '| --- | --- | --- | --- | --- |',
      `| 1 | ${plan.createdAt} | agent | initial_draft | Initial draft created. |`,
      '',
    ].join('\n');
  }

  private expandPhaseKeySteps(phase: TaskPlan['phases'][number]): string[] {
    const normalized: string[] = [];

    for (const step of phase.steps) {
      const action = (step.action || '').trim();
      if (!action) {
        continue;
      }

      const prefixedOps = /^implement operations:\s*/i.test(action)
        ? action.replace(/^implement operations:\s*/i, '')
        : action;
      const chunks = prefixedOps
        .split(';')
        .map((chunk) => chunk.trim())
        .filter(Boolean);

      if (chunks.length > 1) {
        normalized.push(...chunks);
      } else {
        normalized.push(action);
      }
    }

    return Array.from(new Set(normalized)).map((item) => this.compactSentence(item));
  }

  private collectPhaseExpectedResults(phase: TaskPlan['phases'][number]): string[] {
    const results = phase.steps
      .map((step) => (step.expectedOutcome || '').trim())
      .filter(Boolean)
      .map((value) => this.compactSentence(value));
    return Array.from(new Set(results));
  }

  private collectVerificationCommands(plan: TaskPlan): string[] {
    const commands: string[] = [];
    for (const phase of plan.phases) {
      for (const step of phase.steps) {
        const tool = (step.tool || '').toLowerCase();
        const args = step.args || {};
        if (!tool.includes('shell') && !tool.includes('terminal') && !tool.includes('exec')) {
          continue;
        }
        const command = typeof args.command === 'string' ? args.command.trim() : '';
        if (command) {
          commands.push(this.compactSentence(command));
        }
      }
    }
    return Array.from(new Set(commands)).slice(0, 8);
  }

  private compactSentence(input: string): string {
    const compact = input.replace(/\s+/g, ' ').trim();
    if (compact.length <= 180) {
      return compact;
    }
    return `${compact.slice(0, 177)}...`;
  }

  private removeExistingToc(markdown: string): string {
    const lines = markdown.split('\n');
    const tocStart = lines.findIndex((line) => /^##\s+Table of Contents\s*$/i.test(line.trim()));
    if (tocStart < 0) {
      return markdown;
    }

    let tocEnd = lines.length;
    for (let i = tocStart + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i] || '')) {
        tocEnd = i;
        break;
      }
    }

    const merged = [...lines.slice(0, tocStart), ...lines.slice(tocEnd)].join('\n');
    return merged.replace(/\n{3,}/g, '\n\n');
  }

  private collectHeadings(markdown: string): Array<{ level: 2 | 3; text: string; anchor: string }> {
    const lines = markdown.split('\n');
    const counters = new Map<string, number>();
    const headings: Array<{ level: 2 | 3; text: string; anchor: string }> = [];

    for (const line of lines) {
      const match = /^(##|###)\s+(.+?)\s*$/.exec(line);
      if (!match) {
        continue;
      }
      const level = match[1] === '###' ? 3 : 2;
      const text = match[2]!.trim();
      if (/^table of contents$/i.test(text)) {
        continue;
      }

      const base = this.slugifyHeading(text);
      const count = counters.get(base) ?? 0;
      counters.set(base, count + 1);
      const anchor = count === 0 ? base : `${base}-${count}`;
      headings.push({ level, text, anchor });
    }

    return headings;
  }

  private renderToc(headings: Array<{ level: 2 | 3; text: string; anchor: string }>): string[] {
    return headings.map((heading) => {
      const indent = heading.level === 3 ? '  ' : '';
      return `${indent}- [${heading.text}](#${heading.anchor})`;
    });
  }

  private slugify(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60) || 'plan';
  }

  private slugifyHeading(input: string): string {
    return input
      .toLowerCase()
      .replace(/[`*_~[\]()>#+.!?,:;'"\\/]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }
}
