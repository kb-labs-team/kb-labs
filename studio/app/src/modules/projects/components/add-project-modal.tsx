/** Project creation and connection dialog. All filesystem work goes through Host REST operations. */

import * as React from 'react';
import { UIButton, UIInput, UIInputTextArea, UIMessage, UIModal, UIText } from '@kb-labs/studio-ui-kit';
import { KBError, useAddProject, useCreateProject } from '@kb-labs/studio-data-client';
import { useDataSources } from '@/providers/data-sources-provider';
import { useActiveProject } from '@/providers/active-project-provider';
import { ProjectDirectoryPicker } from './project-directory-picker';

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof KBError)) return undefined;
  const data = (error.cause as { data?: unknown } | undefined)?.data;
  if (data && typeof data === 'object' && 'error' in data) {
    const inner = (data as { error?: unknown }).error;
    if (inner && typeof inner === 'object' && 'code' in inner) return String((inner as { code: unknown }).code);
  }
  return undefined;
}

type ProjectMode = 'create' | 'connect';

export interface AddProjectModalProps {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}

export function AddProjectModal({ open, onClose, onAdded }: AddProjectModalProps) {
  const { projects: source } = useDataSources();
  const { setActiveProjectId } = useActiveProject();
  const addProject = useAddProject(source);
  const createProject = useCreateProject(source);
  const [mode, setMode] = React.useState<ProjectMode>('create');
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [path, setPath] = React.useState('');
  const [directoryName, setDirectoryName] = React.useState('');
  const [needsInit, setNeedsInit] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = React.useState(false);
  const busy = pending || addProject.isPending || createProject.isPending;

  const reset = React.useCallback(() => {
    setTitle(''); setDescription(''); setPath(''); setDirectoryName(''); setNeedsInit(false); setMode('create'); setFolderPickerOpen(false);
  }, []);
  const close = React.useCallback(() => { reset(); onClose(); }, [onClose, reset]);

  const submit = React.useCallback(async (initialize: boolean) => {
    if (!title.trim()) { UIMessage.error('Enter a project title'); return; }
    setPending(true);
    try {
      const project = mode === 'create'
        ? await createProject.mutateAsync({ parentPath: path, directoryName, title: title.trim(), description })
        : await addProject.mutateAsync({ path, title: title.trim(), description, init: initialize });
      setActiveProjectId(project.id);
      UIMessage.success(`Project “${project.title}” is ready`);
      reset();
      onAdded();
    } catch (error) {
      if (mode === 'connect' && !initialize && errorCode(error) === 'KB_PROJECT_INIT_REQUIRED') {
        setNeedsInit(true);
        return;
      }
      UIMessage.error(error instanceof Error ? error.message : 'Failed to save the project');
    } finally {
      setPending(false);
    }
  }, [addProject, createProject, description, directoryName, mode, onAdded, path, reset, setActiveProjectId, title]);

  const canSubmit = mode === 'create' ? path.trim() && directoryName.trim() : path.trim();
  return (
    <>
    <UIModal
      open={open && !folderPickerOpen}
      title={needsInit ? 'Initialize project?' : mode === 'create' ? 'Create project' : 'Connect existing project'}
      onCancel={needsInit ? () => setNeedsInit(false) : close}
      confirmLoading={busy}
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <UIButton onClick={needsInit ? () => setNeedsInit(false) : close}>Cancel</UIButton>
          <UIButton variant="primary" disabled={!canSubmit || busy} loading={busy} onClick={() => { if (canSubmit) void submit(needsInit); }}>
            {needsInit ? 'Initialize and connect' : mode === 'create' ? 'Create project' : 'Connect project'}
          </UIButton>
        </div>
      )}
    >
      {needsInit ? (
        <UIText>{path} has no .kb/ configuration. Initialize it and connect this folder?</UIText>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <UIButton variant={mode === 'create' ? 'primary' : 'default'} onClick={() => setMode('create')}>Create new</UIButton>
            <UIButton variant={mode === 'connect' ? 'primary' : 'default'} onClick={() => setMode('connect')}>Connect existing</UIButton>
          </div>
          <label style={{ display: 'grid', gap: 6 }}>Project title<UIInput value={title} onChange={setTitle} placeholder="My project" autoFocus /></label>
          <label style={{ display: 'grid', gap: 6 }}>Description<UIInputTextArea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="What is this project for?" /></label>
          {mode === 'create' ? (
            <>
              <label style={{ display: 'grid', gap: 6 }}>Parent folder<UIInput value={path} onChange={setPath} placeholder="/path/to/parent-folder" /></label>
              <UIButton onClick={() => setFolderPickerOpen(true)}>Choose parent folder</UIButton>
              <label style={{ display: 'grid', gap: 6 }}>New folder name<UIInput value={directoryName} onChange={setDirectoryName} placeholder="project-folder" /></label>
            </>
          ) : (
            <>
              <label style={{ display: 'grid', gap: 6 }}>Project folder<UIInput value={path} onChange={setPath} placeholder="/path/to/project-folder" /></label>
              <UIButton onClick={() => setFolderPickerOpen(true)}>Choose project folder</UIButton>
            </>
          )}
        </div>
      )}
    </UIModal>
    <ProjectDirectoryPicker
      open={open && folderPickerOpen}
      title={mode === 'create' ? 'Choose parent folder' : 'Choose project folder'}
      onCancel={() => setFolderPickerOpen(false)}
      onSelect={(selectedPath) => {
        setPath(selectedPath);
        setFolderPickerOpen(false);
      }}
    />
    </>
  );
}
