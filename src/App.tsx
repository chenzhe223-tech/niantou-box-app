/**
 * 应用外壳：品牌栏 + 路由分发 + 底部 Tab 导航。
 *
 * 路由使用哈希方案，因此部署在 GitHub Pages 子路径下时，
 * 刷新任意页面都不会 404。
 */

import { useEffect, useRef } from 'react';
import { AppDataProvider, useAppData } from './app/AppDataProvider';
import { paths, type Route } from './app/routes';
import { isDevDashboardEnabled } from './app/telemetryConfig';
import { BrandMark } from './components/BrandMark';
import { Icon, type IconName } from './components/Icon';
import { ErrorState, LoadingState } from './components/States';
import { ToastProvider, useToast } from './components/Toast';
import { useHashRoute } from './hooks/useHashRoute';
import { useCategoryBackfill } from './hooks/useCategoryBackfill';
import { useCloudSync } from './hooks/useCloudSync';
import { useKeyboardInset } from './hooks/useKeyboardInset';
import { importPendingRadarSkills } from './services/radarSkillCapture';
import { DeveloperPage } from './pages/DeveloperPage';
import { CloudPage } from './pages/CloudPage';
import { FeedbackPage } from './pages/FeedbackPage';
import { HomePage } from './pages/HomePage';
import { IdeaDetailPage } from './pages/IdeaDetailPage';
import { InboxPage } from './pages/InboxPage';
import { PosterPage } from './pages/PosterPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { SettingsPage } from './pages/SettingsPage';
import { TrashPage } from './pages/TrashPage';
import { WorksPage } from './pages/WorksPage';

/**
 * 底部导航的标签名。`none` 表示「当前页面不属于任何标签」
 * （反馈页与开发者看板是从设置页进入的二级页面）。
 */
type TabName = 'home' | 'inbox' | 'projects' | 'trash' | 'settings' | 'none';

const TABS: ReadonlyArray<{ name: TabName; label: string; icon: IconName; hash: string }> = [
  { name: 'home', label: '记念头', icon: 'plus', hash: paths.home },
  { name: 'inbox', label: '收件箱', icon: 'inbox', hash: paths.inbox },
  { name: 'projects', label: '项目', icon: 'box', hash: paths.projects },
  { name: 'trash', label: '回收站', icon: 'trash', hash: paths.trash },
  { name: 'settings', label: '设置', icon: 'gear', hash: paths.settings },
];

function activeTab(route: Route): TabName {
  switch (route.name) {
    case 'home':
      return 'home';
    case 'idea':
      return 'inbox';
    case 'project':
      return 'projects';
    case 'inbox':
      return 'inbox';
    case 'projects':
      return 'projects';
    case 'trash':
      return 'trash';
    case 'settings':
      return 'settings';
    // 云端同步是从设置页进入的二级页面，底部导航停留在「设置」。
    case 'cloud':
      return 'settings';
    // 灵感海报是独立工具页，不属于任何主导航标签。
    case 'poster':
    case 'posterTool':
      return 'none';
    // 我的作品是从首页进入的二级页面，不额外占用底部导航标签。
    case 'works':
      return 'none';
    case 'feedback':
    case 'dev':
      return 'none';
  }
}

function RouteView({ route, navigate }: { route: Route; navigate: (hash: string) => void }) {
  switch (route.name) {
    case 'home':
      return <HomePage navigate={navigate} />;
    case 'inbox':
      return <InboxPage navigate={navigate} />;
    case 'idea':
      // key 保证切换念头时表单状态重新初始化，不会串内容。
      return <IdeaDetailPage key={route.id} ideaId={route.id} navigate={navigate} />;
    case 'projects':
      return <ProjectsPage navigate={navigate} />;
    case 'project':
      return <ProjectDetailPage key={route.id} projectId={route.id} navigate={navigate} />;
    case 'trash':
      return <TrashPage navigate={navigate} />;
    case 'settings':
      return <SettingsPage navigate={navigate} />;
    case 'cloud':
      return <CloudPage navigate={navigate} />;
    // key 保证从「某条念头」和「海报工具」之间切换时重新初始化选择状态。
    case 'poster':
      return <PosterPage key={route.id} ideaId={route.id} navigate={navigate} />;
    case 'posterTool':
      return <PosterPage key="poster-tool" ideaId={null} navigate={navigate} />;
    case 'works':
      return <WorksPage navigate={navigate} />;
    case 'feedback':
      return <FeedbackPage navigate={navigate} />;
    case 'dev':
      return isDevDashboardEnabled() ? <DeveloperPage navigate={navigate} /> : <SettingsPage navigate={navigate} />;
  }
}

function Shell({ route, navigate }: { route: Route; navigate: (hash: string) => void }) {
  const { status, error, reload, ideas } = useAppData();
  const cloud = useCloudSync();
  const current = activeTab(route);
  const toast = useToast();
  const radarImportStarted = useRef(false);

  // Import explicitly saved Skills after local IndexedDB is ready.
  useEffect(() => {
    if (status !== 'ready' || radarImportStarted.current) return;
    radarImportStarted.current = true;
    let active = true;
    void importPendingRadarSkills()
      .then((result) => {
        if (!active) return;
        if (result.imported > 0) {
          toast.push({
            message: '已从 AI 简报收录 ' + result.imported + ' 个 Skill，已放入念头盒收件箱。',
            tone: 'success',
          });
        }
        if (result.failed > 0) {
          toast.push({
            message: result.failed + ' 个 Skill 暂未收录，仍留在待导入队列；刷新后可以重试。',
            tone: 'error',
            duration: 0,
          });
        }
      })
      .catch(() => {
        if (!active) return;
        toast.push({
          message: '简报 Skill 暂未导入，待导入内容仍会保留；请稍后刷新重试。',
          tone: 'error',
          duration: 0,
        });
      });
    return () => {
      active = false;
    };
  }, [status, toast]);

  // 手机软键盘弹起时多留一段下边距，输入框与保存按钮不会被键盘挡住。
  useKeyboardInset();

  // 登录之后，把迁移上来 / 官网快速记录进来的「未分类」念头补上分类。
  useCategoryBackfill(ideas, cloud.signedIn);

  return (
    <div className="nb-app">
      <header className={route.name === 'home' ? 'nb-app__top' : 'nb-app__top nb-app__top--bordered'}>
        <div className="nb-app__topinner">
          <a className="nb-brand" href={paths.home}>
            <BrandMark size={30} />
            <span className="nb-brand__name">
              念头盒
              <span className="nb-brand__en">NianBox</span>
            </span>
          </a>
        </div>
      </header>

      <main className="nb-app__main">
        {status === 'loading' ? <LoadingState /> : null}
        {status === 'error' ? (
          <ErrorState
            message={error ?? '本地数据读取失败，请刷新页面后重试。'}
            onRetry={() => {
              void reload();
            }}
          />
        ) : null}
        {status === 'ready' ? <RouteView route={route} navigate={navigate} /> : null}
      </main>

      <nav className="nb-tabbar" aria-label="主导航">
        {TABS.map((tab) => (
          <a
            key={tab.name}
            className={
              tab.name === current ? 'nb-tabbar__link nb-tabbar__link--active' : 'nb-tabbar__link'
            }
            href={tab.hash}
            aria-current={tab.name === current ? 'page' : undefined}
          >
            <Icon name={tab.icon} size={20} />
            <span className="nb-tabbar__label">{tab.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}

export function App() {
  const { route, navigate } = useHashRoute();

  return (
    <ToastProvider>
      <AppDataProvider>
        <Shell route={route} navigate={navigate} />
      </AppDataProvider>
    </ToastProvider>
  );
}
