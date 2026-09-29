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
  UIInput,
  UIInputTextArea,
  UIModal,
  UIPopconfirm,
  UISpin,
  UITag,
  UIText,
} from '@kb-labs/studio-ui-kit';
import { useDataSources } from '@/providers/data-sources-provider';
import { useProjects, useRemoveProject, useUpdateProject } from '@kb-labs/studio-data-client';
import type { ProjectEntry, ProjectRuntimeState } from '@kb-labs/core-contracts';
import { AddProjectModal } from '../components/add-project-modal';
import { useActiveProject } from '@/providers/active-project-provider';

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
  const updateProject = useUpdateProject(projectsSource);
  const { activeProjectId, setActiveProjectId } = useActiveProject();
  const [addOpen, setAddOpen] = React.useState(false);
  const [editProject, setEditProject] = React.useState<ProjectEntry | null>(null);

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

  const handleUpdate = React.useCallback(async (project: ProjectEntry, path: string) => {
    try {
      await updateProject.mutateAsync({ id: project.id, path });
      UIMessage.success(`Project path updated: ${path}`);
    } catch (error) {
      UIMessage.error(error instanceof Error ? error.message : 'Failed to update project path');
    }
  }, [updateProject]);

  return (
    <UIPage>
      <UIPageHeader
        title="Projects"
        description="Manage project details, paths, and the project currently used across Studio."
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {projects.map((project) => (
            <article key={project.id} aria-label={`${project.title} project`} style={{ border: '1px solid var(--kb-border-color, #303030)', borderRadius: 8, padding: 20, display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 18 }}>{project.title}</h2>
                  <UIText color="secondary">{project.name}</UIText>
                </div>
                <RuntimeStatus project={project} />
              </div>
              <UIText color="secondary">{project.description || 'No description'}</UIText>
              <code style={{ overflowWrap: 'anywhere' }}>{project.path}</code>
              {!project.pathExists && <UITag variant="error">Folder unavailable</UITag>}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <UIButton variant={activeProjectId === project.id ? 'primary' : 'default'} onClick={() => setActiveProjectId(project.id)}>
                  {activeProjectId === project.id ? 'Active project' : 'Open in Studio'}
                </UIButton>
                <UIButton onClick={() => setEditProject(project)}>{project.pathExists ? 'Edit' : 'Update path'}</UIButton>
                <UIPopconfirm
                  title="Unregister this project?"
                  description="Files and runtime state are kept; only the registry entry is removed."
                  onConfirm={() => handleRemove(project)}
                  okText="Unregister"
                  okButtonProps={{ danger: true }}
                >
                  <UIButton variant="text" danger>Remove</UIButton>
                </UIPopconfirm>
              </div>
            </article>
          ))}
        </div>
      )}
      <AddProjectModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => {
          setAddOpen(false);
          void refetch();
        }}
      />
      {editProject && (
        <EditProjectModal
          project={editProject}
          pickFolder={() => projectsSource.pickFolder()}
          onClose={() => setEditProject(null)}
          onSave={async (changes) => {
            await updateProject.mutateAsync({ id: editProject.id, ...changes });
            setEditProject(null);
          }}
        />
      )}
    </UIPage>
  );
}

function EditProjectModal({ project, pickFolder, onClose, onSave }: {
  project: ProjectEntry;
  pickFolder: () => Promise<string | null>;
  onClose: () => void;
  onSave: (changes: { title: string; description: string; path: string }) => Promise<void>;
}) {
  const [title, setTitle] = React.useState(project.title);
  const [description, setDescription] = React.useState(project.description);
  const [path, setPath] = React.useState(project.path);
  const [saving, setSaving] = React.useState(false);
  const [choosingFolder, setChoosingFolder] = React.useState(false);
  return (
    <>
    <UIModal open title="Project settings" okText="Save" onCancel={onClose} confirmLoading={saving || choosingFolder} onOk={() => {
      setSaving(true);
      void onSave({ title, description, path }).catch((error) => UIMessage.error(error instanceof Error ? error.message : 'Failed to update project')).finally(() => setSaving(false));
    }}>
      <label style={{ display: 'grid', gap: 6, marginBottom: 16 }}>Title<UIInput value={title} onChange={setTitle} /></label>
      <label style={{ display: 'grid', gap: 6, marginBottom: 16 }}>Description<UIInputTextArea value={description} rows={3} onChange={(event) => setDescription(event.target.value)} /></label>
      <label style={{ display: 'grid', gap: 6 }}>Project folder path<UIInput value={path} onChange={setPath} /></label>
      <UIButton style={{ marginTop: 8 }} disabled={choosingFolder} onClick={() => {
        setChoosingFolder(true);
        void pickFolder().then((selected) => { if (selected) setPath(selected); })
          .catch((error: unknown) => UIMessage.error(error instanceof Error ? error.message : 'Could not open the native folder chooser'))
          .finally(() => setChoosingFolder(false));
      }}>Choose project folder</UIButton>
    </UIModal>
    </>
  );
}
