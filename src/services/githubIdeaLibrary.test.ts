import { describe, expect, it } from 'vitest';
import { buildPlatformPrompts, parseGitHubRepositoryUrl } from './githubIdeaLibrary';

describe('parseGitHubRepositoryUrl', () => {
  it('normalizes a GitHub repository URL and removes a .git suffix', () => {
    expect(parseGitHubRepositoryUrl(' https://github.com/DavyLab/nian-ideas.git ')).toEqual({
      owner: 'DavyLab',
      repo: 'nian-ideas',
      repositoryUrl: 'https://github.com/DavyLab/nian-ideas',
    });
  });

  it('rejects file URLs and non-GitHub hosts', () => {
    expect(() => parseGitHubRepositoryUrl('https://github.com/DavyLab/nian-ideas/blob/main/README.md')).toThrow(
      '请输入仓库主页地址',
    );
    expect(() => parseGitHubRepositoryUrl('https://example.com/DavyLab/nian-ideas')).toThrow(
      '当前仅支持 github.com',
    );
  });
});

describe('buildPlatformPrompts', () => {
  it('creates distinct start instructions for all supported AI platforms and respects the configured branch', () => {
    const prompts = buildPlatformPrompts(
      'https://github.com/DavyLab/nian-ideas',
      'projects/念头项目/README.md',
      '念头项目',
      'release/2026',
    );
    expect(prompts.ChatGPT).toContain('https://github.com/DavyLab/nian-ideas/blob/release%2F2026/projects/%E5%BF%B5%E5%A4%B4%E9%A1%B9%E7%9B%AE/README.md');
    expect(prompts.Codex).toContain('当前工作区启动');
    expect(prompts.WorkBuddy).toContain('持续执行的开发任务');
    expect(prompts.ChatGPT).toContain('不要假装已经读过');
  });
});
