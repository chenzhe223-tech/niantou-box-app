/**
 * Import Skill captures handed over from DAVYLAB AI Brief.
 * Both sites share the same github.io origin, so explicit user clicks can hand
 * over a localStorage queue without a new API. Queue items are removed only
 * after the local IndexedDB write succeeds (or a prior import is detected).
 */
import { createIdea, listIdeas } from './storage';
import type { NewIdeaInput } from '../types/idea';

export const RADAR_SKILL_QUEUE_KEY = 'nb.radar.pending-skill.v1';
const CAPTURE_MARKER_PREFIX = '[radar-skill-capture:';
const CAPTURE_SOURCE = 'davy-radar';

export interface PendingRadarSkillCapture {
  id: string;
  source: string;
  createdAt: number;
  reportDate?: string;
  name: string;
  url: string;
  description?: string;
  topics?: string;
  sourcePage?: string;
}

export interface RadarSkillImportResult {
  imported: number;
  duplicates: number;
  rejected: number;
  failed: number;
  remaining: number;
}

function localStorageSafe(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isReportDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeCapture(value: unknown): PendingRadarSkillCapture | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PendingRadarSkillCapture>;
  const id = nonEmptyString(raw.id, 180);
  const source = nonEmptyString(raw.source, 40);
  const name = nonEmptyString(raw.name, 180);
  const url = nonEmptyString(raw.url, 1000);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  if (
    !id.startsWith('davy-radar-') ||
    source !== CAPTURE_SOURCE ||
    !name ||
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.hostname !== 'github.com' ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.pathname.split('/').filter(Boolean).length < 2
  ) {
    return null;
  }

  const sourcePage = nonEmptyString(raw.sourcePage, 1000);
  let safeSourcePage = '';
  try {
    const parsedSource = new URL(sourcePage);
    if (
      parsedSource.protocol === 'https:' &&
      parsedSource.hostname === 'chenzhe223-tech.github.io' &&
      parsedSource.pathname.startsWith('/radar/daily')
    ) {
      safeSourcePage = parsedSource.href;
    }
  } catch {
    // Optional attribution. The project URL remains the primary source.
  }

  return {
    id,
    source,
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : Date.now(),
    reportDate: isReportDate(raw.reportDate) ? raw.reportDate : undefined,
    name,
    url: parsedUrl.href.replace(/\/$/, ''),
    description: nonEmptyString(raw.description, 2400),
    topics: nonEmptyString(raw.topics, 500),
    sourcePage: safeSourcePage,
  };
}

function captureMarker(id: string): string {
  return CAPTURE_MARKER_PREFIX + id + ']';
}

function createIdeaInput(capture: PendingRadarSkillCapture): NewIdeaInput {
  const topics = (capture.topics || '')
    .split(/[·,，|]/)
    .map((topic) => topic.trim())
    .filter(Boolean)
    .slice(0, 5);
  const tags = [...new Set(['AI简报收藏', 'Skill', ...topics])]
    .map((tag) => tag.slice(0, 40))
    .slice(0, 7);
  const description = capture.description || '来自开源社区推荐列表的 Skill 项目，打开 GitHub 仓库查看功能、使用方式与安装要求。';
  const reportLine = capture.reportDate ? '简报日期：' + capture.reportDate : '简报日期：未注明';
  const sourceLine = capture.sourcePage
    ? '简报来源：' + capture.sourcePage
    : '简报来源：DAVYLAB AI 前沿新闻简报';
  const content = [
    'Skill：' + capture.name,
    '',
    description,
    '',
    '项目链接：' + capture.url,
    topics.length ? '主题：' + topics.join(' · ') : '主题：Skill / 自动化',
    reportLine,
    sourceLine,
  ].join('\n');

  return {
    title: ('Skill：' + capture.name).slice(0, 220),
    content,
    category: 'skill',
    status: 'research',
    tags,
    productForm: 'skill',
    projectUrl: capture.url,
    notes: [
      '来源：DAVYLAB AI 前沿新闻简报',
      reportLine,
      sourceLine,
      captureMarker(capture.id),
    ].join('\n'),
  };
}

/**
 * Consume pending captures. Failed local writes remain queued for another try.
 */
export async function importPendingRadarSkills(): Promise<RadarSkillImportResult> {
  const store = localStorageSafe();
  const result: RadarSkillImportResult = {
    imported: 0,
    duplicates: 0,
    rejected: 0,
    failed: 0,
    remaining: 0,
  };
  if (!store) return result;

  const raw = store.getItem(RADAR_SKILL_QUEUE_KEY);
  if (!raw) return result;

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    store.removeItem(RADAR_SKILL_QUEUE_KEY);
    result.rejected = 1;
    return result;
  }
  if (!Array.isArray(decoded)) {
    store.removeItem(RADAR_SKILL_QUEUE_KEY);
    result.rejected = 1;
    return result;
  }
  if (decoded.length === 0) {
    store.removeItem(RADAR_SKILL_QUEUE_KEY);
    return result;
  }

  const normalized: PendingRadarSkillCapture[] = [];
  for (const item of decoded) {
    const capture = normalizeCapture(item);
    if (capture) normalized.push(capture);
    else result.rejected += 1;
  }
  if (normalized.length === 0) {
    store.removeItem(RADAR_SKILL_QUEUE_KEY);
    return result;
  }

  // Include deleted records, so a stale queue item does not recreate a Skill a
  // user intentionally removed. The marker also handles interrupted queue cleanup.
  const existing = await listIdeas({ includeDeleted: true, sort: 'updatedAt' });
  const completedIds = new Set<string>();

  for (const capture of normalized) {
    const marker = captureMarker(capture.id);
    if (existing.some((idea) => idea.notes.includes(marker))) {
      completedIds.add(capture.id);
      result.duplicates += 1;
      continue;
    }

    try {
      const created = await createIdea(createIdeaInput(capture));
      existing.push(created);
      completedIds.add(capture.id);
      result.imported += 1;
    } catch {
      // The item remains queued; never claim it was saved.
      result.failed += 1;
    }
  }

  // Merge against the current queue so a click from another tab during import
  // is not erased by writing an old snapshot back to localStorage.
  const currentRaw = store.getItem(RADAR_SKILL_QUEUE_KEY);
  let currentQueue: unknown[] = [];
  try {
    const current = currentRaw ? JSON.parse(currentRaw) as unknown : [];
    if (Array.isArray(current)) currentQueue = current;
  } catch {
    currentQueue = [];
  }
  const remaining = currentQueue.filter((item) => {
    const capture = normalizeCapture(item);
    return capture !== null && !completedIds.has(capture.id);
  });

  if (remaining.length > 0) {
    store.setItem(RADAR_SKILL_QUEUE_KEY, JSON.stringify(remaining));
  } else {
    store.removeItem(RADAR_SKILL_QUEUE_KEY);
  }
  result.remaining = remaining.length;
  return result;
}
