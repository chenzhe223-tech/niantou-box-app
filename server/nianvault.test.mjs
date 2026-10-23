import { describe, expect, it } from 'vitest';

import {
  assertVaultOwner,
  canonicalVaultThought,
  vaultPathForIdea,
  vaultRepository,
} from './cloud-worker.js';

describe('NianVault canonical archive contract', () => {
  it('restricts the vault to one configured owner account', () => {
    expect(() => assertVaultOwner({ id: 'user-a' }, {})).toThrow(/尚未配置唯一所有者/);
    expect(() => assertVaultOwner({ id: 'user-b' }, { NIANVAULT_OWNER_USER_ID: 'user-a' })).toThrow(/仅授权给所有者/);
    expect(assertVaultOwner({ id: 'user-a' }, { NIANVAULT_OWNER_USER_ID: 'user-a' })).toBe(true);
  });
  it('maps existing NianBox categories to stable, non-title-based paths', () => {
    expect(vaultPathForIdea({ id: 'idea_123', category: 'app' })).toBe('thoughts/idea_123.json');
    expect(vaultPathForIdea({ id: 'idea_124', category: null })).toBe('thoughts/idea_124.json');
  });

  it('rejects unsafe identifiers rather than allowing path traversal', () => {
    expect(() => vaultPathForIdea({ id: '../private', category: 'app' })).toThrow();
    expect(() => vaultPathForIdea({ id: 'folder/name', category: 'app' })).toThrow();
  });

  it('maps the current camelCase Idea model to the versioned canonical document', () => {
    const idea = {
      id: 'idea_abc123',
      title: '念头库测试',
      content: '保留中文、emoji 🚀 和原始换行\n第二行。',
      category: 'skill',
      categorySource: 'manual',
      status: 'inbox',
      tags: ['AI', '灵感'],
      pinned: true,
      notes: '备注',
      problem: '要解决的问题',
      targetUsers: '普通用户',
      productForm: 'website',
      projectUrl: 'https://example.com/project',
      projectId: null,
      createdAt: 1792720800000,
      updatedAt: 1792720800001,
      deletedAt: null,
    };
    const result = canonicalVaultThought(idea, { id: 'user-secret-id' }, 'idea:idea_abc123:v1792720800001', 1792720800001);

    expect(result.schema_version).toBe(1);
    expect(result.id).toBe(idea.id);
    expect(result.content).toBe(idea.content);
    expect(result.category_source).toBe('manual');
    expect(result.target_users).toBe('普通用户');
    expect(result.created_at).toBe(idea.createdAt);
    expect(result.updated_at).toBe(idea.updatedAt);
    expect(result.source).toEqual({ app: 'nianbox', record_id: idea.id });
    expect(result.operation_id).toBe('idea:idea_abc123:v1792720800001');
    expect(result).not.toHaveProperty('owner_id');
  });

  it('accepts only owner/repository configuration, never a URL or extra path', () => {
    expect(vaultRepository({ NIANVAULT_REPO: 'DavyLab/nianvault' })).toBe('DavyLab/nianvault');
    expect(vaultRepository({ NIANVAULT_REPO: 'https://github.com/DavyLab/nianvault' })).toBe('');
    expect(vaultRepository({ NIANVAULT_REPO: 'owner/repo/extra' })).toBe('');
    expect(vaultRepository({ NIANVAULT_REPO: '' })).toBe('');
  });
});
