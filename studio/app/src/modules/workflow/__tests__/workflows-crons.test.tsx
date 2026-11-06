import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WorkflowsCrons from '../pages/WorkflowsCrons.js';

const hooks = vi.hoisted(() => ({
  useData: vi.fn(),
  useMutateData: vi.fn(),
  useWorkflowProject: vi.fn(),
  component: (name: string) => Object.assign(() => null, { displayName: name }),
}));

vi.mock('@kb-labs/studio-ui-kit', () => ({
  UITable: hooks.component('table'), UITag: hooks.component('span'), UISpace: hooks.component('div'),
  UITypographyText: hooks.component('span'), UIBadge: hooks.component('span'), UIIcon: hooks.component('i'),
  UIButton: hooks.component('button'), UICard: hooks.component('section'), UIPage: hooks.component('main'),
  UIPageHeader: hooks.component('header'),
}));
vi.mock('@kb-labs/studio-hooks', () => ({ useData: hooks.useData, useMutateData: hooks.useMutateData }));

vi.mock('../components/shared/WorkflowProjectPicker.js', () => ({
  useWorkflowProject: hooks.useWorkflowProject,
}));

type Cron = {
  id: string;
  source: 'user' | 'plugin';
  schedule: string;
  target: { workflow: string } | { handler: string };
  enabled: boolean;
  lastRun?: { id: string; status: string; time: string };
  nextFireAt?: string;
};

function cronTable(): { columns: Array<{ key: string; render: (...args: never[]) => React.ReactNode }> } {
  const root = WorkflowsCrons() as React.ReactElement<{ children: React.ReactNode }>;
  const children = React.Children.toArray(root.props.children) as React.ReactElement[];
  const tableCard = children[2] as React.ReactElement<{ children: React.ReactNode }>;
  const table = React.Children.toArray(tableCard.props.children)[0] as React.ReactElement;
  return table.props as ReturnType<typeof cronTable>;
}

function childText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(childText).join(' ');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return childText(node.props.children);
  return '';
}

describe('WorkflowsCrons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.useWorkflowProject.mockReturnValue({ projectId: 'project-a', picker: null, hasProjects: true });
    hooks.useData.mockReturnValue({ data: { crons: [] }, isLoading: false, refetch: vi.fn() });
  });

  it('renders the schedule details and keeps plugin crons read only', () => {
    const columns = cronTable().columns;
    const find = (key: string) => columns.find(column => column.key === key)!;
    const pluginCron: Cron = {
      id: 'plugin:release:nightly', source: 'plugin', schedule: '0 2 * * *',
      target: { handler: 'release:publish' }, enabled: true,
      lastRun: { id: 'run-7', status: 'success', time: '2026-01-01T00:00:00Z' },
      nextFireAt: '2026-01-02T02:00:00Z',
    };

    expect(childText(find('schedule').render(pluginCron.schedule as never))).toContain('0 2 * * *');
    expect(childText(find('target').render(pluginCron.target as never))).toContain('release:publish');
    expect(childText(find('enabled').render(pluginCron.enabled as never))).toContain('Enabled');
    expect(childText(find('lastRun').render(pluginCron.lastRun as never))).toContain('success');
    expect(childText(find('nextFireAt').render(pluginCron.nextFireAt as never))).not.toBe('-');
    expect(find('action').render(undefined as never, pluginCron as never)).toMatchObject({ props: { children: 'Read only' } });
  });

  it('sends the selected user cron toggle and refreshes the list', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    const refetch = vi.fn();
    hooks.useData.mockReturnValue({ data: { crons: [] }, isLoading: false, refetch });
    hooks.useMutateData.mockReturnValue({ isLoading: false, mutateAsync });
    const userCron: Cron = {
      id: 'nightly', source: 'user', schedule: '0 2 * * *', target: { workflow: 'release' }, enabled: true,
    };
    const toggleElement = cronTable().columns.find(column => column.key === 'action')!.render(undefined as never, userCron as never) as React.ReactElement;
    const toggle = toggleElement.type as (props: { projectId: string; cron: Cron; onSuccess: () => void }) => React.ReactElement;
    const button = toggle(toggleElement.props as { projectId: string; cron: Cron; onSuccess: () => void });
    await (button.props as { onClick: () => Promise<void> }).onClick();

    expect(hooks.useMutateData).toHaveBeenCalledWith('/v1/projects/project-a/workflow/crons/nightly/disable');
    expect(mutateAsync).toHaveBeenCalledOnce();
    expect(refetch).toHaveBeenCalledOnce();
  });
});
