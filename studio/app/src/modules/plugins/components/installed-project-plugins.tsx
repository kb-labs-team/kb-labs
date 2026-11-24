import * as React from 'react';
import {
  UIEmptyState,
  UIButton,
  UIMessage,
  UISpin,
  UISwitch,
  UITable,
  UITag,
  type UITableColumn,
} from '@kb-labs/studio-ui-kit';
import { useDataSources } from '@/providers/data-sources-provider';
import {
  useProjectPlugins,
  useSetProjectPluginEnabled,
  useUninstallProjectPlugin,
} from '@kb-labs/studio-data-client';
import type { ProjectPluginEntry } from '@kb-labs/studio-data-client';
import { useProjectContext } from '@/providers/project-context-provider';
import { EmptyState } from '@/components/empty-state';

export function InstalledProjectPlugins() {
  const { projectId } = useProjectContext();
  const { projectPlugins: source } = useDataSources();
  const { data: plugins, isLoading, isError, refetch } = useProjectPlugins(source, projectId);
  const setEnabled = useSetProjectPluginEnabled(source, projectId);
  const uninstallPlugin = useUninstallProjectPlugin(source, projectId);

  const handleToggle = React.useCallback(
    async (plugin: ProjectPluginEntry, enabled: boolean) => {
      try {
        await setEnabled.mutateAsync({ packageId: plugin.id, enabled });
        UIMessage.success(`${enabled ? 'Enabled' : 'Disabled'} ${plugin.id}`);
      } catch (error) {
        UIMessage.error(error instanceof Error ? error.message : 'Failed to update the plugin');
      }
    },
    [setEnabled],
  );

  const handleUninstall = React.useCallback(async (packageId: string) => {
    try {
      await uninstallPlugin.mutateAsync(packageId);
      UIMessage.success(`Uninstalled ${packageId} from this project`);
    } catch (error) {
      UIMessage.error(error instanceof Error ? error.message : 'Failed to uninstall the plugin');
    }
  }, [uninstallPlugin]);

  const columns: UITableColumn<ProjectPluginEntry>[] = [
    {
      key: 'id',
      title: 'Plugin',
      dataIndex: 'id',
      render: (_value, plugin) => (
        <div>
          <div>{plugin.id}</div>
          <div style={{ opacity: 0.6, fontSize: 12 }}>{plugin.version}</div>
        </div>
      ),
    },
    {
      key: 'source',
      title: 'Source',
      dataIndex: 'source',
      render: (_value, plugin) => <UITag>{plugin.source}</UITag>,
    },
    {
      key: 'enabled',
      title: 'Enabled',
      width: 100,
      render: (_value, plugin) => (
        <UISwitch
          checked={plugin.enabled}
          loading={setEnabled.isPending}
          onChange={(checked) => handleToggle(plugin, checked)}
        />
      ),
    },
    {
      key: 'actions',
      title: '',
      width: 120,
      render: (_value, plugin) => (
        <UIButton variant="text" danger loading={uninstallPlugin.isPending} onClick={() => handleUninstall(plugin.id)}>
          Remove
        </UIButton>
      ),
    },
  ];

  return (
    <section aria-labelledby="installed-plugins-heading">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
        <div>
          <h2 id="installed-plugins-heading" style={{ margin: 0, fontSize: 20 }}>Plugins</h2>
          <p style={{ margin: '4px 0 0', opacity: 0.7 }}>Installed in the selected project.</p>
        </div>
      </div>
      {!projectId ? (
        <UIEmptyState title="Select a project" description="Choose a registered project to see and manage its installed plugins." />
      ) : isLoading ? (
        <UISpin />
      ) : isError ? (
        <EmptyState
          kind="unavailable"
          title="Plugins unavailable"
          description="Installed plugins for this project could not be loaded. Try again when the Gateway is available."
          action={{ label: 'Retry', onClick: () => { void refetch(); } }}
        />
      ) : !plugins || plugins.length === 0 ? (
        <UIEmptyState title="No plugins installed" description="Open the marketplace to find a package for this project." />
      ) : (
        <UITable<ProjectPluginEntry> columns={columns} dataSource={plugins} rowKey="id" pagination={false} />
      )}
    </section>
  );
}
