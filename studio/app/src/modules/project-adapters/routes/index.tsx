/**
 * @module @kb-labs/studio-app/modules/project-adapters/routes
 * Per-project adapters module routing configuration
 */

import type { RouteObject } from 'react-router-dom';
import { ProjectAdaptersPage } from '../pages/project-adapters-page';
import { ErrorBoundary } from '../../../components/error-boundary';
import { renderIcon } from '../../../routes/helpers';
import type { NavigationItem } from '@/components/ui';

const PATHS = {
  ROOT: '/adapters',
} as const;

const KEYS = {
  MODULE: 'project-adapters',
} as const;

export const projectAdaptersRoutes: RouteObject[] = [
  {
    path: PATHS.ROOT,
    element: <ProjectAdaptersPage />,
    errorElement: <ErrorBoundary />,
  },
];

export const projectAdaptersNavigation: NavigationItem = {
  key: KEYS.MODULE,
  label: 'Adapters',
  icon: renderIcon('ToolOutlined'),
  path: PATHS.ROOT,
};
