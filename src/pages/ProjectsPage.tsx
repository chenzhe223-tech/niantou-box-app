/**
 * 创意项目库：由念头升级而来的待开发项目。
 * 每个项目始终保留到原始念头的链接，避免想法与开发过程被割裂。
 */

import { useMemo, useState } from 'react';
import { useAppData } from '../app/AppDataProvider';
import { formatRelative } from '../app/format';
import { paths } from '../app/routes';
import { Badge, StatusBadge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { useNow } from '../hooks/useNow';
import { toNianBoxError, upgradeIdeaToProject } from '../services/storage';
import {
  displayTitle,
  productFormLabel,
  type Idea,
  type IdeaStatus,
} from '../types/idea';
import { progressLabel } from '../types/project';

/**
 * 候选念头的排序权重：越可能被推进成项目的越靠前。
 * 已标记为「准备开发 / 开发中」的排最前，避免打乱用户已有的推进节奏。
 */
const UPGRADE_PRIORITY: Record<IdeaStatus, number> = {
  ready: 0,
  building: 1,
  research: 2,
  inbox: 3,
  paused: 4,
  done: 5,
};

export function ProjectsPage({ navigate }: { navigate: (hash: string) => void }) {
  const { ideas, projects } = useAppData();
  const toast = useToast();
  const now = useNow();
  const [busyId, setBusyId] = useState<string | null>(null);

  const activeProjects = useMemo(
    () => projects.filter((project) => project.deletedAt === null),
    [projects],
  );

  const ideaById = useMemo(() => {
    const map = new Map<string, Idea>();
    for (const idea of ideas) map.set(idea.id, idea);
    return map;
  }, [ideas]);

  /**
   * 所有还没有升级成项目的念头都可以升级——不再要求先手动改成「准备开发」。
   * 原因：用户记完念头会直接来项目库找它，如果这里只列「准备开发 / 开发中」，
   * 刚记下的念头就会像「消失」了一样。升级时数据层会自动把状态推进到「准备开发」。
   */
  const upgradable = useMemo(() => {
    const linkedIdeaIds = new Set(activeProjects.map((project) => project.ideaId));
    return ideas
      .filter(
        (idea) =>
          idea.deletedAt === null &&
          idea.projectId === null &&
          !linkedIdeaIds.has(idea.id),
      )
      .sort((a, b) => {
        const byStatus = UPGRADE_PRIORITY[a.status] - UPGRADE_PRIORITY[b.status];
        return byStatus !== 0 ? byStatus : b.updatedAt - a.updatedAt;
      });
  }, [ideas, activeProjects]);

  const handleUpgrade = async (idea: Idea) => {
    setBusyId(idea.id);
    try {
      const result = await upgradeIdeaToProject(idea.id);
      toast.push({ message: '已升级为创意项目。', tone: 'success' });
      navigate(paths.project(result.project.id));
    } catch (caught) {
      toast.push({ message: toNianBoxError(caught).message, tone: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="nb-page">
      <div className="nb-page__head">
        <h1 className="nb-page__title">创意项目库</h1>
        <p className="nb-page__lead">
          把念头推进成项目：{activeProjects.length} 个进行中的项目，{upgradable.length} 条念头可以升级。
        </p>
      </div>

      {activeProjects.length === 0 ? (
        <EmptyState
          icon="box"
          title="还没有创意项目。"
          description="把你记下的念头升级为项目，就能在这里持续跟进它的进展。"
          action={
            <Button variant="primary" onClick={() => navigate(paths.inbox)}>
              去收件箱挑选念头
            </Button>
          }
        />
      ) : (
        <ul className="nb-list">
          {activeProjects.map((project) => {
            const source = ideaById.get(project.ideaId);
            const form = productFormLabel(project.productForm);
            return (
              <li key={project.id} className="nb-idea">
                <a
                  className="nb-idea__link"
                  href={paths.project(project.id)}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(paths.project(project.id));
                  }}
                >
                  <span className="nb-idea__title">{project.name || '未命名项目'}</span>
                  {project.problem ? (
                    <span className="nb-idea__excerpt">{project.problem}</span>
                  ) : null}
                </a>
                <div className="nb-idea__meta">
                  <Badge tone="ready">{progressLabel(project.progress)}</Badge>
                  {form ? <span>{form}</span> : null}
                  <span>更新于 {formatRelative(project.updatedAt, now)}</span>
                </div>
                <div className="nb-idea__foot">
                  {source ? (
                    <button
                      type="button"
                      className="nb-link nb-link--button"
                      onClick={() => navigate(paths.idea(source.id))}
                    >
                      <Icon name="sparkle" size={14} />
                      原始念头：{displayTitle(source)}
                    </button>
                  ) : (
                    <span className="nb-kv">原始念头已被永久删除</span>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => navigate(paths.project(project.id))}
                  >
                    打开项目
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {upgradable.length > 0 ? (
        <section className="nb-section" aria-labelledby="nb-upgradable">
          <div className="nb-section__head">
            <h2 className="nb-section__title" id="nb-upgradable">
              可以升级的念头
            </h2>
            <span className="nb-section__hint">任选一条一键升级，未标记的会自动设为「准备开发」</span>
          </div>
          <ul className="nb-list">
            {upgradable.map((idea) => (
              <li key={idea.id} className="nb-idea">
                <a
                  className="nb-idea__link"
                  href={paths.idea(idea.id)}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(paths.idea(idea.id));
                  }}
                >
                  <span className="nb-idea__title">{displayTitle(idea)}</span>
                </a>
                <div className="nb-idea__meta">
                  <StatusBadge status={idea.status} />
                  <span>更新于 {formatRelative(idea.updatedAt, now)}</span>
                </div>
                <div className="nb-idea__foot">
                  <span className="nb-kv">升级后会保留到这条念头的链接</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="plus"
                    disabled={busyId === idea.id}
                    onClick={() => {
                      void handleUpgrade(idea);
                    }}
                  >
                    升级为项目
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
