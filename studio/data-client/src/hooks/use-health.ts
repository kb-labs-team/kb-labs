import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '../query-keys';
import type { HealthDataSource, RequestUpdateParams } from '../sources/health-source';

export function useHealth(source: HealthDataSource) {
  return useQuery({
    queryKey: qk.health.report(),
    queryFn: () => source.getHealth(),
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
}

export function useTriggerUpdate(source: HealthDataSource) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: RequestUpdateParams) => source.requestUpdate(params),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.health.all });
    },
  });
}
