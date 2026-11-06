import type { RouteObject } from 'react-router-dom';
import { ThunderboltOutlined } from '@ant-design/icons';
import type { NavigationItem } from '@/components/ui';
import { ErrorBoundary } from '@/components/error-boundary';
import WorkflowsCrons from '../pages/WorkflowsCrons';
import WorkflowsDefinitions from '../pages/WorkflowsDefinitions';
import WorkflowDefinitionDetail from '../pages/WorkflowDefinitionDetail';
import WorkflowsJobs from '../pages/WorkflowsJobs';
import WorkflowRunDetail from '../pages/WorkflowRunDetail';
import WorkflowsRuns from '../pages/WorkflowsRuns';

export const workflowRoutes: RouteObject[] = [
  { path: '/p/workflows/runs', element: <WorkflowsRuns />, errorElement: <ErrorBoundary /> },
  { path: '/p/workflows/runs/:runId', element: <WorkflowRunDetail />, errorElement: <ErrorBoundary /> },
  { path: '/p/workflows/definitions', element: <WorkflowsDefinitions />, errorElement: <ErrorBoundary /> },
  { path: '/p/workflows/definitions/:workflowId', element: <WorkflowDefinitionDetail />, errorElement: <ErrorBoundary /> },
  { path: '/p/workflows/jobs', element: <WorkflowsJobs />, errorElement: <ErrorBoundary /> },
  { path: '/p/workflows/crons', element: <WorkflowsCrons />, errorElement: <ErrorBoundary /> },
];

export const workflowNavigation: NavigationItem = {
  key: 'workflows',
  label: 'Workflows',
  icon: <ThunderboltOutlined />,
  children: [
    { key: 'workflows.runs', label: 'Runs', path: '/p/workflows/runs' },
    { key: 'workflows.definitions', label: 'Definitions', path: '/p/workflows/definitions' },
    { key: 'workflows.jobs', label: 'Jobs', path: '/p/workflows/jobs' },
    { key: 'workflows.crons', label: 'Crons', path: '/p/workflows/crons' },
  ],
};
