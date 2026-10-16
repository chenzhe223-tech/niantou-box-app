/**
 * 「交给 AI 工具」弹层。
 *
 * 这里做的每一件事都必须是真做得到的：
 * - ChatGPT 支持用链接带上提示词，按钮就是「打开 ChatGPT 并带上提示词」；
 * - 其余平台没有公开的传参方式，按钮就老实叫「复制提示词」+「打开平台」，
 *   由用户自己粘贴，绝不写成「已发送到豆包」这种做不到的状态；
 * - 提示词内容包含念头原文，因此在发送前会完整展示，可以逐字修改。
 */

import { useEffect, useMemo, useState } from 'react';
import { displayTitle, type Idea } from '../types/idea';
import {
  AI_TOOLS,
  TASK_TEMPLATES,
  buildTaskPrompt,
  copyText,
  getAiTool,
  shareText,
  toolPromptLink,
  type AiToolId,
  type TaskTemplateId,
} from '../services/aiTools';
import { track } from '../services/analytics';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { TextArea, TextField } from './Fields';
import { useToast } from './Toast';

export interface AiToolDialogProps {
  open: boolean;
  ideas: Idea[];
  /** 入口来源，用于统计哪里的「交给 AI」更常被用到。 */
  source: 'home' | 'inbox' | 'idea_detail';
  onClose: () => void;
}

export function AiToolDialog({ open, ideas, source, onClose }: AiToolDialogProps) {
  const toast = useToast();
  const [toolId, setToolId] = useState<AiToolId>('chatgpt');
  const [templateId, setTemplateId] = useState<TaskTemplateId>('analyze');
  const [customInstruction, setCustomInstruction] = useState('');
  const [prompt, setPrompt] = useState('');

  const tool = getAiTool(toolId) ?? AI_TOOLS[0];

  /**
   * 重新组装提示词。
   *
   * 只在「换了工具 / 换了模板 / 打开弹层」时重建，不覆盖用户已经改过的文字：
   * 用户手改过的提示词是他的劳动成果，不能因为切了个平台就被冲掉。
   */
  const generated = useMemo(
    () => buildTaskPrompt(templateId, ideas, customInstruction),
    [templateId, ideas, customInstruction],
  );

  useEffect(() => {
    if (!open) return;
    setPrompt(generated);
  }, [open, generated]);

  const link = toolPromptLink(toolId, prompt);

  const handleCopy = async () => {
    const ok = await copyText(prompt);
    track('ai_tool_opened', {
      source,
      tool: toolId,
      template: templateId,
      result: ok ? 'ok' : 'error',
    });
    toast.push(
      ok
        ? { message: '提示词已复制，去平台里粘贴即可。', tone: 'success' }
        : { message: '复制没有成功，可以手动选中提示词后复制。', tone: 'error' },
    );
  };

  const handleShare = async () => {
    const result = await shareText('念头盒 · 交给 AI 的任务', prompt);
    track('ai_tool_opened', { source, tool: toolId, template: templateId, result: 'ok' });
    if (result === 'unsupported') {
      toast.push({ message: '这台设备的浏览器不支持系统分享，请改用复制。', tone: 'info' });
    } else if (result === 'failed') {
      toast.push({ message: '分享没有完成，内容还在，可以再试一次。', tone: 'info' });
    }
  };

  return (
    <Dialog
      open={open}
      size="lg"
      title={ideas.length > 1 ? `把这 ${ideas.length} 条念头交给 AI` : '把这条念头交给 AI'}
      lead="提示词里会带上念头原文，发送前请确认内容可以外发。没有公开传参方式的平台需要你自己粘贴。"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button variant="secondary" onClick={() => void handleCopy()}>
            复制提示词
          </Button>
          {link ? (
            <a
              className="nb-btn nb-btn--primary"
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                track('ai_tool_opened', {
                  source,
                  tool: toolId,
                  template: templateId,
                  result: 'ok',
                });
              }}
            >
              打开 {tool.label} 并带上提示词
            </a>
          ) : (
            <a
              className="nb-btn nb-btn--primary"
              href={tool.homeUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                track('ai_tool_opened', {
                  source,
                  tool: toolId,
                  template: templateId,
                  result: 'ok',
                });
              }}
            >
              打开 {tool.label}
            </a>
          )}
        </>
      }
    >
      <div className="nb-stack nb-stack--tight">
        <p className="nb-kv">
          本次包含：
          {ideas.length === 1 ? displayTitle(ideas[0]) : `共 ${ideas.length} 条念头`}
        </p>

        <div>
          <p className="nb-field__label" id="nb-ai-tool-label">
            目标工具
          </p>
          <div className="nb-chips" role="group" aria-labelledby="nb-ai-tool-label">
            {AI_TOOLS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === toolId ? 'nb-chip nb-chip--active' : 'nb-chip'}
                aria-pressed={item.id === toolId}
                onClick={() => setToolId(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="nb-field__label" id="nb-ai-template-label">
            任务模板
          </p>
          <div className="nb-chips" role="group" aria-labelledby="nb-ai-template-label">
            {TASK_TEMPLATES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === templateId ? 'nb-chip nb-chip--active' : 'nb-chip'}
                aria-pressed={item.id === templateId}
                onClick={() => setTemplateId(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {templateId === 'custom' ? (
          <TextField
            label="自定义任务要求"
            value={customInstruction}
            onChange={setCustomInstruction}
            placeholder="例如：帮我写成一份 200 字的产品简介"
            hint="这段话会追加在提示词末尾。"
          />
        ) : null}

        <TextArea
          label="提示词（可修改，改过之后不会被覆盖）"
          rows={10}
          value={prompt}
          onChange={setPrompt}
          hint={`${prompt.length} 个字符。${tool.note}`}
        />

        <p className="nb-kv">
          {link
            ? '这个平台支持用链接带上提示词，点下面的按钮会新开一个标签页。'
            : '这个平台没有公开的传参方式：先「复制提示词」，再打开平台粘贴。念头盒不会替你发送，也不会假装已经发送。'}
        </p>

        <div className="nb-actionbar">
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => setPrompt(generated)}>
            恢复为自动生成的提示词
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void handleShare()}>
            系统分享
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
