/**
 * @module @kb-labs/studio-app/modules/health/routes
 * Health module routing configuration
 */

import type { RouteObject } from 'react-router-dom';
import { HealthPage } from '../pages/health-page';
import { ErrorBoundary } from '../../../components/error-boundary';
import { renderIcon } from '../../../routes/helpers';
import type { NavigationItem } from '@/components/ui';

const PATHS = {
  ROOT: '/health',
} as const;

const KEYS = {
  MODULE: 'health',
} as const;

export const healthRoutes: RouteObject[] = [
  {
    path: PATHS.ROOT,
    element: <HealthPage />,
    errorElement: <ErrorBoundary />,
  },
];

export const healthNavigation: NavigationItem = {
  key: KEYS.MODULE,
  label: 'Health',
  icon: renderIcon('HeartOutlined'),
  path: PATHS.ROOT,
};
