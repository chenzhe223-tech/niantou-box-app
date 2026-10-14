/**
 * 应用外壳：品牌栏 + 路由分发 + 底部 Tab 导航。
 *
 * 路由使用哈希方案，因此部署在 GitHub Pages 子路径下时，
 * 刷新任意页面都不会 404。
 */

import { useEffect, useRef, useState } from 'react';
import { AppDataProvider, useAppData } from './app/AppDataProvider';
import { paths, type Route } from './app/routes';
import { BrandMark } from './components/BrandMark';
import { Button } from './components/Button';
import { Icon, type IconName } from './components/Icon';
import { ErrorState, LoadingState } from './components/States';
import { ToastProvider } from './components/Toast';
import { useHashRoute } from './hooks/useHashRoute';
import { DeveloperPage } from './pages/DeveloperPage';
import { FeedbackPage } from './pages/FeedbackPage';
import { HomePage } from './pages/HomePage';
import { IdeaDetailPage } from './pages/IdeaDetailPage';
import { InboxPage } from './pages/InboxPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { SettingsPage } from './pages/SettingsPage';
import { TrashPage } from './pages/TrashPage';
import { createIdea } from './services/storage';

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
    case 'feedback':
      return <FeedbackPage navigate={navigate} />;
    case 'dev':
      return <DeveloperPage navigate={navigate} />;
  }
}

function Shell({ route, navigate }: { route: Route; navigate: (hash: string) => void }) {
  const { status, error, reload } = useAppData();
  const current = activeTab(route);

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

function CaptureReceiver() {
  const handled = useRef(false);
  const { route, navigate } = useHashRoute();
  const [captureState, setCaptureState] = useState<'idle' | 'saving' | 'error'>('idle');

  const saveIncomingIdea = async (content: string) => {
    setCaptureState('saving');
    try {
      await createIdea({ content });
      // Clear the transfer payload from browser history only after the local save succeeds.
      window.history.replaceState(null, '', window.location.pathname + '#/inbox');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      setCaptureState('idle');
    } catch {
      // Keep the payload in the hash and show a retry option; never claim it was saved.
      handled.current = false;
      setCaptureState('error');
    }
  };

  useEffect(() => {
    if (handled.current) return;
    const queryPayload = new URLSearchParams(window.location.search).get('capture');
    const hashMatch = window.location.hash.match(/^#\/capture\?text=([\s\S]*)$/);
    let incoming: string | null = queryPayload;
    if (incoming === null && hashMatch) {
      try {
        incoming = decodeURIComponent(hashMatch[1]);
      } catch {
        setCaptureState('error');
        return;
      }
    }
    if (incoming === null) return;

    let content = '';
    try {
      content = incoming.trim();
    } catch {
      setCaptureState('error');
      return;
    }
    if (!content) return;

    handled.current = true;
    void saveIncomingIdea(content);
  }, []);

  if (captureState !== 'idle') {
    return (
      <div className="nb-app">
        <main className="nb-app__main" role="status" aria-live="polite">
          <section className="nb-page">
            <div className="nb-hero">
              <h1 className="nb-hero__title">
                {captureState === 'saving' ? '正在收好这个念头…' : '这条念头还没保存成功'}
              </h1>
              <p className="nb-hero__sub">
                {captureState === 'saving'
                  ? '正在把官网输入的原文保存到当前设备的念头盒收件箱。'
                  : '原文仍保留在本次跳转地址中，你可以重试保存。'}
              </p>
              {captureState === 'error' ? (
                <Button onClick={() => {
                  const queryPayload = new URLSearchParams(window.location.search).get('capture');
                  const hashMatch = window.location.hash.match(/^#\/capture\?text=([\s\S]*)$/);
                  let incoming: string | null = queryPayload;
                  if (incoming === null && hashMatch) {
                    try {
                      incoming = decodeURIComponent(hashMatch[1]);
                    } catch {
                      setCaptureState('error');
                      return;
                    }
                  }
                  if (incoming === null) return;
                  try {
                    const content = incoming.trim();
                    if (!content) return;
                    handled.current = true;
                    void saveIncomingIdea(content);
                  } catch {
                    setCaptureState('error');
                  }
                }}>
                  重试保存
                </Button>
              ) : null}
            </div>
          </section>
        </main>
      </div>
    );
  }

  return <Shell route={route} navigate={navigate} />;
}

export function App() {
  return (
    <ToastProvider>
      <AppDataProvider>
        <CaptureReceiver />
      </AppDataProvider>
    </ToastProvider>
  );
}
