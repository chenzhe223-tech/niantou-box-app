/**
 * 页面级验收测试（2.1「无需登录的即时创作」+ 持久化作品库 + 分享闭环）。
 *
 * 这里渲染完整的 <App/>：真实的哈希路由、真实的 IndexedDB（fake-indexeddb）。
 * Canvas 用 src/test/canvasStub.ts 的记录型替身，于是可以断言「图上真的出现了
 * 品牌文字与用户确认过的文案」，而不是假装画好了。
 *
 * 几条刻意守住的底线：
 *   - 不伪造生成结果：图像服务没配置时，界面必须说「本机绘制，不是 AI 生成」；
 *   - 不静默联网：未登录场景下任何一步都不许发出请求（cloudRequest / fetch 都要为 0）；
 *   - 不静默分享：系统分享只能在用户点了按钮之后发生。
 *
 * 云端请求整体打桩（只保留真实的 CloudError），因此测试不会发出真实网络请求。
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { BRAND_STAR_PATH } from './components/BrandMark';
import { CloudError, cloudRequest } from './services/cloud/cloudClient';
import { resetCloudSyncForTests } from './services/cloud/cloudSync';
import { resetWorkImageCacheForTests } from './hooks/useWorks';
import { STORE_WORK_IMAGES, STORE_WORKS, putRecord } from './services/idb';
import { SHARE_UNSUPPORTED_MESSAGE } from './services/poster';
import { createIdea, getIdea, listIdeas } from './services/storage';
import { listWorks, readWorkImage, saveWork } from './services/works';
import { countPathPoints, installCanvasStub, type CanvasRecorder } from './test/canvasStub';

vi.mock('./services/cloud/cloudClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/cloud/cloudClient')>();
  return { ...actual, cloudRequest: vi.fn() };
});

const mockedRequest = vi.mocked(cloudRequest);
const TOKEN_KEY = 'nb.cloud.token.v1';
/** canvasStub.toDataURL 固定返回的那段 data: URL。 */
const STUB_DATA_URL = `data:image/png;base64,${'A'.repeat(64)}`;

let recorder: CanvasRecorder;
let restoreCanvas: () => void;

beforeAll(() => {
  const handle = installCanvasStub();
  recorder = handle.recorder;
  restoreCanvas = handle.restore;
});

afterAll(() => {
  restoreCanvas();
});

beforeEach(() => {
  mockedRequest.mockReset();
  // 默认：服务端什么都没配（既没有抽象模型，也没有图像生成服务）。
  mockedRequest.mockResolvedValue({});
  recorder.texts.length = 0;
  recorder.moveTo = 0;
  recorder.lineTo = 0;
});

afterEach(() => {
  // 作品图片缓存是模块级的：不清掉会跨用例串味。
  resetWorkImageCacheForTests();
  resetCloudSyncForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window.navigator, 'share');
});

/** 在指定哈希路由下渲染整个应用。 */
function renderApp(hash = '#/') {
  const user = userEvent.setup();
  // useHashRoute 在首次渲染时直接读取 location.hash，所以先设置再渲染。
  window.location.hash = hash;
  return { user, ...render(<App />) };
}

/** 只配了云端地址、还没登录。 */
function configureCloud(endpoint = 'https://example.test') {
  vi.stubEnv('VITE_CLOUD_ENDPOINT', endpoint);
  resetCloudSyncForTests();
}

/** 配了云端地址并且带着令牌：这才是「AI 增强生图可用」的状态。 */
function signIn() {
  configureCloud();
  window.localStorage.setItem(TOKEN_KEY, 'test-token');
  resetCloudSyncForTests();
}

describe('未登录：记下念头并立刻做成本机卡片', () => {
  it('第一次打开就能记下一条念头，随后马上拿到一张可保存的卡片', async () => {
    const { user, unmount } = renderApp('#/');

    const textarea = await screen.findByLabelText('记下一句话就好……');
    await user.type(textarea, '地下车库入口没有实时空位提示，总是绕圈找车位');
    await user.click(screen.getByRole('button', { name: '记下这个念头' }));

    expect(await screen.findByText('收好了，这个念头不会轻易丢失。')).toBeInTheDocument();

    const stored = await listIdeas();
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe('地下车库入口没有实时空位提示，总是绕圈找车位');
    expect(stored[0].deletedAt).toBeNull();

    unmount();

    // 同一台设备、不需要登录，直接进「把这个念头变成图片」。
    renderApp(`#/poster/${stored[0].id}`);

    expect(
      await screen.findByRole('heading', { level: 1, name: '把这个念头变成图片' }),
    ).toBeInTheDocument();
    // 明确标注这是本机卡片，不冒充 AI 绘图。
    expect(await screen.findByText('现在能做的是「本机制作的念头卡片」')).toBeInTheDocument();
    expect(screen.getByText(/这不是 AI 绘图，也不会消耗任何模型额度/)).toBeInTheDocument();

    // 分享之前，先把将要出现在图上的文字逐字列出来。
    expect(screen.getByText('将要分享的文字（就是图片上会出现的内容）：')).toBeInTheDocument();
    expect(screen.getByText(stored[0].content)).toBeInTheDocument();

    // 卡片真的画出来了：品牌名称与品牌收尾文案都在图上。
    await waitFor(() => {
      const texts = recorder.texts.map((item) => item.text);
      expect(texts).toContain('念头盒 NianBox');
      expect(texts).toContain('让每一个念头，都有机会成为现实');
    });

    // 星形 Logo 的顶点来自既有的品牌路径（顶部一行 + 底部细带各一枚），不是另画的图形。
    const points = countPathPoints(BRAND_STAR_PATH);
    expect(points).toBeGreaterThan(2);
    expect(recorder.moveTo).toBe(2);
    expect(recorder.lineTo).toBe(2 * (points - 1));
  });

  it('本机卡片完全在本机完成：不调用 AI 接口，也不发起任何网络请求', async () => {
    const idea = await createIdea({ content: '本机卡片不应该联网' });
    // sharePoster 内部会 fetch(data: URL) 取 blob；这里给一个能真的吐出 blob 的替身。
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    renderApp(`#/poster/${idea.id}`);

    expect(await screen.findByText('现在能做的是「本机制作的念头卡片」')).toBeInTheDocument();
    await waitFor(() =>
      expect(recorder.texts.some((item) => item.text === '念头盒 NianBox')).toBe(true),
    );

    expect(mockedRequest).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('作品库：保存、重新读取与删除', () => {
  it('保存到我的作品会真正写进 IndexedDB，重新打开应用仍然读得到', async () => {
    const idea = await createIdea({ content: '这张卡片要留下来' });

    const first = renderApp(`#/poster/${idea.id}`);

    // 卡片成功绘制后应自动写入作品库，不再要求用户额外点击保存。
    expect(await screen.findByText('卡片已自动归集到「最近作品」。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '已保存到我的作品' })).toBeDisabled();

    const works = await listWorks();
    expect(works).toHaveLength(1);
    expect(works[0].ideaId).toBe(idea.id);
    expect(works[0].source).toBe('card');
    expect(works[0].render).toBe('local');
    expect(await readWorkImage(works[0].id)).toBe(STUB_DATA_URL);

    // 关掉当前页面、重新打开应用：作品仍然在。
    first.unmount();
    renderApp('#/works');

    expect(await screen.findByRole('heading', { level: 1, name: '我的作品' })).toBeInTheDocument();
    expect(await screen.findByText('共 1 件，按创建时间从新到旧排列。')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: '预览作品：这张卡片要留下来' }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/本机制作的念头卡片/)).toBeInTheDocument();
  });

  it('没有作品时，作品列表给出空状态和创作入口', async () => {
    renderApp('#/works');

    expect(await screen.findByText('这里还没有作品。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去记一个念头' })).toBeInTheDocument();
  });

  it('首页能找回最近作品，并一键进入作品列表', async () => {
    const idea = await createIdea({ content: '最近作品要能找回来' });
    await saveWork({
      ideaId: idea.id,
      source: 'card',
      render: 'local',
      style: 'card',
      aspect: '3:4',
      title: '最近作品要能找回来',
      dataUrl: STUB_DATA_URL,
    });

    const { user } = renderApp('#/');

    expect(await screen.findByRole('heading', { level: 2, name: '最近作品' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '查看全部（1）' }));

    expect(await screen.findByRole('heading', { level: 1, name: '我的作品' })).toBeInTheDocument();
  });

  it('删除作品前先确认，删除后元数据与图片都不留', async () => {
    const idea = await createIdea({ content: '准备删掉这件作品' });
    const work = await saveWork({
      ideaId: idea.id,
      source: 'card',
      render: 'local',
      style: 'card',
      aspect: '3:4',
      title: '准备删掉这件作品',
      dataUrl: STUB_DATA_URL,
    });

    const { user } = renderApp('#/works');
    await screen.findByRole('heading', { level: 1, name: '我的作品' });

    await user.click(await screen.findByRole('button', { name: '删除' }));
    // 有损操作必须先确认。
    expect(await screen.findByText('删除这件作品？')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除作品' }));

    expect(
      await screen.findByText('这件作品已经从本机删掉，不会再出现在列表里。'),
    ).toBeInTheDocument();
    await waitFor(async () => {
      expect(await listWorks()).toHaveLength(0);
    });
    expect(await readWorkImage(work.id)).toBeNull();
  });
});

describe('AI 生图：可用与不可用都照实说', () => {
  it('没有配置云端地址时说明 AI 生图不可用，并且不阻挡本机卡片', async () => {
    const idea = await createIdea({ content: '这个构建没有云端地址' });
    renderApp(`#/poster/${idea.id}`);

    expect(await screen.findByText('这个构建没有配置云端地址')).toBeInTheDocument();
    expect(screen.getByText(/没有云端地址时无法使用/)).toBeInTheDocument();
    expect(screen.queryByText('AI 增强生图需要先登录')).toBeNull();
    expect(screen.queryByText('1. 生成结果')).toBeNull();
    expect(screen.getByText('现在能做的是「本机制作的念头卡片」')).toBeInTheDocument();
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('配置了云端但没登录时，说明为什么需要登录，同时保留本机卡片这条路', async () => {
    configureCloud();
    const idea = await createIdea({ content: '需要登录才能 AI 生图' });
    renderApp(`#/poster/${idea.id}`);

    expect(await screen.findByText('AI 增强生图需要先登录')).toBeInTheDocument();
    expect(screen.queryByText('这个构建没有配置云端地址')).toBeNull();
    expect(screen.queryByText('1. 生成结果')).toBeNull();
    expect(screen.getByRole('button', { name: '去登录' })).toBeInTheDocument();
    expect(screen.getByText('现在能做的是「本机制作的念头卡片」')).toBeInTheDocument();
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('登录之后才出现 AI 生图；图像服务不可用时用本机绘制兜底，不冒充 AI', async () => {
    signIn();
    const idea = await createIdea({ content: '登录之后可以走 AI 生图' });
    renderApp(`#/poster/${idea.id}`);

    expect(await screen.findByRole('heading', { level: 2, name: '1. 生成结果' })).toBeInTheDocument();
    expect(screen.queryByText('AI 增强生图需要先登录')).toBeNull();
    expect(screen.queryByText('这个构建没有配置云端地址')).toBeNull();

    // 自动跑一次：抽象成功 → 服务端说没有图像服务 → 本机绘制并如实标注。
    expect(await screen.findByText('本机绘制，不是 AI 生成')).toBeInTheDocument();
    expect(screen.getByText(/服务端没有配置图像生成服务/)).toBeInTheDocument();
  });

  it('AI 服务失败时如实报错，原始念头一个字都没变', async () => {
    signIn();
    mockedRequest.mockImplementation((path) =>
      path === '/ai/abstract'
        ? Promise.reject(new CloudError('server', '服务端出错了', { status: 500, detail: '' }))
        : Promise.resolve({}),
    );
    const idea = await createIdea({ content: '这条念头不能因为生图失败而消失' });
    renderApp(`#/poster/${idea.id}`);

    expect(await screen.findByText('这次没有生成成功')).toBeInTheDocument();
    expect(screen.getByText('服务端出错了')).toBeInTheDocument();
    expect(screen.getByText(/原始念头没有变化/)).toBeInTheDocument();

    const stored = await getIdea(idea.id);
    expect(stored?.content).toBe('这条念头不能因为生图失败而消失');
    expect(await listIdeas()).toHaveLength(1);
  });
});

describe('分享：只在用户确认之后发生', () => {
  it('设备不支持系统分享时，给出能照着做的替代办法', async () => {
    const idea = await createIdea({ content: '分享不支持的场景' });
    const { user } = renderApp(`#/poster/${idea.id}`);

    // jsdom 没有 navigator.share，正好是「不支持系统分享」的真实场景。
    await user.click(await screen.findByRole('button', { name: '系统分享' }));

    expect(await screen.findByText(SHARE_UNSUPPORTED_MESSAGE)).toBeInTheDocument();
    // 替代方案必须真的可执行，而不是一句「暂不支持」。
    expect(SHARE_UNSUPPORTED_MESSAGE).toContain('保存图片');
  });

  it('未经用户点击，不会发生系统分享，也不会上传任何图片', async () => {
    const idea = await createIdea({ content: '没有确认就不该被分享出去' });
    const shareSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'share', {
      configurable: true,
      writable: true,
      value: shareSpy,
    });
    // sharePoster 内部会 fetch(data: URL) 取 blob；这里给一个能真的吐出 blob 的替身。
    const fetchSpy = vi.fn(async () => ({
      blob: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const { user } = renderApp(`#/poster/${idea.id}`);

    await screen.findByText('现在能做的是「本机制作的念头卡片」');
    expect(await screen.findByText('卡片已自动归集到「最近作品」。')).toBeInTheDocument();

    // 保存到本机作品不是分享：系统分享与网络请求都还没发生。
    expect(shareSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    // 只有用户主动点「系统分享」，系统分享面板才会被调起。
    await user.click(screen.getByRole('button', { name: '系统分享' }));
    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    // 分享的是用户已经确认过的那段文字，而不是悄悄附加的别的内容。
    const payload = shareSpy.mock.calls[0][0] as { text: string };
    expect(payload.text).toBe('没有确认就不该被分享出去');
  });
});

describe('作品图片：按需读取，不把全部图片塞进内存', () => {
  /** 只记录「从 workImages 表按 ID 读图」的动作；元数据用的是 getAll，不算在内。 */
  function trackWorkImageReads() {
    const ids: string[] = [];
    const original = IDBObjectStore.prototype.get;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, 'get')
      .mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
        if (this.name === STORE_WORK_IMAGES) ids.push(String(key));
        return original.call(this, key);
      });
    return { ids, restore: () => spy.mockRestore() };
  }

  /** 直接写库：让 6 件作品的创建时间有明确先后，排序结果可预期。 */
  async function seedWorks(ideaId: string, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const id = `work_seed_${index}`;
      await putRecord(STORE_WORKS, {
        id,
        ideaId,
        kind: 'poster',
        source: 'card',
        render: 'local',
        style: 'card',
        aspect: '3:4',
        title: `作品 ${index}`,
        createdAt: 1_000 + index,
      });
      await putRecord(STORE_WORK_IMAGES, {
        workId: id,
        mime: 'image/png',
        dataUrl: STUB_DATA_URL,
        bytes: 48,
        createdAt: 1_000 + index,
      });
    }
  }

  it('首页有 6 件作品时，按专辑架需要只把最近作品图片读入内存', async () => {
    const idea = await createIdea({ content: '作品很多时的首页' });
    await seedWorks(idea.id, 6);

    const tracker = trackWorkImageReads();
    try {
      renderApp('#/');

      // 元数据仍然是全量读的：按钮如实显示一共有 6 件。
      expect(await screen.findByRole('button', { name: '查看全部（6）' })).toBeInTheDocument();

      await waitFor(() => {
        // 首页横向专辑架读取最近最多 8 件；这里 6 件全部可见。
        expect([...new Set(tracker.ids)].sort()).toEqual([
          'work_seed_0',
          'work_seed_1',
          'work_seed_2',
          'work_seed_3',
          'work_seed_4',
          'work_seed_5',
        ]);
      });
      // 横向专辑架展示最近最多 8 件，6 件作品都在可浏览范围。
      expect(screen.getByText('作品 5')).toBeInTheDocument();
      expect(screen.getByText('作品 2')).toBeInTheDocument();
    } finally {
      tracker.restore();
    }
  });

  it('重新打开作品列表时，同一批图片不会再从库里读一遍', async () => {
    const idea = await createIdea({ content: '重复读取检查' });
    await seedWorks(idea.id, 3);

    const tracker = trackWorkImageReads();
    try {
      const first = renderApp('#/works');
      await screen.findByRole('heading', { level: 1, name: '我的作品' });
      await waitFor(() =>
        expect(screen.getAllByRole('button', { name: /预览作品：/ })).toHaveLength(3),
      );
      await waitFor(() => expect(new Set(tracker.ids).size).toBe(3));
      first.unmount();

      const readsAfterFirstOpen = tracker.ids.length;
      const second = renderApp('#/works');
      await screen.findByRole('heading', { level: 1, name: '我的作品' });
      await waitFor(() =>
        expect(screen.getAllByRole('button', { name: /预览作品：/ })).toHaveLength(3),
      );

      // 第二次打开一张新图都没读：命中了模块级图片缓存。
      expect(tracker.ids.length).toBe(readsAfterFirstOpen);
      second.unmount();
    } finally {
      tracker.restore();
    }
  });

  it('图片真的缺失时如实提示，不用空白图掩盖', async () => {
    const idea = await createIdea({ content: '只有元数据没有图', title: '缺图的这件作品' });
    await putRecord(STORE_WORKS, {
      id: 'work_no_image',
      ideaId: idea.id,
      kind: 'poster',
      source: 'card',
      render: 'local',
      style: 'card',
      aspect: '3:4',
      title: '缺图的这件作品',
      createdAt: 1_000,
    });

    renderApp('#/works');

    expect(
      await screen.findByRole('button', { name: '预览作品：缺图的这件作品' }),
    ).toBeInTheDocument();
    // 明确写出「图片数据缺失」，而不是留一个空白缩略图。
    expect(await screen.findByText('图片数据缺失')).toBeInTheDocument();
  });
});