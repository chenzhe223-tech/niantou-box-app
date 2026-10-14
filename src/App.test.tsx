/**
 * 页面级集成测试。
 *
 * 这里渲染的是完整的 <App/>：真实的哈希路由 + 真实的 IndexedDB 数据层
 * （由 fake-indexeddb 提供），因此断言的是「真的写进了数据库」，
 * 而不是组件内部的临时状态。
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createIdea, getIdea, listIdeas, listProjects } from './services/storage';

const RAW_CONTENT = [
  '第一行：地下车库入口没有实时空位提示。',
  '第二行：🏎️ 想做一个车位雷达。',
  '参考链接 https://example.com/park?layer=b2&status=free',
].join('\n');

/** 在指定哈希路由下渲染整个应用。 */
function renderApp(hash = '#/') {
  const user = userEvent.setup();
  // useHashRoute 在首次渲染时直接读取 location.hash，因此先设置再渲染即可。
  window.location.hash = hash;
  const utils = render(<App />);
  return { user, ...utils };
}

describe('首页：随手记', () => {
  it('打开首页即可看到输入入口与首屏文案', async () => {
    renderApp();

    expect(await screen.findByRole('heading', { level: 1, name: '念头盒' })).toBeInTheDocument();
    expect(screen.getByText('每个好想法，都值得留下。')).toBeInTheDocument();
    expect(screen.getByLabelText('现在有什么新念头？')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '记下这个念头' })).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('比如：为什么每次停车时，我明明知道停车场位置，却总是找不到空车位？'),
    ).toBeInTheDocument();
    // 没有任何记录时给出引导，而不是空白页面。
    expect(screen.getByText('这里还没有念头。')).toBeInTheDocument();
  });

  it('可以创建新念头，并真正写入本地数据库', async () => {
    const { user } = renderApp();
    const textarea = await screen.findByLabelText('现在有什么新念头？');

    await user.type(textarea, '停车场总是找不到空车位');
    await user.click(screen.getByRole('button', { name: '记下这个念头' }));

    // 保存成功的提示必须建立在真实写入成功之上。
    expect(await screen.findByText('收好了，这个念头不会轻易丢失。')).toBeInTheDocument();

    await waitFor(() => expect(textarea).toHaveValue(''));

    const stored = await listIdeas();
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe('停车场总是找不到空车位');
    expect(stored[0].status).toBe('inbox');
    expect(stored[0].category).toBeNull();

    // 总数更新，且新内容出现在最近记录里。
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === 'P' && (element.textContent ?? '').includes('已记录 1 条念头'),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('停车场总是找不到空车位')).toBeInTheDocument();
  });

  it('空内容不会被保存', async () => {
    const { user } = renderApp();
    await screen.findByLabelText('现在有什么新念头？');

    await user.click(screen.getByRole('button', { name: '记下这个念头' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('先写下一句话，再收进念头盒。');
    expect(await listIdeas()).toHaveLength(0);
  });

  it('刷新页面后，已保存的念头仍然存在', async () => {
    const { user, unmount } = renderApp();
    const textarea = await screen.findByLabelText('现在有什么新念头？');
    await user.type(textarea, '刷新之后我应该还在');
    await user.click(screen.getByRole('button', { name: '记下这个念头' }));
    await screen.findByText('收好了，这个念头不会轻易丢失。');

    // 重新挂载，等价于浏览器刷新。
    unmount();
    renderApp();

    expect(await screen.findByText('刷新之后我应该还在')).toBeInTheDocument();
  });
});

describe('念头收件箱', () => {
  it('空状态给出友好引导', async () => {
    renderApp('#/inbox');

    expect(
      await screen.findByRole('heading', { level: 1, name: '念头收件箱' }),
    ).toBeInTheDocument();
    expect(screen.getByText('这里还没有念头。')).toBeInTheDocument();
    expect(
      screen.getByText('留意生活中的小问题，它们可能是下一个作品的起点。'),
    ).toBeInTheDocument();
  });

  it('搜索可以按关键词筛出匹配的念头，并在无结果时提示', async () => {
    await createIdea({ content: '车位雷达：进车库时记录车位编号' });
    await createIdea({ content: '旧书漂流：给社区里的旧书找新主人' });

    const { user } = renderApp('#/inbox');

    expect(await screen.findByText(/车位雷达/)).toBeInTheDocument();
    expect(screen.getByText(/旧书漂流/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('搜索念头'), '车位');
    await waitFor(() => expect(screen.queryByText(/旧书漂流/)).not.toBeInTheDocument());
    expect(screen.getByText(/车位雷达/)).toBeInTheDocument();

    await user.clear(screen.getByLabelText('搜索念头'));
    await user.type(screen.getByLabelText('搜索念头'), '完全不存在的内容');
    expect(await screen.findByText('没有找到匹配的念头。')).toBeInTheDocument();
  });

  it('删除前需要确认，取消后数据保持不变', async () => {
    const idea = await createIdea({ content: '误触删除检查' });
    const { user } = renderApp('#/inbox');

    await user.click(await screen.findByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('删除这条念头？')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect((await getIdea(idea.id))?.deletedAt).toBeNull();

    // 确认后才真正移入回收站。
    await user.click(screen.getByRole('button', { name: '删除' }));
    const confirmed = await screen.findByRole('dialog');
    await user.click(within(confirmed).getByRole('button', { name: '移到回收站' }));
    await waitFor(async () => {
      expect((await getIdea(idea.id))?.deletedAt).not.toBeNull();
    });
  });
});

describe('念头详情与编辑', () => {
  it('详情页完整显示原始记录，且时间显示正常', async () => {
    const idea = await createIdea({ content: RAW_CONTENT, title: '车位雷达' });

    renderApp(`#/idea/${idea.id}`);

    expect(await screen.findByRole('heading', { level: 1, name: '车位雷达' })).toBeInTheDocument();
    // 正文必须原样显示，包括换行、Emoji 与 URL。
    expect(screen.getByLabelText('正文')).toHaveValue(RAW_CONTENT);
    expect(screen.getByText('创建时间')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
  });

  it('编辑后的内容会持久保存，且不会改变记录 ID', async () => {
    const idea = await createIdea({ content: '第一版想法' });
    const { user } = renderApp(`#/idea/${idea.id}`);

    const content = await screen.findByLabelText('正文');
    await user.clear(content);
    await user.type(content, '更新后的正文，含 Emoji 🚀 与链接 https://example.com');
    await user.selectOptions(screen.getByLabelText('状态'), 'ready');
    await user.click(screen.getByRole('button', { name: '保存修改' }));

    expect(await screen.findByText('修改已保存。')).toBeInTheDocument();

    await waitFor(async () => {
      const stored = await getIdea(idea.id);
      expect(stored?.content).toBe('更新后的正文，含 Emoji 🚀 与链接 https://example.com');
      expect(stored?.status).toBe('ready');
      expect(stored?.id).toBe(idea.id);
      expect(stored?.createdAt).toBe(idea.createdAt);
    });
  });

  it('不存在的念头会给出可理解的提示', async () => {
    renderApp('#/idea/idea_not_exist');

    expect(await screen.findByText('这条念头不存在。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '回到收件箱' })).toBeInTheDocument();
  });
});

describe('创意项目', () => {
  it('升级为项目后，项目依然关联着原始念头', async () => {
    const idea = await createIdea({ content: '开发一个检查页面适配的 Skill' });
    const { user } = renderApp(`#/idea/${idea.id}`);

    await user.click(await screen.findByRole('button', { name: '升级为创意项目' }));

    const project = await waitFor(async () => {
      const list = await listProjects();
      expect(list).toHaveLength(1);
      return list[0];
    });
    expect(project.ideaId).toBe(idea.id);
    expect(project.name).toBe('开发一个检查页面适配的 Skill');

    // 项目详情页能看到「原始念头」，并且可以跳回去。
    expect(await screen.findByText('原始念头')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '开发一个检查页面适配的 Skill' }),
    ).toBeInTheDocument();

    // 念头状态被推进到「准备开发」，并记录来源项目。
    const stored = await getIdea(idea.id);
    expect(stored?.status).toBe('ready');
    expect(stored?.projectId).toBe(project.id);
  });
});

describe('设置与备份', () => {
  it('点击导出会下载一个带日期的 JSON 备份文件', async () => {
    const blobs: Blob[] = [];
    const downloaded: HTMLAnchorElement[] = [];
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

    // jsdom 没有实现 Blob URL，这里用最小实现替换，用于捕获导出的文件内容。
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: (blob: Blob) => {
        blobs.push(blob);
        return 'blob:nianbox-test';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: () => undefined,
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloaded.push(this);
      });

    try {
      await createIdea({ content: '导出测试的念头' });
      const { user } = renderApp('#/settings');

      await user.click(await screen.findByRole('button', { name: '导出数据' }));

      await waitFor(() => expect(downloaded).toHaveLength(1));
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(downloaded[0].download).toMatch(/^nianbox-backup-\d{4}-\d{2}-\d{2}\.json$/);
      expect(downloaded[0].href).toBe('blob:nianbox-test');

      const text = await blobs[0].text();
      const parsed = JSON.parse(text) as {
        format: string;
        version: number;
        ideas: Array<{ content: string }>;
      };
      expect(parsed.format).toBe('nianbox-backup');
      expect(parsed.version).toBe(1);
      expect(parsed.ideas.map((item) => item.content)).toContain('导出测试的念头');

      // 导出成功后给出明确反馈。
      expect(
        await screen.findByText(/已导出 nianbox-backup-\d{4}-\d{2}-\d{2}\.json/),
      ).toBeInTheDocument();
    } finally {
      clickSpy.mockRestore();
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
      else Reflect.deleteProperty(URL, 'createObjectURL');
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
      else Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });

  it('设置页明确说明数据只保存在本地浏览器', async () => {
    renderApp('#/settings');

    expect(
      await screen.findByText(
        '当前版本采用本地存储，记录保存在这台设备的当前浏览器中。清理浏览器数据或更换设备前，请先导出备份。',
      ),
    ).toBeInTheDocument();
  });
});

describe('异常状态', () => {
  it('本地数据库不可用时给出明确的错误状态与重试入口', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      writable: true,
      value: undefined,
    });

    try {
      renderApp();

      expect(await screen.findByText('本地数据读取失败')).toBeInTheDocument();
      expect(screen.getByText(/IndexedDB/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    } finally {
      if (descriptor) Object.defineProperty(window, 'indexedDB', descriptor);
    }
  });
});
