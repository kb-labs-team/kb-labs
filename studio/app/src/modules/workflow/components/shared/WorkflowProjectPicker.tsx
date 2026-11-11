import { useState } from 'react';
import { useData } from '@kb-labs/studio-hooks';
import type { ProjectEntry } from '@kb-labs/core-contracts';

export function useWorkflowProject() {
  const { data: projects = [] } = useData<ProjectEntry[]>('/v1/projects');
  const [selectedId, setSelectedId] = useState(() => window.localStorage.getItem('kb.workflow.projectId') ?? '');
  const projectId = projects.some((project) => project.id === selectedId)
    ? selectedId
    : projects[0]?.id ?? '';
  const picker = (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span>Project</span>
      <select
        aria-label="Workflow project"
        value={projectId}
        onChange={(event) => {
          const next = event.currentTarget.value;
          window.localStorage.setItem('kb.workflow.projectId', next);
          setSelectedId(next);
        }}
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>{project.name}</option>
        ))}
      </select>
    </label>
  );
  return { projectId, picker, hasProjects: projects.length > 0 };
}
