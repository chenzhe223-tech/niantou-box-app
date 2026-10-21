import { describe, expect, it } from 'vitest';
import { buildIdeaAnalysisTaskPack, type IdeaAnalysis, type IdeaAnalysisPlan } from './ideaAnalysis';

const plan: IdeaAnalysisPlan = {
  id: 'low_cost',
  name: '最低成本实用版',
  goal: '验证核心价值',
  architecture: 'GitHub Pages + Cloudflare Worker',
  costEstimate: '粗略估算：每月 100-800 元，需按实际用量复核',
  timeline: '粗略估算：2-4 周',
  tasks: ['实现最小闭环', '补充自动化测试'],
  acceptance: ['离线保存不受影响', '权限隔离测试通过'],
  tradeoffs: '需要监控模型调用成本。',
};

const analysis: IdeaAnalysis = {
  summary: '帮助普通人把想法转成可验证的产品。',
  problem: '从想法到执行的路径不清楚。',
  targetUsers: ['非程序员'],
  assumptions: ['用户愿意按步骤验证'],
  validation: ['访谈目标用户'],
  risks: ['需求尚未验证'],
  plans: [plan, { ...plan, id: 'free', name: '免费验证版' }, { ...plan, id: 'commercial', name: '商业化版本' }],
  nextStep: '先找 3 位用户访谈。',
  trendQueries: ['AI 创作工具'],
  skillQueries: ['AI app builder'],
  disclaimer: 'AI 初步分析，需进一步验证。',
};

describe('buildIdeaAnalysisTaskPack', () => {
  it('includes the original idea, selected plan, tasks, acceptance checks and safety instructions', () => {
    const pack = buildIdeaAnalysisTaskPack(analysis, plan, {
      title: '点子助手',
      content: '帮没有编程经验的人把想法做成 App。',
    });
    expect(pack).toContain('帮没有编程经验的人把想法做成 App。');
    expect(pack).toContain('最低成本实用版');
    expect(pack).toContain('实现最小闭环');
    expect(pack).toContain('- [ ] 权限隔离测试通过');
    expect(pack).toContain('不要把密钥写进前端');
  });

  it('does not depend on optional title', () => {
    const pack = buildIdeaAnalysisTaskPack(analysis, plan, { content: '原始念头' });
    expect(pack).toContain('原始念头');
    expect(pack).not.toContain('标题：undefined');
  });
});
