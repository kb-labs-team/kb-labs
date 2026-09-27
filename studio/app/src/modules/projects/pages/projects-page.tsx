/**
 * @module @kb-labs/studio-app/modules/projects/pages/projects-page
 *
 * Projects list (stage 6, first slice: "add project -> see it"). Studio only
 * calls the host's `/api/v1/projects` API — it never reads files or spawns
 * processes itself.
 */

import * as React from 'react';
import {
  UIButton,
  UIEmptyState,
  UIIcon,
  UIMessage,
  UIPage,
  UIPageHeader,
  UIPopconfirm,
  UISpin,
  UITable,
  UITag,
  type UITableColumn,
} from '@kb-labs/studio-ui-kit';
import { useDataSources } from '@/providers/data-sources-provider';
import { useProjects, useRemoveProject } from '@kb-labs/studio-data-client';
import type { ProjectEntry, ProjectRuntimeState } from '@kb-labs/core-contracts';
import { AddProjectModal } from '../components/add-project-modal';

const RUNTIME_TAG: Record<ProjectRuntimeState, { label: string; variant: 'success' | 'warning' | 'error' | 'info' | 'default' }> = {
  ready: { label: 'Running', variant: 'success' },
  starting: { label: 'Starting', variant: 'info' },
  restarting: { label: 'Restarting', variant: 'warning' },
  stopping: { label: 'Stopping', variant: 'warning' },
  stopped: { label: 'Stopped', variant: 'default' },
  failed: { label: 'Failed', variant: 'error' },
};

function RuntimeStatus({ project }: { project: ProjectEntry }) {
  const tag = RUNTIME_TAG[project.runtime.state];
  return <UITag variant={tag.variant}>{tag.label}</UITag>;
}

export function ProjectsPage() {
  const { projects: projectsSource } = useDataSources();
  const { data: projects, isLoading, refetch } = useProjects(projectsSource);
  const removeProject = useRemoveProject(projectsSource);
  const [addOpen, setAddOpen] = React.useState(false);

  const handleRemove = React.useCallback(
    async (project: ProjectEntry) => {
      try {
        await removeProject.mutateAsync(project.id);
        UIMessage.success(`Unregistered ${project.name}; files were not touched.`);
      } catch (error) {
        UIMessage.error(error instanceof Error ? error.message : 'Failed to remove the project');
      }
    },
    [removeProject],
  );

  const columns: UITableColumn<ProjectEntry>[] = [
    {
      key: 'name',
      title: 'Name',
      dataIndex: 'name',
      render: (_value, project) => (
        <div>
          <div>{project.name}</div>
          <div style={{ opacity: 0.6, fontSize: 12 }}>{project.path}</div>
        </div>
      ),
    },
    {
      key: 'runtime',
      title: 'Status',
      render: (_value, project) => <RuntimeStatus project={project} />,
    },
    {
      key: 'declaration',
      title: '.kb/',
      dataIndex: 'declaration',
      render: (_value, project) =>
        project.pathExists ? project.declaration : <UITag variant="error">Folder missing</UITag>,
    },
    {
      key: 'lastUsedAt',
      title: 'Last used',
      dataIndex: 'lastUsedAt',
      render: (_value, project) => (project.lastUsedAt ? new Date(project.lastUsedAt).toLocaleString() : 'never'),
    },
    {
      key: 'actions',
      title: '',
      width: 100,
      render: (_value, project) => (
        <UIPopconfirm
          title="Unregister this project?"
          description="Files and runtime state are kept; only the registry entry is removed."
          onConfirm={() => handleRemove(project)}
          okText="Unregister"
          okButtonProps={{ danger: true }}
        >
          <UIButton variant="text" danger>
            Remove
          </UIButton>
        </UIPopconfirm>
      ),
    },
  ];

  return (
    <UIPage>
      <UIPageHeader
        title="Projects"
        description="Projects registered with the platform. Add one to work on it in Studio."
        actions={
          <UIButton variant="primary" icon={<UIIcon name="PlusOutlined" />} onClick={() => setAddOpen(true)}>
            Add project
          </UIButton>
        }
      />
      {isLoading ? (
        <UISpin />
      ) : !projects || projects.length === 0 ? (
        <UIEmptyState
          title="No projects registered"
          description="Add a project folder to see it here."
          action={
            <UIButton variant="primary" onClick={() => setAddOpen(true)}>
              Add project
            </UIButton>
          }
        />
      ) : (
        <UITable<ProjectEntry> columns={columns} dataSource={projects} rowKey="id" pagination={false} />
      )}
      <AddProjectModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => {
          setAddOpen(false);
          void refetch();
        }}
      />
    </UIPage>
  );
}
