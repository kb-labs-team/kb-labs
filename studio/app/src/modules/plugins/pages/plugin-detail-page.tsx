import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  UISpin,
  UIButton,
  UITabs,
  type UITabItem,
  UIEmptyState,
  UIIcon,
  UIPage,
  UIPageHeader,
} from '@kb-labs/studio-ui-kit';
import { useDataSources } from '@/providers/data-sources-provider';
import type { PluginManifestEntry } from '@kb-labs/studio-data-client';
import { PluginAIAssistantModal } from '../components/plugin-ai-assistant-modal';
import { PluginStatusStrip } from '../components/plugin-detail/plugin-status-strip';
import { OverviewTab } from '../components/plugin-detail/overview-tab';
import { CapabilitiesTab } from '../components/plugin-detail/capabilities-tab';
import { PermissionsView } from '../components/plugin-detail/permissions-view';
import { ChangelogTab } from '../components/plugin-detail/changelog-tab';
import { RawManifestDrawer } from '../components/plugin-detail/raw-manifest-drawer';
import { useActiveProject } from '@/providers/active-project-provider';

export function PluginDetailPage() {
  const { pluginId: encodedPluginId } = useParams<{ pluginId: string }>();
  const navigate = useNavigate();
  const { plugins: pluginsSource } = useDataSources();
  const { activeProjectId, projects } = useActiveProject();
  const activeProject = projects?.find((project) => project.id === activeProjectId);
  const [loading, setLoading] = useState(true);
  const [plugin, setPlugin] = useState<PluginManifestEntry | null>(null);
  const [apiBasePath, setApiBasePath] = useState<string>('');
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [manifestDrawerOpen, setManifestDrawerOpen] = useState(false);

  // README state — loaded eagerly, Overview is the default tab
  const [readmeContent, setReadmeContent] = useState<string | null>(null);
  const [readmeLoading, setReadmeLoading] = useState(false);
  const [readmeError, setReadmeError] = useState<string | null>(null);
  const [readmeLoaded, setReadmeLoaded] = useState(false);

  // Changelog state
  const [changelogContent, setChangelogContent] = useState<string | null>(null);
  const [changelogLoading, setChangelogLoading] = useState(false);
  const [changelogError, setChangelogError] = useState<string | null>(null);
  const [changelogLoaded, setChangelogLoaded] = useState(false);
  const [hasChangelog, setHasChangelog] = useState<boolean | null>(null);

  const pluginId = encodedPluginId ? decodeURIComponent(encodedPluginId) : '';

  const loadPlugin = useCallback(async () => {
    try {
      setLoading(true);
      const result = await pluginsSource.getPlugins();
      const found = result.manifests.find((p) => p.pluginId === pluginId);
      setPlugin(found || null);
      setApiBasePath(result.apiBasePath || '');
    } catch (err) {
      console.error('Failed to load plugin:', err);
    } finally {
      setLoading(false);
    }
  }, [pluginId, pluginsSource]);

  useEffect(() => {
    loadPlugin();
  }, [loadPlugin]);

  // Probe for changelog on mount — determines whether to show the tab
  useEffect(() => {
    if (!plugin || changelogLoaded || changelogLoading) return;
    setChangelogLoading(true);
    pluginsSource.getPluginChangelog(plugin.pluginId)
      .then((content) => {
        setChangelogContent(content);
        setHasChangelog(content !== null);
      })
      .catch((err) => {
        console.error('Failed to load changelog:', err);
        setChangelogError(err instanceof Error ? err.message : 'Failed to load Changelog');
        setHasChangelog(false);
      })
      .finally(() => {
        setChangelogLoaded(true);
        setChangelogLoading(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin?.pluginId]);

  // Load README on mount alongside the changelog probe — Overview is the default tab
  useEffect(() => {
    if (!plugin || readmeLoaded || readmeLoading) return;
    setReadmeLoading(true);
    pluginsSource.getPluginReadme(plugin.pluginId)
      .then((content) => {
        setReadmeContent(content);
      })
      .catch((err) => {
        setReadmeError(err instanceof Error ? err.message : 'Failed to load README');
      })
      .finally(() => {
        setReadmeLoaded(true);
        setReadmeLoading(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin?.pluginId]);

  if (loading) {
    return (
      <UIPage>
        <div style={{ textAlign: 'center', padding: '80px 0' }}>
          <UISpin size="large" />
        </div>
      </UIPage>
    );
  }

  if (!plugin) {
    return (
      <UIPage>
        <UIPageHeader title="Plugin Not Found" />
        <UIEmptyState description="Plugin not found in registry" />
        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <UIButton variant="primary" onClick={() => navigate('/marketplace')}>
            Back to Plugins
          </UIButton>
        </div>
      </UIPage>
    );
  }

  const { manifest } = plugin;
  const display = manifest.display;

  const cliCommands = manifest.cli?.commands || [];
  const restRoutes = manifest.rest?.routes || [];
  const workflowHandlers = manifest.workflows?.handlers || [];
  const jobs = manifest.jobs?.handlers || [];
  const permissions = manifest.permissions;
  const hasCapabilities = cliCommands.length > 0 || restRoutes.length > 0 || workflowHandlers.length > 0 || jobs.length > 0;

  const tabItems: UITabItem[] = [
    {
      key: 'overview',
      label: 'Overview',
      children: (
        <OverviewTab
          plugin={plugin}
          readmeContent={readmeContent}
          readmeLoading={readmeLoading}
          readmeError={readmeError}
        />
      ),
    },
    ...(hasCapabilities ? [{
      key: 'capabilities',
      label: 'Capabilities',
      children: (
        <CapabilitiesTab
          cliCommands={cliCommands}
          restRoutes={restRoutes}
          workflowHandlers={workflowHandlers}
          jobs={jobs}
          restBasePath={manifest.rest?.basePath}
          apiBasePath={apiBasePath}
        />
      ),
    }] : []),
    ...(permissions ? [{
      key: 'permissions',
      label: 'Permissions',
      children: <PermissionsView permissions={permissions} />,
    }] : []),
    ...(hasChangelog ? [{
      key: 'changelog',
      label: 'Changelog',
      children: (
        <ChangelogTab
          content={changelogContent}
          loading={changelogLoading}
          error={changelogError}
        />
      ),
    }] : []),
  ];

  const handleAskAI = async (question: string) => {
    if (!pluginId) {
      throw new Error('Plugin ID is required');
    }
    return pluginsSource.askAboutPlugin(pluginId, { question });
  };

  return (
    <UIPage>
      <UIPageHeader
        title={display?.name || manifest.id}
        description={display?.description}
        icon={display?.icon}
        breadcrumbs={[
          { title: 'Home', href: '/' },
          { title: 'Marketplace', href: '/marketplace' },
          { title: display?.name || manifest.id },
        ]}
        actions={
          <>
            <UIButton
              icon={<UIIcon name="CodeOutlined" />}
              onClick={() => setManifestDrawerOpen(true)}
              variant="text"
            >
              View Raw JSON
            </UIButton>
            <UIButton
              icon={<UIIcon name="QuestionCircleOutlined" />}
              onClick={() => setAiModalOpen(true)}
              variant="primary"
            >
              AI Assistant
            </UIButton>
            <UIButton variant="default" disabled={!activeProjectId} onClick={() => navigate('/plugins')}>
              {activeProject ? `Manage in ${activeProject.title}` : 'Select a project'}
            </UIButton>
          </>
        }
        tabs={
          <UITabs
            items={tabItems}
            syncUrl={{ mode: 'path', basePath: `/marketplace/${encodeURIComponent(pluginId)}` }}
          />
        }
      >
        <PluginStatusStrip plugin={plugin} />
      </UIPageHeader>

      <RawManifestDrawer
        open={manifestDrawerOpen}
        onClose={() => setManifestDrawerOpen(false)}
        pluginRoot={plugin.pluginRoot}
        manifest={manifest}
      />

      <PluginAIAssistantModal
        open={aiModalOpen}
        onClose={() => setAiModalOpen(false)}
        pluginId={pluginId}
        pluginName={display?.name || manifest.id}
        onAsk={handleAskAI}
      />
    </UIPage>
  );
}
