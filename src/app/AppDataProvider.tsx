import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  listIdeas,
  listProjects,
  subscribeToChanges,
  toNianBoxError,
} from '../services/storage';
import type { Idea } from '../types/idea';
import type { Project } from '../types/project';

export interface AppDataValue {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  /** 全部念头，包含回收站中的记录。 */
  ideas: Idea[];
  /** 全部项目，包含已删除的项目。 */
  projects: Project[];
  reload: () => Promise<void>;
}

const AppDataContext = createContext<AppDataValue | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AppDataValue['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const mounted = useRef(true);
  const loading = useRef(false);
  const pending = useRef(false);

  const load = useCallback(async () => {
    if (loading.current) {
      pending.current = true;
      return;
    }
    loading.current = true;
    try {
      const [nextIdeas, nextProjects] = await Promise.all([
        listIdeas({ includeDeleted: true, sort: 'updatedAt' }),
        listProjects(true),
      ]);
      if (!mounted.current) return;
      setIdeas(nextIdeas);
      setProjects(nextProjects);
      setError(null);
      setStatus('ready');
    } catch (caught) {
      if (!mounted.current) return;
      setError(toNianBoxError(caught).message);
      setStatus('error');
    } finally {
      loading.current = false;
      if (pending.current) {
        pending.current = false;
        void load();
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const unsubscribe = subscribeToChanges(() => {
      void load();
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [load]);

  const value = useMemo<AppDataValue>(
    () => ({ status, error, ideas, projects, reload: load }),
    [status, error, ideas, projects, load],
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData(): AppDataValue {
  const context = useContext(AppDataContext);
  if (!context) {
    throw new Error('useAppData 必须在 AppDataProvider 内使用');
  }
  return context;
}
