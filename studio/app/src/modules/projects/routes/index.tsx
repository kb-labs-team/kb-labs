/**
 * @module @kb-labs/studio-app/modules/projects/routes
 * Projects module routing configuration
 */

import type { RouteObject } from 'react-router-dom';
import { ProjectsPage } from '../pages/projects-page';
import { ErrorBoundary } from '../../../components/error-boundary';
import { renderIcon } from '../../../routes/helpers';
import type { NavigationItem } from '@/components/ui';

const PATHS = {
  ROOT: '/projects',
} as const;

const KEYS = {
  MODULE: 'projects',
} as const;

export const projectsRoutes: RouteObject[] = [
  {
    path: PATHS.ROOT,
    element: <ProjectsPage />,
    errorElement: <ErrorBoundary />,
  },
];

export const projectsNavigation: NavigationItem = {
  key: KEYS.MODULE,
  label: 'Projects',
  icon: renderIcon('FolderOutlined'),
  path: PATHS.ROOT,
};
