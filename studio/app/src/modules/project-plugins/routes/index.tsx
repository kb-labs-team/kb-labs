/**
 * @module @kb-labs/studio-app/modules/project-plugins/routes
 * Per-project plugins module routing configuration
 */

import type { RouteObject } from 'react-router-dom';
import { ProjectPluginsPage } from '../pages/project-plugins-page';
import { ErrorBoundary } from '../../../components/error-boundary';
import { renderIcon } from '../../../routes/helpers';
import type { NavigationItem } from '@/components/ui';

const PATHS = {
  ROOT: '/plugins',
} as const;

const KEYS = {
  MODULE: 'project-plugins',
} as const;

export const projectPluginsRoutes: RouteObject[] = [
  {
    path: PATHS.ROOT,
    element: <ProjectPluginsPage />,
    errorElement: <ErrorBoundary />,
  },
];

export const projectPluginsNavigation: NavigationItem = {
  key: KEYS.MODULE,
  label: 'Plugins',
  icon: renderIcon('ApiOutlined'),
  path: PATHS.ROOT,
};
