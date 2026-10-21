import { getCloudToken, isSignedIn } from './cloud/cloudAuth';
import { cloudRequest, CloudError } from './cloud/cloudClient';
import { isCloudConfigured } from './cloud/cloudConfig';

export interface IdeaAnalysisPlan {
  id: 'free' | 'low_cost' | 'commercial';
  name: string;
  goal: string;
  architecture: string;
  costEstimate: string;
  timeline: string;
  tasks: string[];
  acceptance: string[];
  tradeoffs: string;
}

export interface IdeaAnalysis {
  summary: string;
  problem: string;
  targetUsers: string[];
  assumptions: string[];
  validation: string[];
  risks: string[];
  plans: IdeaAnalysisPlan[];
  nextStep: string;
  trendQueries: string[];
  skillQueries: string[];
  disclaimer: string;
}

export interface IdeaAnalysisResponse {
  configured: boolean;
  source?: 'ai';
  model?: string;
  generatedAt?: string;
  analysis?: IdeaAnalysis;
  code?: string;
  message?: string;
}

export interface IdeaAnalysisInput {
  title?: string;
  content: string;
  problem?: string;
  targetUsers?: string;
  productForm?: string | null;
}

export function canAnalyzeIdea(): boolean {
  return isCloudConfigured() && isSignedIn();
}

/**
 * Sends idea text only after the user explicitly activates the analysis action.
 * This endpoint is cloud AI: the selected text is sent to NianBox's Worker and
 * then to the configured model provider. The caller must disclose this first.
 */
export async function analyzeIdea(input: IdeaAnalysisInput): Promise<IdeaAnalysisResponse> {
  if (!canAnalyzeIdea()) {
    return {
      configured: false,
      code: 'NOT_READY',
      message: '请先登录念头盒云端账号，并确认当前版本已配置云端服务。',
    };
  }

  const content = input.content.trim();
  if (!content) {
    return { configured: false, code: 'EMPTY_CONTENT', message: '念头正文不能为空。' };
  }

  return cloudRequest<IdeaAnalysisResponse>('/ai/analyze', {
    method: 'POST',
    token: getCloudToken(),
    body: {
      title: input.title?.slice(0, 200) ?? '',
      content: content.slice(0, 2000),
      problem: input.problem?.slice(0, 800) ?? '',
      targetUsers: input.targetUsers?.slice(0, 300) ?? '',
      productForm: input.productForm ?? 'other',
    },
    timeoutMs: 75_000,
    retries: 0,
  });
}

export function buildIdeaAnalysisTaskPack(
  analysis: IdeaAnalysis,
  selectedPlan: IdeaAnalysisPlan,
  idea: Pick<IdeaAnalysisInput, 'title' | 'content'>,
): string {
  return [
    '# 念头盒 AI 开发任务包',
    '',
    '## 原始念头',
    idea.title?.trim() ? `标题：${idea.title.trim()}` : '',
    idea.content.trim(),
    '',
    '## 分析结论',
    analysis.summary,
    `核心问题：${analysis.problem}`,
    analysis.targetUsers.length ? `目标用户：${analysis.targetUsers.join('、')}` : '',
    '',
    `## 选定方案：${selectedPlan.name}`,
    `目标：${selectedPlan.goal}`,
    `建议架构：${selectedPlan.architecture}`,
    `成本估算：${selectedPlan.costEstimate}`,
    `周期估算：${selectedPlan.timeline}`,
    '',
    '### 开发任务',
    ...selectedPlan.tasks.map((task, index) => `${index + 1}. ${task}`),
    '',
    '### 验收标准',
    ...selectedPlan.acceptance.map((item) => `- [ ] ${item}`),
    '',
    '## 风险与待验证假设',
    ...analysis.risks.map((item) => `- 风险：${item}`),
    ...analysis.assumptions.map((item) => `- 假设：${item}`),
    '',
    '## 下一步',
    analysis.nextStep,
    '',
    '请先检查仓库当前结构和现有测试，再按最小增量实现。不要覆盖原始用户数据，不要把密钥写进前端或提交到仓库。先列出计划，再逐项修改；运行类型检查、相关测试和生产构建，并报告真实结果。任何未实际验证的行为都必须明确标为待验证。',
    '',
    analysis.disclaimer,
  ].filter((line) => line !== undefined).join('\n').trim();
}

export function describeIdeaAnalysisError(error: unknown): string {
  if (error instanceof CloudError) return error.message;
  if (error instanceof Error) return error.message;
  return '分析暂时失败，请稍后重试。原始念头没有被修改。';
}
