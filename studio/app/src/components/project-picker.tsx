/**
 * @module @kb-labs/studio-app/components/project-picker
 *
 * Small "which project" selector used by screens that operate per project
 * (Plugins, Adapters — stage 6, second slice) but have no dedicated route
 * param. Backed by the same `/api/v1/projects` list as the Projects screen.
 */

import * as React from 'react';
import { UISelect, UIText } from '@kb-labs/studio-ui-kit';
import { useDataSources } from '@/providers/data-sources-provider';
import { useProjects } from '@kb-labs/studio-data-client';

export interface ProjectPickerProps {
  value: string | null;
  onChange: (projectId: string) => void;
}

export function ProjectPicker({ value, onChange }: ProjectPickerProps) {
  const { projects: projectsSource } = useDataSources();
  const { data: projects, isLoading } = useProjects(projectsSource);

  React.useEffect(() => {
    if (!value && projects && projects.length > 0) {
      onChange(projects[0]!.id);
    }
  }, [value, projects, onChange]);

  if (!isLoading && (!projects || projects.length === 0)) {
    return <UIText color="secondary">No projects registered yet — add one on the Projects screen.</UIText>;
  }

  return (
    <UISelect
      value={value ?? undefined}
      loading={isLoading}
      placeholder="Select a project"
      style={{ minWidth: 260 }}
      options={(projects ?? []).map((project) => ({ label: project.name, value: project.id }))}
      onChange={(next) => onChange(String(next))}
    />
  );
}
