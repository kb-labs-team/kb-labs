/**
 * @module @kb-labs/studio-app/modules/project-plugins/pages/project-plugins-page
 *
 * Per-project plugin enable/disable (stage 6, second slice). Studio only
 * calls the host's `/api/v1/plugins` API — it never touches
 * `.kb/marketplace.lock` itself.
 */

import * as React from 'react';
import {
  UIEmptyState,
  UIMessage,
  UIPage,
  UIPageHeader,
  UISpin,
  UISwitch,
  UITable,
  UITag,
  type UITableColumn,
} from '@kb-labs/studio-ui-kit';
import { useDataSources } from '@/providers/data-sources-provider';
import { useProjectPlugins, useSetProjectPluginEnabled } from '@kb-labs/studio-data-client';
import type { ProjectPluginEntry } from '@kb-labs/studio-data-client';
import { ProjectPicker } from '@/components/project-picker';

export function ProjectPluginsPage() {
  const [projectId, setProjectId] = React.useState<string | null>(null);
  const { projectPlugins: source } = useDataSources();
  const { data: plugins, isLoading } = useProjectPlugins(source, projectId);
  const setEnabled = useSetProjectPluginEnabled(source, projectId);

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
      key: 'scope',
      title: 'Scope',
      dataIndex: 'scope',
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
  ];

  return (
    <UIPage>
      <UIPageHeader
        title="Plugins"
        description="Enable or disable plugins for the selected project."
        actions={<ProjectPicker value={projectId} onChange={setProjectId} />}
      />
      {!projectId ? null : isLoading ? (
        <UISpin />
      ) : !plugins || plugins.length === 0 ? (
        <UIEmptyState
          title="No plugins found"
          description="This project has no plugins in its marketplace.lock yet."
        />
      ) : (
        <UITable<ProjectPluginEntry> columns={columns} dataSource={plugins} rowKey="id" pagination={false} />
      )}
    </UIPage>
  );
}
