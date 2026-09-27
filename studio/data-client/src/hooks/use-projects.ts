import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '../query-keys';
import type { AddProjectParams, ProjectsDataSource } from '../sources/projects-source';

export function useProjects(source: ProjectsDataSource) {
  return useQuery({
    queryKey: qk.projects.list(),
    queryFn: () => source.listProjects(),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

export function useProject(source: ProjectsDataSource, id: string | null) {
  return useQuery({
    queryKey: qk.projects.byId(id ?? ''),
    enabled: Boolean(id),
    queryFn: () => source.getProject(id as string),
  });
}

export function useAddProject(source: ProjectsDataSource) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: AddProjectParams) => source.addProject(params),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.projects.all });
    },
  });
}

export function useRemoveProject(source: ProjectsDataSource) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => source.removeProject(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.projects.all });
    },
  });
}
