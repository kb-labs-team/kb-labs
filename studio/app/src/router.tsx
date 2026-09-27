import * as React from 'react';
import { createBrowserRouter, Outlet, useLocation, useNavigate } from 'react-router-dom';
// Use real auth provider (ADR-0020); old providers/auth-provider kept for migration.
import { useAuth } from './auth/auth-provider';
import { RequireAuth } from './auth/guards';
import { useRegistryV2 } from './providers/registry-v2-provider';
import { CommandPaletteProvider, useCommandPalette } from './providers/command-palette-provider';
import { useNotifications } from '@kb-labs/studio-data-client';
import { useDataSources } from './providers/data-sources-provider';
import { HealthBanner } from './components/health-banner';
import { NotFoundPage } from './pages/not-found-page';
import { LoginPage } from './pages/login-page';
import { ActivatePage } from './pages/activate-page';
import { SessionsPage } from './pages/sessions-page';
import { ChangePasswordPage } from './pages/change-password-page';
import { AdminUsersPage } from './pages/admin-users-page';
import { AdminInvitesPage } from './pages/admin-invites-page';
import { PluginPageV2 } from './routes/plugin-page-v2';
import { PageTransition } from './components/page-transition';
import { createStudioLogger } from './utils/logger';
import { ErrorBoundary } from './components/error-boundary';
import { useSettings } from './providers/settings-provider';
import type { StudioRegistryV2 } from '@kb-labs/studio-federation';
import { NavigationItemsProvider } from './providers/navigation-items-provider';
import { applyNavigationCategories } from './utils/apply-navigation-categories';
import { AVAILABLE_ICONS, KBPageLayout, KBStatusBar, type NavigationItem, StatusBarItem, StatusBarPresets } from '@/components/ui';

// Module routes
import { dashboardRoutes, dashboardNavigation } from './modules/dashboard/routes';
// Workflow routes removed — now served via Module Federation from @kb-labs/workflow-cli studio plugin
import { projectsRoutes, projectsNavigation } from './modules/projects/routes';
import { pluginsRoutes, pluginsNavigation } from './modules/plugins/routes';
import { projectPluginsRoutes, projectPluginsNavigation } from './modules/project-plugins/routes';
import { projectAdaptersRoutes, projectAdaptersNavigation } from './modules/project-adapters/routes';
import { analyticsRoutes, analyticsNavigation } from './modules/analytics/routes';
import { observabilityRoutes, observabilityNavigation } from './modules/observability/routes';
import { settingsRoutes, settingsNavigation } from './modules/settings/routes';
// authRoutes removed — the old fake role-select login was replaced by the real LoginPage above.

type PluginNavRoute = {
  key: string;
  label: string;
  path: string;
  icon?: string;
  order?: number;
};

type PluginNavModel = {
  pluginId: string;
  displayName: string;
  icon?: string;
  routes: PluginNavRoute[];
};

// Helper function to render icon from available icons registry
function renderPluginIcon(iconName?: string): React.ReactElement | undefined {
  if (!iconName) {return undefined;}

  const IconComponent = AVAILABLE_ICONS[iconName];

  if (!IconComponent) {
    console.warn(`Icon "${iconName}" not available in registry`);
    return undefined;
  }

  return React.createElement(IconComponent, { style: { fontSize: 16 } });
}

// System module navigation items (order matters)
const systemNavigation: NavigationItem[] = [
  dashboardNavigation,
  projectsNavigation,
  projectPluginsNavigation,
  projectAdaptersNavigation,
  pluginsNavigation,
  analyticsNavigation,
  observabilityNavigation,
];

function LayoutContent() {
  const logger = React.useMemo(() => createStudioLogger('router'), []);

  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { registry, error } = useRegistryV2();
  const sources = useDataSources();
  const { settings } = useSettings();
  const commandPalette = useCommandPalette();

  // Notifications hook
  const {
    notifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    clearAll,
    clearNotification,
  } = useNotifications(sources.observability);

  const handleLogout = React.useCallback(async () => {
    logger.info('User logout initiated');
    await auth.logout();
    navigate('/login');
  }, [auth, logger, navigate]);

  const hasData = registry.plugins.length > 0;

  // Build plugin nav from V2 registry menus
  const pluginNavModel = React.useMemo<PluginNavModel[]>(() => {
    if (!hasData) {return [];}
    return buildPluginNavModel(registry);
  }, [registry, hasData]);

  // Build flat navigation items (system modules + plugins + settings)
  const flatNavigationItems = React.useMemo<NavigationItem[]>(() => {
    const items: NavigationItem[] = [...systemNavigation];

    // Add plugin navigation items
    for (const model of pluginNavModel) {
      if (model.routes.length === 1) {
        // Single page plugin — flat nav item (no submenu)
        const route = model.routes[0]!;
        items.push({
          key: `plugin-${model.pluginId}`,
          label: model.displayName,
          icon: renderPluginIcon(model.icon),
          path: route.path,
        });
      } else if (model.routes.length > 1) {
        // Multi-page plugin — group with children
        items.push({
          key: `plugin-${model.pluginId}`,
          label: model.displayName,
          icon: renderPluginIcon(model.icon),
          children: model.routes.map(route => ({
            key: route.key,
            label: route.label,
            path: route.path,
            icon: renderPluginIcon(route.icon),
          })),
        });
      }
    }

    // Settings always at the bottom
    items.push(settingsNavigation);

    return items;
  }, [pluginNavModel]);

  // Available items for NavigationSettings UI (top-level items except settings)
  const availableNavItems = React.useMemo(
    () =>
      flatNavigationItems
        .filter(item => item.key !== 'settings')
        .map(item => ({ key: item.key, label: item.label })),
    [flatNavigationItems],
  );

  // Apply user's category configuration
  const allNavigationItems = React.useMemo<NavigationItem[]>(
    () => applyNavigationCategories(flatNavigationItems, settings.navigation.categories),
    [flatNavigationItems, settings.navigation.categories],
  );

  React.useEffect(() => {
    if (error) {
      logger.error('Registry load failure in router', error);
    }
  }, [error, logger]);

  return (
    <NavigationItemsProvider items={availableNavItems}>
      <KBPageLayout
        sidebarProps={{
          items: allNavigationItems,
          width: 240,
          collapsedWidth: 80,
          currentPath: location.pathname,
          onNavigate: (path) => navigate(path),
          onLogout: () => { void handleLogout(); },
          userName: auth.status === 'authenticated' ? auth.user.email : '',
          onOpenSearch: commandPalette.open,
          notifications,
          unreadNotificationsCount: unreadCount,
          onMarkNotificationAsRead: markAsRead,
          onMarkAllNotificationsAsRead: markAllAsRead,
          onClearAllNotifications: clearAll,
          onClearNotification: clearNotification,
          onNotificationClick: (notification) => {
            navigate(`/observability/logs/${notification.id}`);
          },
        }}
        statusBar={
          <KBStatusBar
            leftItems={
              <>
                <StatusBarPresets.ApiConnection
                  connected={hasData}
                  onClick={() => navigate('/observability/system-events')}
                />
                {hasData && (
                  <StatusBarItem
                    label={`${registry.plugins.length} extension${registry.plugins.length === 1 ? '' : 's'}`}
                    tooltip={`${registry.plugins.length} extensions registered`}
                    status="success"
                    onClick={() => navigate('/settings')}
                    clickable
                  />
                )}
              </>
            }
            rightItems={
              <>
                <StatusBarPresets.User email={auth.status === 'authenticated' ? auth.user.email : ''} onClick={() => navigate('/settings')} />
                <StatusBarPresets.Version version="0.1.0" />
                <StatusBarPresets.Help onClick={() => window.open('https://github.com/kb-labs', '_blank')} />
              </>
            }
          />
        }
      >
        <HealthBanner />
        <PageTransition>
          <div style={{ paddingBottom: '20px' }}>
            <Outlet />
          </div>
        </PageTransition>
      </KBPageLayout>
    </NavigationItemsProvider>
  );
}

function Layout() {
  return (
    <CommandPaletteProvider>
      <LayoutContent />
    </CommandPaletteProvider>
  );
}

export const router = createBrowserRouter([
  // Public routes (no auth required)
  {
    path: '/login',
    element: <LoginPage />,
    errorElement: <ErrorBoundary />,
  },
  {
    path: '/activate/:token',
    element: <ActivatePage />,
    errorElement: <ErrorBoundary />,
  },
  // Protected routes (RequireAuth gate before Layout renders)
  {
    element: <RequireAuth><Layout /></RequireAuth>,
    errorElement: <ErrorBoundary />,
    children: [
      ...dashboardRoutes,
      ...projectsRoutes,
      ...projectPluginsRoutes,
      ...projectAdaptersRoutes,
      ...pluginsRoutes,
      ...analyticsRoutes,
      ...observabilityRoutes,
      ...settingsRoutes,
      // Account pages
      {
        path: '/account/sessions',
        element: <SessionsPage />,
        errorElement: <ErrorBoundary />,
      },
      {
        path: '/account/password',
        element: <ChangePasswordPage />,
        errorElement: <ErrorBoundary />,
      },
      // Admin pages (permission checks are inside the components)
      {
        path: '/admin/users',
        element: <AdminUsersPage />,
        errorElement: <ErrorBoundary />,
      },
      {
        path: '/admin/invites',
        element: <AdminInvitesPage />,
        errorElement: <ErrorBoundary />,
      },
      {
        // V2 plugin pages (Module Federation remotes) — inside layout
        path: '/p/*',
        element: <PluginPageV2 />,
        errorElement: <ErrorBoundary />,
      },
      {
        path: '*',
        element: <NotFoundPage />,
      },
    ],
  },
]);

function buildPluginNavModel(registry: StudioRegistryV2): PluginNavModel[] {
  const groups = new Map<string, PluginNavModel>();

  for (const plugin of registry.plugins) {
    if (!plugin.menus || plugin.menus.length === 0) {continue;}

    const parentMenu = plugin.menus.find(m => !m.parentId);

    if (!groups.has(plugin.pluginId)) {
      groups.set(plugin.pluginId, {
        pluginId: plugin.pluginId,
        displayName: parentMenu?.label ?? plugin.displayName ?? plugin.pluginId,
        icon: parentMenu?.icon,
        routes: [],
      });
    }

    const group = groups.get(plugin.pluginId)!;

    for (const menu of plugin.menus) {
      const targetPage = plugin.pages.find(p => p.id === menu.target);
      const path = targetPage?.route ?? `/p/${menu.target}`;

      group.routes.push({
        key: menu.id,
        label: menu.label,
        path,
        icon: menu.icon,
        order: menu.order,
      });
    }
  }

  for (const group of groups.values()) {
    group.routes.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  }

  return Array.from(groups.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
}
