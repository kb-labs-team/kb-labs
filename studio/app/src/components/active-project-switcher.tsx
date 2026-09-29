import * as React from 'react';
import { Tooltip } from 'antd';
import { FolderKanban } from 'lucide-react';
import { UISelect, UIText } from '@kb-labs/studio-ui-kit';
import { useActiveProject } from '@/providers/active-project-provider';
import { useNavigate } from 'react-router-dom';

export function ActiveProjectSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const navigate = useNavigate();
  const { projects, activeProjectId, setActiveProjectId, isLoading } = useActiveProject();
  const activeProject = projects?.find((project) => project.id === activeProjectId);

  if (collapsed) {
    return (
      <Tooltip title={activeProject ? `Active project: ${activeProject.title}` : 'No active project'} placement="right">
        <button
          type="button"
          aria-label={activeProject ? `Active project: ${activeProject.title}` : 'No active project'}
          onClick={() => navigate('/projects')}
          style={{ width: 40, height: 36, margin: '4px auto', border: 0, background: 'transparent', cursor: 'pointer' }}
        >
          <FolderKanban size={17} />
        </button>
      </Tooltip>
    );
  }

  if (!isLoading && (!projects || projects.length === 0)) {
    return (
      <button type="button" onClick={() => navigate('/projects')} style={{ width: '100%', textAlign: 'left' }}>
        <UIText color="secondary">No active project · Add one</UIText>
      </button>
    );
  }

  return (
    <div aria-label="Active project">
      <UIText size="xs" color="secondary" as="div" style={{ marginBottom: 4 }}>ACTIVE PROJECT</UIText>
      <UISelect
        aria-label="Active project"
        value={activeProjectId ?? undefined}
        loading={isLoading}
        placeholder="Select a project"
        showSearch
        optionFilterProp="label"
        style={{ width: '100%' }}
        options={(projects ?? []).map((project) => ({
          label: project.title,
          value: project.id,
          description: project.pathExists ? project.path : 'Folder unavailable',
        }))}
        onChange={(next) => setActiveProjectId(String(next))}
      />
    </div>
  );
}
