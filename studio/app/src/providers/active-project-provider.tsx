import * as React from 'react';
import { useProjects } from '@kb-labs/studio-data-client';
import { useDataSources } from './data-sources-provider';

interface ActiveProjectContextValue {
  projects: ReturnType<typeof useProjects>['data'];
  activeProjectId: string | null;
  setActiveProjectId: (projectId: string) => void;
  isLoading: boolean;
}

const ActiveProjectContext = React.createContext<ActiveProjectContextValue | null>(null);
const STORAGE_KEY = 'kb-studio-active-project-id';

function readSavedProjectId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function ActiveProjectProvider({ children }: { children: React.ReactNode }) {
  const { projects: source } = useDataSources();
  const { data: projects, isLoading, isSuccess } = useProjects(source);
  const [activeProjectId, setActiveProjectIdState] = React.useState<string | null>(readSavedProjectId);

  const setActiveProjectId = React.useCallback((projectId: string) => {
    setActiveProjectIdState(projectId);
    try {
      window.localStorage.setItem(STORAGE_KEY, projectId);
    } catch {
      // Project switching remains usable when browser storage is unavailable.
    }
  }, []);

  React.useEffect(() => {
    if (!isSuccess || !projects) {
      return;
    }
    if (projects.some((project) => project.id === activeProjectId)) {
      return;
    }
    const nextId = projects[0]?.id ?? null;
    setActiveProjectIdState(nextId);
    try {
      if (nextId) {
        window.localStorage.setItem(STORAGE_KEY, nextId);
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Keep the in-memory selection authoritative for this Studio session.
    }
  }, [activeProjectId, isSuccess, projects]);

  const value = React.useMemo(
    () => ({ projects, activeProjectId, setActiveProjectId, isLoading }),
    [projects, activeProjectId, setActiveProjectId, isLoading],
  );

  return <ActiveProjectContext.Provider value={value}>{children}</ActiveProjectContext.Provider>;
}

export function useActiveProject(): ActiveProjectContextValue {
  const context = React.useContext(ActiveProjectContext);
  if (!context) {
    throw new Error('useActiveProject must be used within ActiveProjectProvider');
  }
  return context;
}
