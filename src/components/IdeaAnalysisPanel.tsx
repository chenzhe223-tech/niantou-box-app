import { useEffect, useState } from 'react';
import type { Idea } from '../types/idea';
import { Button } from './Button';
import { copyText } from '../services/aiTools';
import {
  analyzeIdea,
  buildIdeaAnalysisTaskPack,
  canAnalyzeIdea,
  describeIdeaAnalysisError,
  type IdeaAnalysis,
  type IdeaAnalysisPlan,
} from '../services/ideaAnalysis';
import { loadRadarMatches, type RadarMatchResult } from '../services/radarMatches';

const PLAN_ORDER: IdeaAnalysisPlan['id'][] = ['free', 'low_cost', 'commercial'];

export function IdeaAnalysisPanel({ idea }: { idea: Idea }) {
  const [analysis, setAnalysis] = useState<IdeaAnalysis | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<IdeaAnalysisPlan['id']>('low_cost');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [radar, setRadar] = useState<RadarMatchResult | null>(null);
  const [radarLoading, setRadarLoading] = useState(false);
  const [radarError, setRadarError] = useState('');

  const ready = canAnalyzeIdea();
  const selectedPlan = analysis?.plans.find((plan) => plan.id === selectedPlanId) ?? null;

  useEffect(() => {
    if (!analysis) {
      setRadar(null);
      setRadarError('');
      return;
    }
    let active = true;
    setRadarLoading(true);
    setRadarError('');
    void loadRadarMatches(analysis.trendQueries, analysis.skillQueries)
      .then((result) => {
        if (active) setRadar(result);
      })
      .catch((caught: unknown) => {
        if (active) setRadarError(caught instanceof Error ? caught.message : 'AI 简报匹配暂时不可用。');
      })
      .finally(() => {
        if (active) setRadarLoading(false);
      });
    return () => {
      active = false;
    };
  }, [analysis]);

  const handleAnalyze = async () => {
    if (loading) return;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const result = await analyzeIdea({
        title: idea.title,
        content: idea.content,
        problem: idea.problem,
        targetUsers: idea.targetUsers,
        productForm: idea.productForm,
      });
      if (!result.configured || !result.analysis) {
        setError(result.message || '分析暂时不可用，请稍后重试。');
        return;
      }
      setAnalysis(result.analysis);
      setSelectedPlanId('low_cost');
      setNotice(result.model ? `分析完成 · ${result.model}` : '分析完成');
    } catch (caught) {
      setError(describeIdeaAnalysisError(caught));
    } finally {
      setLoading(false);
    }
  };

  const handleCopyTaskPack = async () => {
    if (!analysis || !selectedPlan) return;
    const copied = await copyText(buildIdeaAnalysisTaskPack(analysis, selectedPlan, idea));
    setNotice(copied ? '开发任务包已复制，可以粘贴到你使用的 AI 编程工具。' : '复制失败，请稍后重试。');
  };

  return (
    <section className="nb-section nb-analysis" aria-labelledby="nb-analysis-title">
      <div className="nb-section__head">
        <h2 className="nb-section__title" id="nb-analysis-title">把这个念头变成可执行方案</h2>
      </div>
      <div className="nb-card nb-card--pad nb-stack">
        <p className="nb-analysis__intro">
          不只做分类。一起梳理要解决的问题、值得验证的假设，并比较三种落地路径。
        </p>
        <div className="nb-analysis__privacy" role="note">
          <strong>发送前请确认：</strong>
          点击下方按钮后，这条念头的标题、正文及你已填写的问题、目标用户等信息会发送到念头盒云端，再交给当前配置的 AI 模型分析。请勿提交不适合发送给云端服务的敏感信息。分析结果不会自动覆盖原始念头。
        </div>
        {!ready ? (
          <p className="nb-notice">
            需要登录云端账号且配置好 AI 服务后，才能在念头盒内分析。你仍可以继续保存念头，或使用「交给 AI 工具」自行选择平台。
          </p>
        ) : null}
        <Button
          variant="primary"
          block
          icon="sparkle"
          disabled={!ready || loading}
          onClick={() => void handleAnalyze()}
        >
          {loading ? '正在分析，请稍候…' : '我已了解数据发送范围，开始 AI 分析'}
        </Button>
        {error ? <p className="nb-notice nb-notice--danger" role="alert">{error}</p> : null}
        {notice ? <p className="nb-analysis__notice" role="status">{notice}</p> : null}
      </div>

      {analysis ? (
        <div className="nb-stack">
          <div className="nb-card nb-card--pad nb-stack">
            <div>
              <span className="nb-analysis__eyebrow">01 / 念头理解</span>
              <h3 className="nb-analysis__heading">你真正想解决什么？</h3>
            </div>
            <p>{analysis.summary}</p>
            <p><strong>核心问题：</strong>{analysis.problem}</p>
            {analysis.targetUsers.length ? <p><strong>可能的目标用户：</strong>{analysis.targetUsers.join('、')}</p> : null}
            {analysis.assumptions.length ? (
              <div><strong>需要验证的假设</strong><ul>{analysis.assumptions.map((item, i) => <li key={i}>{item}</li>)}</ul></div>
            ) : null}
            {analysis.validation.length ? (
              <div><strong>低成本验证方式</strong><ul>{analysis.validation.map((item, i) => <li key={i}>{item}</li>)}</ul></div>
            ) : null}
            {analysis.risks.length ? (
              <div><strong>需要留意的风险</strong><ul>{analysis.risks.map((item, i) => <li key={i}>{item}</li>)}</ul></div>
            ) : null}
          </div>

          <div className="nb-card nb-card--pad nb-stack">
            <div>
              <span className="nb-analysis__eyebrow">02 / 三种落地路径</span>
              <h3 className="nb-analysis__heading">先选适合自己的方式</h3>
            </div>
            <div className="nb-analysis__plans" role="group" aria-label="选择开发方案">
              {PLAN_ORDER.map((id) => {
                const plan = analysis.plans.find((item) => item.id === id);
                if (!plan) return null;
                return (
                  <button
                    type="button"
                    key={id}
                    className={selectedPlanId === id ? 'nb-analysis__plan nb-analysis__plan--selected' : 'nb-analysis__plan'}
                    aria-pressed={selectedPlanId === id}
                    onClick={() => setSelectedPlanId(id)}
                  >
                    <span className="nb-analysis__plan-name">{plan.name}</span>
                    <span className="nb-analysis__plan-cost">{plan.costEstimate}</span>
                    <span className="nb-analysis__plan-time">{plan.timeline}</span>
                  </button>
                );
              })}
            </div>
            {selectedPlan ? (
              <div className="nb-analysis__plan-detail">
                <h4>{selectedPlan.name}</h4>
                <p>{selectedPlan.goal}</p>
                <p><strong>建议架构：</strong>{selectedPlan.architecture}</p>
                <p><strong>成本估算：</strong>{selectedPlan.costEstimate}</p>
                <p><strong>周期估算：</strong>{selectedPlan.timeline}</p>
                <div><strong>实施任务</strong><ol>{selectedPlan.tasks.map((task, i) => <li key={i}>{task}</li>)}</ol></div>
                <div><strong>验收标准</strong><ul>{selectedPlan.acceptance.map((item, i) => <li key={i}>{item}</li>)}</ul></div>
                <p><strong>取舍：</strong>{selectedPlan.tradeoffs}</p>
                <Button block variant="secondary" onClick={() => void handleCopyTaskPack()}>
                  复制这套方案的开发任务包
                </Button>
              </div>
            ) : null}
          </div>

          {(analysis.trendQueries.length > 0 || analysis.skillQueries.length > 0) ? (
            <div className="nb-card nb-card--pad nb-stack">
              <div>
                <span className="nb-analysis__eyebrow">03 / 下一步研究线索</span>
                <h3 className="nb-analysis__heading">趋势与 Skills 匹配</h3>
              </div>
              <p className="nb-analysis__hint">以下匹配来自 DAVYLAB AI 前沿简报的公开数据。相关性是关键词初筛，不代表新闻结论已独立验证，也不代表 Skill 已完成安全审计。</p>
              {radarLoading ? <p className="nb-analysis__hint" role="status">正在读取最新简报并匹配……</p> : null}
              {radarError ? <p className="nb-notice" role="status">{radarError} 你仍可以参考上方分析和开发任务包。</p> : null}
              {radar ? (
                <>
                  <p className="nb-analysis__hint">
                    简报日期：{radar.reportDate} · 数据生成：{new Date(radar.generatedAt).toLocaleString()}
                  </p>
                  {radar.stale ? <p className="nb-notice">简报数据可能已超过 72 小时或时间异常，请先打开原始来源核对。</p> : null}
                  {radar.status !== 'ok' ? <p className="nb-notice">{radar.message || '简报状态异常，请谨慎参考。'}</p> : null}
                  <div className="nb-analysis__match-group">
                    <h4>相关 AI 新闻</h4>
                    {radar.newsMatches.length ? (
                      <ul className="nb-analysis__match-list">
                        {radar.newsMatches.map((item) => (
                          <li key={item.url}>
                            <a href={item.url} target="_blank" rel="noopener noreferrer">{item.titleZh || item.title}</a>
                            <span className="nb-analysis__match-meta">{item.source}{item.published ? ` · ${item.published}` : ''}</span>
                            {item.summary ? <p>{item.summary}</p> : null}
                            <span className="nb-analysis__match-meta">匹配线索：{item.matchedBy.join('、')}</span>
                          </li>
                        ))}
                      </ul>
                    ) : <p className="nb-analysis__hint">当前简报中没有找到足够相关的新闻，不会用无关内容填充结果。</p>}
                  </div>
                  <div className="nb-analysis__match-group">
                    <h4>相关 Skills</h4>
                    {radar.skillMatches.length ? (
                      <ul className="nb-analysis__match-list">
                        {radar.skillMatches.map((item) => (
                          <li key={item.url}>
                            <a href={item.url} target="_blank" rel="noopener noreferrer">{item.name}</a>
                            {typeof item.stars === 'number' ? <span className="nb-analysis__match-meta"> · {item.stars.toLocaleString()} stars</span> : null}
                            {item.description ? <p>{item.description}</p> : null}
                            <span className="nb-analysis__match-meta">匹配线索：{item.matchedBy.join('、')}</span>
                            <span className="nb-analysis__match-meta">仅完成简报元数据匹配；使用前仍需检查许可证、依赖、权限、网络访问和源代码。</span>
                          </li>
                        ))}
                      </ul>
                    ) : <p className="nb-analysis__hint">当前简报中没有找到足够相关的 Skill，不会编造仓库推荐。</p>}
                  </div>
                </>
              ) : null}
              <div>
                {analysis.trendQueries.length ? <p><strong>趋势检索关键词：</strong>{analysis.trendQueries.join(' · ')}</p> : null}
                {analysis.skillQueries.length ? <p><strong>Skill 检索关键词：</strong>{analysis.skillQueries.join(' · ')}</p> : null}
              </div>
            </div>
          ) : null}
          <p className="nb-analysis__disclaimer">{analysis.disclaimer}</p>
          <div className="nb-card nb-card--pad nb-analysis__next">
            <strong>建议现在先做的一步</strong>
            <p>{analysis.nextStep}</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
