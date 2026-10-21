export const RADAR_LATEST_URL = 'https://chenzhe223-tech.github.io/radar/data/latest.json';

export interface RadarNewsItem {
  title: string;
  titleZh?: string;
  summary: string;
  source: string;
  url: string;
  published?: string;
  reportDate: string;
  score: number;
  matchedBy: string[];
}

export interface RadarSkillItem {
  name: string;
  description: string;
  url: string;
  stars?: number;
  updated?: string;
  language?: string;
  topics: string[];
  reportDate: string;
  score: number;
  matchedBy: string[];
}

export interface RadarMatchResult {
  reportDate: string;
  generatedAt: string;
  status: string;
  stale: boolean;
  newsMatches: RadarNewsItem[];
  skillMatches: RadarSkillItem[];
  message?: string;
}

interface RadarPayload {
  report_date?: unknown;
  generated_at?: unknown;
  status?: unknown;
  news?: unknown;
  top5?: unknown;
  skills?: unknown;
}

function safeHttpsUrl(value: unknown, allowedHost?: string): string {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    if (allowedHost && url.hostname !== allowedHost) return '';
    return url.href;
  } catch {
    return '';
  }
}

function clean(value: unknown, max = 1200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function tokenize(value: string): string[] {
  const text = value.toLocaleLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const latin = text.split(/\s+/).filter((token) => token.length >= 2 && !/^\d+$/.test(token));
  const chinese = text.replace(/\s/g, '');
  const cjk: string[] = [];
  for (let i = 0; i < chinese.length; i += 1) {
    if (/\p{Script=Han}/u.test(chinese[i])) {
      cjk.push(chinese[i]);
      if (i + 1 < chinese.length && /\p{Script=Han}/u.test(chinese[i + 1])) cjk.push(chinese.slice(i, i + 2));
    }
  }
  return [...new Set([...latin, ...cjk])].filter((token) => token.length >= 2);
}

function scoreRecord(queries: string[], haystack: string): { score: number; matchedBy: string[] } {
  const normalizedHaystack = haystack.toLocaleLowerCase();
  const haystackTokens = new Set(tokenize(haystack));
  const matchedBy: string[] = [];
  let score = 0;
  for (const rawQuery of queries) {
    const query = clean(rawQuery, 100).toLocaleLowerCase();
    if (!query) continue;
    if (normalizedHaystack.includes(query)) {
      score += 5;
      matchedBy.push(rawQuery);
      continue;
    }
    const tokens = tokenize(query);
    const hits = tokens.filter((token) => haystackTokens.has(token));
    if (hits.length > 0) {
      score += Math.min(4, hits.length * 2);
      matchedBy.push(rawQuery);
    }
  }
  return { score, matchedBy: [...new Set(matchedBy)] };
}

function isFreshTimestamp(value: string, now: number): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now + 5 * 60_000 && now - parsed <= 72 * 60 * 60_000;
}

function validateNews(value: unknown, reportDate: string): RadarNewsItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const url = safeHttpsUrl(item.url);
    const title = clean(item.title, 240);
    const source = clean(item.source, 100);
    if (!url || !title || !source) return [];
    return [{
      title,
      titleZh: clean(item.title_zh, 240) || undefined,
      summary: clean(item.summary_zh, 1200) || clean(item.summary, 1200),
      source,
      url,
      published: clean(item.published, 80) || undefined,
      reportDate,
      score: 0,
      matchedBy: [],
    }];
  });
}

function validateSkills(value: unknown, reportDate: string): RadarSkillItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const url = safeHttpsUrl(item.url, 'github.com');
    const name = clean(item.name, 180);
    if (!url || !name || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/i.test(url)) return [];
    const topics = Array.isArray(item.topics)
      ? item.topics.filter((topic): topic is string => typeof topic === 'string').map((topic) => topic.slice(0, 80)).slice(0, 20)
      : [];
    return [{
      name,
      description: clean(item.description_zh, 800) || clean(item.description, 800),
      url: url.replace(/\/$/, ''),
      stars: typeof item.stars === 'number' && Number.isFinite(item.stars) && item.stars >= 0 ? item.stars : undefined,
      updated: clean(item.updated, 80) || undefined,
      language: clean(item.language, 80) || undefined,
      topics,
      reportDate,
      score: 0,
      matchedBy: [],
    }];
  });
}

export async function loadRadarMatches(
  trendQueries: string[],
  skillQueries: string[],
  options: { fetcher?: typeof fetch; now?: number; url?: string } = {},
): Promise<RadarMatchResult> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now();
  const response = await fetcher(options.url ?? RADAR_LATEST_URL, {
    method: 'GET',
    headers: { accept: 'application/json' },
    cache: 'no-cache',
  });
  if (!response.ok) throw new Error(`AI 简报数据暂不可用（HTTP ${response.status}）。`);
  const payload = await response.json() as RadarPayload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('AI 简报数据格式不正确。');
  }

  const reportDate = clean(payload.report_date, 20);
  const generatedAt = clean(payload.generated_at, 80);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || !generatedAt) {
    throw new Error('AI 简报缺少有效的日期或更新时间，已停止匹配。');
  }
  const status = clean(payload.status, 40) || 'unknown';
  const stale = !isFreshTimestamp(generatedAt, now);
  const newsQueries = trendQueries.filter(Boolean).slice(0, 4);
  const skillsQueryList = skillQueries.filter(Boolean).slice(0, 4);

  const newsMatches = validateNews(payload.news, reportDate)
    .map((item) => {
      const scored = scoreRecord(newsQueries, [item.title, item.titleZh, item.summary, item.source].filter(Boolean).join(' '));
      return { ...item, ...scored };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.published || '') - Date.parse(a.published || ''))
    .slice(0, 5);

  const skillMatches = validateSkills(payload.skills, reportDate)
    .map((item) => {
      const scored = scoreRecord(skillsQueryList, [item.name, item.description, item.language, ...item.topics].filter(Boolean).join(' '));
      return { ...item, ...scored };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || (b.stars ?? 0) - (a.stars ?? 0))
    .slice(0, 5);

  return {
    reportDate,
    generatedAt,
    status,
    stale,
    newsMatches,
    skillMatches,
    ...(status !== 'ok' ? { message: '简报当前状态不是 ok，请核对来源与更新时间后再参考。' } : {}),
  };
}
