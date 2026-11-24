import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '../query-keys';
import type { ProjectPluginsDataSource } from '../sources/project-plugins-source';
import type { MarketplaceRegistryDataSource } from '../sources/marketplace-registry-source';

export function useProjectPlugins(source: ProjectPluginsDataSource, projectId: string | null) {
  return useQuery({
    queryKey: qk.projectPlugins.list(projectId ?? ''),
    enabled: Boolean(projectId),
    queryFn: () => source.listPlugins(projectId as string),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

export function useSetProjectPluginEnabled(source: ProjectPluginsDataSource, projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ packageId, enabled }: { packageId: string; enabled: boolean }) =>
      enabled ? source.enablePlugin(projectId as string, packageId) : source.disablePlugin(projectId as string, packageId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.projectPlugins.list(projectId ?? '') });
    },
  });
}

export function useInstallProjectPlugin(source: ProjectPluginsDataSource, projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (spec: string) => source.installPlugin(projectId as string, spec),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: qk.projectPlugins.list(projectId ?? '') }); },
  });
}

/** Install a Studio catalog plugin while forcing the trusted Registry source. */
export function useInstallRegistryProjectPlugin(source: MarketplaceRegistryDataSource, projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (spec: string) => {
      if (!projectId) throw new Error('Select a project before installing a plugin.');
      return source.installPlugin(projectId, spec);
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: qk.projectPlugins.list(projectId ?? '') }); },
  });
}

export function useUninstallProjectPlugin(source: ProjectPluginsDataSource, projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (packageId: string) => source.uninstallPlugin(projectId as string, packageId),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: qk.projectPlugins.list(projectId ?? '') }); },
  });
}
