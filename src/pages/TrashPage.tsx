/**
 * 回收站：删除的念头与项目先放在这里，可以恢复，也可以永久删除。
 *
 * 采用软删除（deletedAt）而不是直接删除，
 * 保证误触不会造成不可逆的数据丢失。
 */

import { useMemo, useState } from 'react';
import { useAppData } from '../app/AppDataProvider';
import { formatRelative } from '../app/format';
import { paths } from '../app/routes';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { useToast } from '../components/Toast';
import { useNow } from '../hooks/useNow';
import {
  purgeDeletedIdeas,
  purgeIdea,
  purgeProject,
  restoreIdea,
  restoreProject,
  toNianBoxError,
} from '../services/storage';
import { displayTitle, type Idea } from '../types/idea';
import { progressLabel, type Project } from '../types/project';

type PendingPurge =
  | { kind: 'idea'; id: string; label: string }
  | { kind: 'project'; id: string; label: string }
  | { kind: 'all'; count: number };

export function TrashPage({ navigate }: { navigate: (hash: string) => void }) {
  const { ideas, projects } = useAppData();
  const toast = useToast();
  const now = useNow();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingPurge | null>(null);
  const [working, setWorking] = useState(false);

  const deletedIdeas = useMemo(
    () => ideas.filter((idea) => idea.deletedAt !== null),
    [ideas],
  );
  const deletedProjects = useMemo(
    () => projects.filter((project) => project.deletedAt !== null),
    [projects],
  );
  const empty = deletedIdeas.length === 0 && deletedProjects.length === 0;

  const handleRestoreIdea = async (idea: Idea) => {
    setBusyId(idea.id);
    try {
      await restoreIdea(idea.id);
      toast.push({ message: '已恢复到收件箱。', tone: 'success' });
    } catch (caught) {
      toast.push({ message: toNianBoxError(caught).message, tone: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const handleRestoreProject = async (project: Project) => {
    setBusyId(project.id);
    try {
      await restoreProject(project.id);
      toast.push({ message: '项目已恢复。', tone: 'success' });
    } catch (caught) {
      toast.push({ message: toNianBoxError(caught).message, tone: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const confirmPurge = async () => {
    if (!pending) return;
    setWorking(true);
    try {
      if (pending.kind === 'idea') {
        await purgeIdea(pending.id);
        toast.push({ message: '已永久删除，无法再恢复。', tone: 'info' });
      } else if (pending.kind === 'project') {
        await purgeProject(pending.id);
        toast.push({ message: '项目已永久删除。', tone: 'info' });
      } else {
        const count = await purgeDeletedIdeas();
        toast.push({ message: `已永久删除 ${count} 条念头及其关联项目。`, tone: 'info' });
      }
      setPending(null);
    } catch (caught) {
      toast.push({ message: toNianBoxError(caught).message, tone: 'error' });
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="nb-page">
      <div className="nb-page__head">
        <h1 className="nb-page__title">回收站</h1>
        <p className="nb-page__lead">
          {empty
            ? '这里暂时是空的。'
            : `${deletedIdeas.length} 条念头、${deletedProjects.length} 个项目等待处理。`}
        </p>
      </div>

      {empty ? (
        <EmptyState
          icon="trash"
          title="回收站是空的。"
          description="删除的念头与项目会先放到这里，确认不再需要时再永久删除。"
          action={
            <Button variant="secondary" onClick={() => navigate(paths.inbox)}>
              回到收件箱
            </Button>
          }
        />
      ) : (
        <>
          {deletedIdeas.length > 0 ? (
            <section aria-labelledby="nb-trash-ideas">
              <div className="nb-section__head">
                <h2 className="nb-section__title" id="nb-trash-ideas">
                  已删除的念头
                </h2>
                <span className="nb-section__count">{deletedIdeas.length} 条</span>
              </div>
              <ul className="nb-list">
                {deletedIdeas.map((idea) => (
                  <li key={idea.id} className="nb-idea">
                    <span className="nb-idea__title">{displayTitle(idea)}</span>
                    <div className="nb-idea__meta">
                      <span>删除于 {formatRelative(idea.deletedAt ?? idea.updatedAt, now)}</span>
                    </div>
                    <div className="nb-idea__foot">
                      <span className="nb-kv">恢复后回到收件箱</span>
                      <span className="nb-idea__actions">
                        <Button
                          size="sm"
                          variant="secondary"
                          icon="refresh"
                          disabled={busyId === idea.id}
                          onClick={() => {
                            void handleRestoreIdea(idea);
                          }}
                        >
                          恢复
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="trash"
                          onClick={() =>
                            setPending({
                              kind: 'idea',
                              id: idea.id,
                              label: displayTitle(idea),
                            })
                          }
                        >
                          永久删除
                        </Button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {deletedProjects.length > 0 ? (
            <section className="nb-section" aria-labelledby="nb-trash-projects">
              <div className="nb-section__head">
                <h2 className="nb-section__title" id="nb-trash-projects">
                  已删除的项目
                </h2>
                <span className="nb-section__count">{deletedProjects.length} 个</span>
              </div>
              <ul className="nb-list">
                {deletedProjects.map((project) => (
                  <li key={project.id} className="nb-idea">
                    <span className="nb-idea__title">{project.name || '未命名项目'}</span>
                    <div className="nb-idea__meta">
                      <span>{progressLabel(project.progress)}</span>
                      <span>删除于 {formatRelative(project.deletedAt ?? project.updatedAt, now)}</span>
                    </div>
                    <div className="nb-idea__foot">
                      <span className="nb-kv">原始念头不受影响</span>
                      <span className="nb-idea__actions">
                        <Button
                          size="sm"
                          variant="secondary"
                          icon="refresh"
                          disabled={busyId === project.id}
                          onClick={() => {
                            void handleRestoreProject(project);
                          }}
                        >
                          恢复
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="trash"
                          onClick={() =>
                            setPending({
                              kind: 'project',
                              id: project.id,
                              label: project.name || '未命名项目',
                            })
                          }
                        >
                          永久删除
                        </Button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="nb-actionbar nb-trash__actions">
            <Button
              variant="danger"
              icon="trash"
              onClick={() =>
                setPending({ kind: 'all', count: deletedIdeas.length + deletedProjects.length })
              }
            >
              清空回收站
            </Button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={pending !== null}
        tone="danger"
        title="永久删除后无法恢复"
        confirmLabel="永久删除"
        busy={working}
        description={
          pending?.kind === 'idea' ? (
            <p>「{pending.label}」会被彻底删除，连同它的项目关联一起清除，无法再恢复。</p>
          ) : pending?.kind === 'project' ? (
            <p>项目「{pending.label}」会被彻底删除，无法再恢复。原始念头会保留。</p>
          ) : pending?.kind === 'all' ? (
            <p>回收站中的 {pending.count} 条记录会被彻底删除，无法再恢复。</p>
          ) : null
        }
        onCancel={() => setPending(null)}
        onConfirm={() => {
          void confirmPurge();
        }}
      />
    </div>
  );
}
