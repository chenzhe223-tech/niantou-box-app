import { describe, expect, it } from 'vitest';
import { validateIdeaAnalysis } from './cloud-worker.js';

function validAnalysis() {
  return {
    summary: '把停车找位过程做得更省心。',
    problem: '用户进入停车场后难以找到空位。',
    targetUsers: ['开车通勤者'],
    assumptions: ['用户愿意主动反馈空位'],
    validation: ['先访谈 5 位司机'],
    risks: ['停车数据可能不够及时'],
    plans: [
      {
        id: 'free', name: '免费验证版', goal: '验证需求',
        architecture: '可点击原型和人工记录', costEstimate: '估算：0-100 元，不含人工',
        timeline: '估算：3-5 天', tasks: ['制作原型'], acceptance: ['完成 5 次访谈'],
        tradeoffs: '需要人工整理数据',
      },
      {
        id: 'low_cost', name: '最低成本实用版', goal: '验证核心流程',
        architecture: 'GitHub Pages + Cloudflare Worker', costEstimate: '估算：按免费额度起步',
        timeline: '估算：2-4 周', tasks: ['建立最小数据流'], acceptance: ['核心流程可重复操作'],
        tradeoffs: '需要控制外部 API 调用',
      },
      {
        id: 'commercial', name: '商业化版本', goal: '支持持续运营',
        architecture: '账号、权限、监控与计费', costEstimate: '估算：需按实际用量核算',
        timeline: '估算：6-12 周', tasks: ['设计配额'], acceptance: ['权限隔离测试通过'],
        tradeoffs: '运维与安全成本更高',
      },
    ],
    nextStep: '先与 5 位目标用户聊聊。',
    trendQueries: ['停车场空位识别'],
    skillQueries: ['parking occupancy detection'],
  };
}

describe('validateIdeaAnalysis', () => {
  it('accepts exactly three complete and distinct plan slots', () => {
    const result = validateIdeaAnalysis(validAnalysis());
    expect(result).not.toBeNull();
    expect(result.plans.map((plan) => plan.id)).toEqual(['free', 'low_cost', 'commercial']);
    expect(result.disclaimer).toContain('不代表市场需求已被验证');
  });

  it('rejects missing plans and incomplete required fields', () => {
    const missingPlan = validAnalysis();
    missingPlan.plans = missingPlan.plans.filter((plan) => plan.id !== 'commercial');
    expect(validateIdeaAnalysis(missingPlan)).toBeNull();

    const incomplete = validAnalysis();
    incomplete.plans[0].acceptance = [];
    expect(validateIdeaAnalysis(incomplete)).toBeNull();
  });

  it('sanitizes optional list fields and ignores non-string items', () => {
    const value = validAnalysis();
    value.risks = ['风险一', 42, '风险二'];
    const result = validateIdeaAnalysis(value);
    expect(result?.risks).toEqual(['风险一', '风险二']);
  });

  it('rejects non-object or empty model output', () => {
    expect(validateIdeaAnalysis(null)).toBeNull();
    expect(validateIdeaAnalysis('not json')).toBeNull();
    expect(validateIdeaAnalysis([])).toBeNull();
  });
});
