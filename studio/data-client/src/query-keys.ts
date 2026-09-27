/**
 * @module @kb-labs/studio-data-client/query-keys
 * Query keys factory for TanStack Query
 */

import type { WorkflowRunsFilters } from './sources/workflow-source';

/**
 * Standardized query keys factory
 */
export const qk = {
  // Audit queries
  audit: {
    all: ['audit'] as const,
    summary: () => [...qk.audit.all, 'summary'] as const,
    runs: {
      all: () => [...qk.audit.all, 'runs'] as const,
      list: (params?: { cursor?: string; limit?: number; status?: string }) => 
        [...qk.audit.runs.all(), 'list', params] as const,
      byId: (runId: string) => [...qk.audit.runs.all(), 'detail', runId] as const,
    },
    report: {
      latest: () => [...qk.audit.all, 'report', 'latest'] as const,
      byRunId: (runId: string) => [...qk.audit.all, 'report', runId] as const,
    },
    pkg: (name: string) => [...qk.audit.all, 'pkg', name] as const,
  },
  
  // Release queries
  release: {
    all: ['release'] as const,
    preview: (params?: { from?: string; to?: string }) => 
      [...qk.release.all, 'preview', params] as const,
    runs: {
      all: () => [...qk.release.all, 'runs'] as const,
      byId: (runId: string) => [...qk.release.runs.all(), 'detail', runId] as const,
    },
    changelog: (params?: { format?: string }) => 
      [...qk.release.all, 'changelog', params] as const,
  },
  
  // Jobs queries
  jobs: {
    all: ['jobs'] as const,
    byId: (jobId: string) => [...qk.jobs.all, 'detail', jobId] as const,
    logs: {
      byJobId: (jobId: string, offset?: number) => 
        [...qk.jobs.all, 'logs', jobId, offset] as const,
      stream: (jobId: string) => [...qk.jobs.all, 'logs', 'stream', jobId] as const,
    },
    events: (jobId: string) => [...qk.jobs.all, 'events', jobId] as const,
    list: (params?: { cursor?: string; limit?: number; status?: string; kind?: string }) => 
      [...qk.jobs.all, 'list', params] as const,
  },
  
  // System queries
  system: {
    all: ['system'] as const,
    health: {
      live: () => [...qk.system.all, 'health', 'live'] as const,
      ready: () => [...qk.system.all, 'health', 'ready'] as const,
    },
    platformHealth: () => [...qk.system.all, 'platform-health'] as const,
    info: () => [...qk.system.all, 'info'] as const,
    capabilities: () => [...qk.system.all, 'capabilities'] as const,
    config: () => [...qk.system.all, 'config'] as const,
  },

  // Plugins queries
  plugins: {
    all: ['plugins'] as const,
    registry: () => [...qk.plugins.all, 'registry'] as const,
  },

  // Projects queries (stage 6: host project registry)
  projects: {
    all: ['projects'] as const,
    list: () => [...qk.projects.all, 'list'] as const,
    byId: (id: string) => [...qk.projects.all, 'detail', id] as const,
  },

  // Per-project plugin enable/disable (stage 6, second slice).
  projectPlugins: {
    all: ['projectPlugins'] as const,
    list: (projectId: string) => [...qk.projectPlugins.all, projectId] as const,
  },

  // Per-project adapter configuration (stage 6, second slice).
  projectAdapters: {
    all: ['projectAdapters'] as const,
    list: (projectId: string) => [...qk.projectAdapters.all, projectId] as const,
  },
  workflows: {
    all: ['workflows'] as const,
    list: (filters?: WorkflowRunsFilters) => [...qk.workflows.all, 'list', filters ?? {}] as const,
    run: (runId: string) => [...qk.workflows.all, 'run', runId] as const,
  },
  
  // DevLink queries
  devlink: {
    all: ['devlink'] as const,
    summary: () => [...qk.devlink.all, 'summary'] as const,
    graph: () => [...qk.devlink.all, 'graph'] as const,
  },
  
  // Mind queries
  mind: {
    all: ['mind'] as const,
    summary: () => [...qk.mind.all, 'summary'] as const,
  },
  
  // Analytics queries
  analytics: {
    all: ['analytics'] as const,
    summary: (params?: { start?: string; end?: string }) =>
      [...qk.analytics.all, 'summary', params] as const,
  },

  // Platform queries
  platform: {
    all: ['platform'] as const,
    config: () => [...qk.platform.all, 'config'] as const,
  },
} as const;

// Backward compatibility
export const queryKeys = qk;

