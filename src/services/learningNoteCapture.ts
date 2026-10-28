/**
 * Import AI Field Notes learning captures handed over from the learning dashboard.
 * The dashboard and NianBox must share the same origin for localStorage handoff.
 * Queue items are removed only after the local IndexedDB write succeeds.
 */
import { createIdea, listIdeas } from './storage';
import type { NewIdeaInput } from '../types/idea';

export const LEARNING_NOTE_QUEUE_KEY = 'nb.learning.pending-note.v1';
const MARKER_PREFIX = '[ai-field-notes-capture:';
const SOURCE = 'ai-field-notes';

interface PendingLearningNote {
  id: string;
  source: string;
  createdAt: number;
  title: string;
  content: string;
  tags?: string[];
}

function localStorageSafe(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function normalize(value: unknown): PendingLearningNote | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PendingLearningNote>;
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 180) : '';
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 220) : '';
  const content = typeof raw.content === 'string' ? raw.content.trim().slice(0, 12000) : '';
  if (!id.startsWith('ai-field-notes-') || raw.source !== SOURCE || !title || !content) return null;
  return {
    id,
    source: SOURCE,
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    title,
    content,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8) : [],
  };
}

function marker(id: string): string { return MARKER_PREFIX + id + ']'; }

export async function importPendingLearningNotes(): Promise<{ imported: number; duplicates: number; rejected: number; failed: number }> {
  const store = localStorageSafe();
  const result = { imported: 0, duplicates: 0, rejected: 0, failed: 0 };
  if (!store) return result;
  const raw = store.getItem(LEARNING_NOTE_QUEUE_KEY);
  if (!raw) return result;

  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch {
    store.removeItem(LEARNING_NOTE_QUEUE_KEY);
    result.rejected = 1;
    return result;
  }
  if (!Array.isArray(decoded)) {
    store.removeItem(LEARNING_NOTE_QUEUE_KEY);
    result.rejected = 1;
    return result;
  }

  const existing = await listIdeas({ includeDeleted: true });
  const existingMarkers = new Set(existing.flatMap((idea) => {
    const match = idea.notes.match(/\\[ai-field-notes-capture:[^\\]]+\\]/);
    return match ? [match[0]] : [];
  }));
  const remaining: unknown[] = [];

  for (const item of decoded) {
    const capture = normalize(item);
    if (!capture) { result.rejected += 1; continue; }
    const captureMarker = marker(capture.id);
    if (existingMarkers.has(captureMarker)) {
      result.duplicates += 1;
      continue;
    }

    const input: NewIdeaInput = {
      title: capture.title,
      content: capture.content,
      category: 'other',
      status: 'inbox',
      tags: [...new Set(['AI学习', '知识卡片', ...(capture.tags ?? [])])].slice(0, 8),
      notes: ['来源：AI Field Notes 学习看板', captureMarker, '收录时间：' + new Date(capture.createdAt).toISOString()].join('\n'),
    };
    try {
      await createIdea(input);
      result.imported += 1;
      existingMarkers.add(captureMarker);
    } catch {
      result.failed += 1;
      remaining.push(item);
    }
  }

  if (remaining.length) store.setItem(LEARNING_NOTE_QUEUE_KEY, JSON.stringify(remaining));
  else store.removeItem(LEARNING_NOTE_QUEUE_KEY);
  return result;
}
