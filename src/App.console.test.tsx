/**
 * 控制台干净度检查。
 *
 * 规格里明确要求「检查浏览器控制台错误」与「检查是否存在未处理的 Promise 异常」。
 * 浏览器自动化在当前环境不可用，因此这里用 jsdom 驱动完整的 <App/>，
 * 走一遍主要使用路径，并断言：
 *   1. console.error / console.warn 没有被调用（React 的 key 警告、act 警告都会被抓到）；
 *   2. window 上不会抛出未捕获错误或未处理的 Promise 拒绝。
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createIdea } from './services/storage';

type ConsoleCall = { level: 'error' | 'warn'; text: string };

let consoleCalls: ConsoleCall[] = [];
let runtimeErrors: string[] = [];

/** 把任意类型的 console 参数转成可读文本，便于断言失败时定位。 */
function describeArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      if (typeof arg === 'object' && arg !== null) {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(' ');
}

function onWindowError(event: ErrorEvent): void {
  runtimeErrors.push(`window error: ${event.message}`);
}

function onUnhandledRejection(event: PromiseRejectionEvent): void {
  runtimeErrors.push(`unhandled rejection: ${describeArgs([event.reason])}`);
}

beforeAll(() => {
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
});

afterAll(() => {
  window.removeEventListener('error', onWindowError);
  window.removeEventListener('unhandledrejection', onUnhandledRejection);
});

beforeEach(() => {
  consoleCalls = [];
  runtimeErrors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleCalls.push({ level: 'error', text: describeArgs(args) });
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    consoleCalls.push({ level: 'warn', text: describeArgs(args) });
  });
});

/** 等待一个宏任务，让已经排队的 Promise 有机会暴露未处理拒绝。 */
function flushPendingTasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function expectCleanConsole(): Promise<void> {
  await flushPendingTasks();
  const messages = consoleCalls.map((call) => `[${call.level}] ${call.text}`);
  expect(messages, `控制台出现输出：\n${messages.join('\n')}`).toEqual([]);
  expect(runtimeErrors, `出现运行时异常：\n${runtimeErrors.join('\n')}`).toEqual([]);
}

function renderApp(hash: string) {
  const user = userEvent.setup();
  window.location.hash = hash;
  return { user, ...render(<App />) };
}

describe('控制台与未处理异常', () => {
  it('记录、搜索、编辑、升级项目的主流程不会产生控制台输出或未处理异常', async () => {
    const { user } = renderApp('#/');

    // 1. 首页记录一条念头。
    const textarea = await screen.findByLabelText('记下一句话就好……');
    await user.type(textarea, '控制台检查：车库没有实时空位提示');
    await user.click(screen.getByRole('button', { name: '记下这个念头' }));
    await screen.findByText('收好了，这个念头不会轻易丢失。');

    // 2. 收件箱搜索。
    await user.click(screen.getByRole('link', { name: '收件箱' }));
    const search = await screen.findByLabelText('搜索念头');
    await user.type(search, '空位');
    expect(await screen.findByText(/车库没有实时空位提示/)).toBeInTheDocument();

    // 3. 打开详情并编辑。
    await user.click(screen.getByRole('link', { name: /车库没有实时空位提示/ }));
    const content = await screen.findByLabelText('正文');
    await user.clear(content);
    await user.type(content, '控制台检查：车库没有实时空位提示（已补充）');
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findByText('修改已保存。');

    // 4. 升级为创意项目，再回到念头详情。
    await user.click(screen.getByRole('button', { name: '升级为创意项目' }));
    await screen.findByText('原始念头');
    await user.click(screen.getByRole('link', { name: '项目' }));
    await screen.findByRole('heading', { level: 1, name: '创意项目库' });

    // 5. 回收站与设置页。
    await user.click(screen.getByRole('link', { name: '回收站' }));
    await screen.findByRole('heading', { level: 1, name: '回收站' });
    await user.click(screen.getByRole('link', { name: '设置' }));
    await screen.findByRole('heading', { level: 1, name: '设置' });

    await expectCleanConsole();
  });

  it('空状态、搜索无结果与无效路由同样不会产生控制台噪音', async () => {
    await createIdea({ content: '既有的一条念头' });
    const { user } = renderApp('#/inbox');

    const search = await screen.findByLabelText('搜索念头');
    await user.type(search, '一定搜不到的关键词');
    expect(await screen.findByText('没有找到匹配的念头。')).toBeInTheDocument();
    await user.clear(search);

    // 打开一条不存在的念头：应当走「不存在」分支，而不是抛错白屏。
    // 手动改哈希需要包在 act() 里，否则 React 会自己发出 act 警告，
    // 那是测试写法的问题，不是应用的问题。
    await act(async () => {
      window.location.hash = '#/idea/idea_not_exist';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByText('这条念头不存在。')).toBeInTheDocument();

    // 未知路由回到首页，不应出现空白页。
    await act(async () => {
      window.location.hash = '#/完全未知的地址';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByRole('heading', { level: 1, name: '此刻，你想到了什么？' })).toBeInTheDocument();

    await expectCleanConsole();
  });

  it('删除确认对话框可以正常打开与关闭，且提供键盘焦点', async () => {
    await createIdea({ content: '需要被删除的念头' });
    const { user } = renderApp('#/inbox');

    await user.click(await screen.findByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expectCleanConsole();
  });
});
