/**
 * @module @kb-labs/studio-app/modules/plugins/routes
 * Plugins module routing configuration
 */

import { Navigate, type RouteObject } from 'react-router-dom';
import { PluginsPage } from '../pages/marketplace-page';
import { PluginDetailPage } from '../pages/plugin-detail-page';
import { MarketplaceCatalogPage } from '../pages/marketplace-catalog-page';
import { ErrorBoundary } from '../../../components/error-boundary';
import { renderIcon } from '../../../routes/helpers';
import type { NavigationItem } from '@/components/ui';

// Route paths
const PATHS = {
  ROOT: '/marketplace',
  DETAIL: '/marketplace/:pluginId',
  DETAIL_TAB: '/marketplace/:pluginId/:tab',
} as const;

// Route keys
const KEYS = {
  MODULE: 'plugins',
} as const;

/**
 * Plugins routes
 */
export const pluginsRoutes: RouteObject[] = [
  {
    path: PATHS.ROOT,
    element: <PluginsPage />,
    errorElement: <ErrorBoundary />,
  },
  {
    path: '/marketplace/catalog',
    element: <MarketplaceCatalogPage />,
    errorElement: <ErrorBoundary />,
  },
  {
    path: '/marketplace/catalog/:handle/:name',
    element: <MarketplaceCatalogPage />,
    errorElement: <ErrorBoundary />,
  },
  {
    path: '/plugins',
    element: <Navigate to="/marketplace?tab=installed" replace />,
  },
  {
    path: PATHS.DETAIL,
    element: <PluginDetailPage />,
    errorElement: <ErrorBoundary />,
  },
  {
    path: PATHS.DETAIL_TAB,
    element: <PluginDetailPage />,
    errorElement: <ErrorBoundary />,
  },
];

/**
 * Plugins navigation item for sidebar
 */
export const pluginsNavigation: NavigationItem = {
  key: KEYS.MODULE,
  label: 'Marketplace',
  icon: renderIcon('AppstoreOutlined'),
  path: PATHS.ROOT,
};
