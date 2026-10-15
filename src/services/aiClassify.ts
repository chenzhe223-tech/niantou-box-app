/**
 * 念头自动分类（AI 优先，规则兜底）。
 *
 * 三条硬性约束：
 * 1. 分类永远发生在「原始内容已经保存成功」之后，是异步的附加动作。
 *    分类失败不会影响、也不会回滚已经保存的念头。
 * 2. 不覆盖用户的手动选择。用户自己改过分类（categorySource === 'manual'）
 *    时，自动结果只会被记录下来，不会改写他的选择——除非他主动点「重新分类」。
 * 3. 说话算数。服务端说这一条是「规则猜的」就显示规则，是「AI 想的」才显示 AI，
 *    不会把关键词匹配包装成人工智能。
 */

import type { Idea, IdeaCategory, IdeaCategorySource } from '../types/idea';
import { isIdeaCategory } from '../types/idea';
import { track } from './analytics';
import { getIdea, listIdeas, toNianBoxError, updateIdea } from './storage';
import { isCloudConfigured } from './cloud/cloudConfig';
import { cloudRequest, describeCloudError } from './cloud/cloudClient';
import { getCloudToken, isSignedIn } from './cloud/cloudAuth';

interface ClassifyResponse {
  configured?: boolean;
  category?: string;
  label?: string;
  source?: string;
  message?: string;
}

export interface ClassifyOutcome {
  status: 'applied' | 'skipped' | 'failed';
  category?: IdeaCategory;
  label?: string;
  source?: IdeaCategorySource;
  /** 给用户看的一句话说明（成功或失败原因）。 */
  message: string;
}

/** 自动分类是否可用：需要配置了云端地址并且已经登录。 */
export function canClassify(): boolean {
  return isCloudConfigured() && isSignedIn();
}

/**
 * 给一条念头重新分类。
 *
 * @param force 用户主动点「重新分类」时为 true，此时即使用户手改过分类也会覆盖。
 */
export async function classifyIdea(
  ideaId: string,
  options: { force?: boolean } = {},
): Promise<ClassifyOutcome> {
  if (!canClassify()) {
    return {
      status: 'skipped',
      message: '自动分类需要云端的分类服务，先登录云端账号就能用。',
    };
  }

  let idea: Idea | null = null;
  try {
    idea = await getIdea(ideaId);
  } catch (caught) {
    return { status: 'failed', message: toNianBoxError(caught).message };
  }
  if (!idea || idea.deletedAt !== null) {
    return { status: 'skipped', message: '这条念头已经不在收件箱里了。' };
  }

  if (!options.force && idea.categorySource === 'manual' && idea.category !== null) {
    return {
      status: 'skipped',
      message: '你手动选过分类，自动结果不会覆盖它。需要的话可以点「重新分类」。',
    };
  }

  const content = [idea.title, idea.content].filter((part) => part.trim() !== '').join('\n');

  let response: ClassifyResponse;
  try {
    response = await cloudRequest<ClassifyResponse>('/ai/classify', {
      method: 'POST',
      token: getCloudToken(),
      body: { content },
      // 分类是幂等读取，超时或 5xx 可以安全重试一次。
      retries: 1,
      timeoutMs: 20_000,
    });
  } catch (caught) {
    return { status: 'failed', message: `分类没有完成：${describeCloudError(caught)}` };
  }

  if (!isIdeaCategory(response?.category)) {
    return { status: 'failed', message: '分类没有完成：服务端没有返回可用的分类结果。' };
  }

  const source: IdeaCategorySource = response.source === 'ai' ? 'ai' : 'rules';

  // 内容可能在请求期间被改过：这时写回会覆盖新内容，直接放弃这次结果。
  let latest: Idea | null = null;
  try {
    latest = await getIdea(ideaId);
  } catch {
    return { status: 'failed', message: '分类结果没能写入：本机数据读取失败。' };
  }
  if (!latest || latest.content !== idea.content || latest.updatedAt !== idea.updatedAt) {
    return { status: 'skipped', message: '这条念头在分类期间被修改过，已跳过这次结果。' };
  }

  try {
    await updateIdea(ideaId, { category: response.category, categorySource: source });
  } catch (caught) {
    return { status: 'failed', message: `分类结果没能写入：${toNianBoxError(caught).message}` };
  }

  const label = typeof response.label === 'string' && response.label ? response.label : response.category;
  return {
    status: 'applied',
    category: response.category,
    label,
    source,
    message: source === 'ai' ? `AI 判断为「${label}」。` : `按关键词判断为「${label}」（暂未接入模型）。`,
  };
}

/**
 * 保存之后顺手指派一次分类：不阻塞界面，也不抛错。
 * 分类没成功不影响念头本身，用户随时可以手动改。
 */
export function classifyIdeaInBackground(
  ideaId: string,
  options: { force?: boolean; onDone?: (outcome: ClassifyOutcome) => void } = {},
): void {
  void classifyIdea(ideaId, { force: options.force })
    .then((outcome) => {
      options.onDone?.(outcome);
    })
    .catch(() => undefined);
}

/**
 * 一轮补分类最多处理多少条。
 *
 * 打开应用时可能一次冒出一批没分类的念头（旧设备迁移上来的、官网快速记录进来的），
 * 这里设一个上限，避免一次性把接口打满；剩下的下一轮继续。
 */
const BACKFILL_LIMIT = 12;

let backfillInFlight: Promise<number> | null = null;

/**
 * 给「还没有分类」的念头补一次分类。
 *
 * 首页写下的念头在保存时就会分类；这里兜住的是另外两条入口：
 * 旧设备迁移上云的念头、以及官网快速记录进收件箱的念头——它们都只有原文，没有分类。
 *
 * 三条约束：
 * 1. 只碰 `category === null` 的记录，用户手动选过分类的一条都不动。
 * 2. 同一时间只跑一轮，重复调用返回同一个 Promise。
 * 3. 任何失败都当作没发生——不抛错、不阻塞界面、不影响已保存的内容。
 */
export function classifyUncategorizedIdeas(options: { limit?: number } = {}): Promise<number> {
  if (!canClassify()) return Promise.resolve(0);
  if (backfillInFlight) return backfillInFlight;

  const limit = Math.max(0, options.limit ?? BACKFILL_LIMIT);
  const run = runBackfill(limit).finally(() => {
    backfillInFlight = null;
  });
  backfillInFlight = run;
  return run;
}

/** 仅供测试：清掉「正在跑」的标记，让用例之间互不影响。 */
export function resetCategoryBackfillForTests(): void {
  backfillInFlight = null;
}

async function runBackfill(limit: number): Promise<number> {
  if (limit === 0) return 0;

  let candidates: Idea[];
  try {
    const ideas = await listIdeas();
    candidates = ideas
      .filter((idea) => idea.deletedAt === null && idea.category === null)
      .slice(0, limit);
  } catch {
    return 0;
  }

  let applied = 0;
  for (const idea of candidates) {
    // 串行执行：个人数据量很小，串行能让结果顺序稳定，也不会并发打满接口。
    const outcome = await classifyIdea(idea.id);
    if (outcome.status === 'applied') applied += 1;
  }
  return applied;
}

/**
 * 把一次分类结果记进匿名统计。
 *
 * 只记「有没有用上 AI」「成功还是跳过」这类枚举值，不上报分类结果本身，
 * 也不上报念头内容——分类结果同样是用户的灵感。
 */
export function trackClassifyOutcome(outcome: ClassifyOutcome, source: 'home' | 'detail'): void {
  track('ai_classify_used', {
    source,
    via: outcome.status === 'applied' ? (outcome.source ?? 'none') : 'none',
    result: outcome.status === 'applied' ? 'ok' : outcome.status === 'skipped' ? 'skipped' : 'error',
  });
}
