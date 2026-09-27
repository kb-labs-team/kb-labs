import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '../query-keys';
import type { ProjectAdaptersDataSource } from '../sources/project-adapters-source';

export function useProjectAdapters(source: ProjectAdaptersDataSource, projectId: string | null) {
  return useQuery({
    queryKey: qk.projectAdapters.list(projectId ?? ''),
    enabled: Boolean(projectId),
    queryFn: () => source.listAdapters(projectId as string),
    staleTime: 5_000,
  });
}

export function useConfigureProjectAdapter(source: ProjectAdaptersDataSource, projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, options }: { name: string; options: Record<string, unknown> }) =>
      source.configureAdapter(projectId as string, name, options),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.projectAdapters.list(projectId ?? '') });
    },
  });
}
