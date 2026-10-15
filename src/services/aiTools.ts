/**
 * 把念头交给外部 AI 工具。
 *
 * 边界（很重要）：这里只做两件真正做得到的事——
 * 1. 在平台支持的情况下，用链接的方式把提示词带过去（例如 ChatGPT 的 ?q=）；
 * 2. 平台没有公开的传参方式时，给出可编辑的提示词，配合「复制」与系统分享，
 *    由用户自己粘贴。
 *
 * 不会、也不能伪造「已经发送给 ChatGPT / 已经在豆包里问过了」这类状态：
 * 那些平台没有对外暴露可编程的发送接口，我们如实标注「需要你自己粘贴」。
 * 另外：提示词里会包含念头的原文——这是用户主动选择「交给 AI」的结果，
 * 发送前一定会在弹层里让他看清并确认。
 */

import { displayTitle, statusLabel, type Idea } from '../types/idea';

export type AiToolId = 'chatgpt' | 'workbuddy' | 'doubao' | 'qwen' | 'glm';

export interface AiTool {
  id: AiToolId;
  label: string;
  /** 首页地址，用于「打开平台」。 */
  homeUrl: string;
  /**
   * 把提示词带过去的链接；平台不支持时为 null。
   * 只填真正被平台支持的传参方式，猜的就写 null。
   */
  promptUrl?: (prompt: string) => string;
  /** 该平台是否支持用链接直接带上提示词。 */
  supportsPromptLink: boolean;
  note: string;
}

export const AI_TOOLS: ReadonlyArray<AiTool> = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    homeUrl: 'https://chatgpt.com/',
    // ChatGPT 支持用 ?q= 直接把问题带进对话，打开即可继续追问。
    promptUrl: (prompt) => `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`,
    supportsPromptLink: true,
    note: '支持用链接直接带上提示词，打开就是一段新对话。',
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    homeUrl: 'https://www.workbuddy.ai/',
    supportsPromptLink: false,
    note: '没有公开的传参方式：复制提示词后在 WorkBuddy 里粘贴即可。',
  },
  {
    id: 'doubao',
    label: '豆包',
    homeUrl: 'https://www.doubao.com/chat/',
    supportsPromptLink: false,
    note: '没有公开的传参方式：复制提示词后在豆包里粘贴即可。',
  },
  {
    id: 'qwen',
    label: '通义千问',
    homeUrl: 'https://www.tongyi.com/',
    supportsPromptLink: false,
    note: '没有公开的传参方式：复制提示词后在通义千问里粘贴即可。',
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    homeUrl: 'https://chatglm.cn/',
    supportsPromptLink: false,
    note: '没有公开的传参方式：复制提示词后在智谱清言里粘贴即可。',
  },
];

export function getAiTool(id: AiToolId): AiTool | null {
  return AI_TOOLS.find((tool) => tool.id === id) ?? null;
}

export type TaskTemplateId = 'analyze' | 'app' | 'skill' | 'website' | 'feasibility' | 'custom';

export interface TaskTemplate {
  id: TaskTemplateId;
  label: string;
  /** 追加在提示词末尾的具体要求；自定义模板为空。 */
  instruction: string;
}

export const TASK_TEMPLATES: ReadonlyArray<TaskTemplate> = [
  {
    id: 'analyze',
    label: '问题分析',
    instruction:
      '请帮我分析这个问题：它到底难在哪里、现在的人是怎么绕过去的、还有哪些角度没被想到。最后给出三个可以立刻验证的小实验。',
  },
  {
    id: 'app',
    label: 'App 方案',
    instruction:
      '请把它当成一个 App 产品来设计：目标用户是谁、核心场景是什么、第一版必须有的三个功能是什么、哪些功能应该先砍掉。用条目回答。',
  },
  {
    id: 'skill',
    label: 'Skill 开发',
    instruction:
      '请把它拆成一个可以自动化的 Skill：输入是什么、输出是什么、需要哪些步骤、哪些步骤容易失败、最小可行版本怎么写。',
  },
  {
    id: 'website',
    label: '网站开发',
    instruction:
      '请把它设计成一个网站或小程序：页面结构与信息层级、首屏要讲清楚什么、需要哪些数据、用什么技术栈最省力。',
  },
  {
    id: 'feasibility',
    label: '可行性评估',
    instruction:
      '请做一次务实的可行性评估：技术上难在哪里、成本和周期大概多少、最容易失败的环节是什么、如果只能做一件事应该先做什么。',
  },
  { id: 'custom', label: '自定义任务', instruction: '' },
];

export function getTaskTemplate(id: TaskTemplateId): TaskTemplate {
  return TASK_TEMPLATES.find((item) => item.id === id) ?? TASK_TEMPLATES[TASK_TEMPLATES.length - 1];
}

/**
 * 组装提示词。
 *
 * 结构固定成「背景 → 原始念头 → 任务」，这样用户粘贴到任何平台都能直接用，
 * 也能自己删掉不想发的段落。
 */
export function buildTaskPrompt(
  templateId: TaskTemplateId,
  ideas: readonly Idea[],
  customInstruction = '',
): string {
  const list = [...ideas];
  const template = getTaskTemplate(templateId);
  const instruction = templateId === 'custom' ? customInstruction.trim() : template.instruction;

  const header =
    list.length === 1
      ? '我在「念头盒」里记下了一个念头，想请你帮我继续往下想。'
      : `我在「念头盒」里记下了 ${list.length} 个相关的念头，想请你帮我一起往下想。`;

  const blocks = list.map((idea, index) => {
    const lines: string[] = [];
    const title = displayTitle(idea);
    if (title) lines.push(`【${index + 1}】${title}`);
    else lines.push(`【${index + 1}】`);
    lines.push(idea.content.trim());
    if (idea.problem.trim()) lines.push(`想解决的问题：${idea.problem.trim()}`);
    if (idea.targetUsers.trim()) lines.push(`目标用户：${idea.targetUsers.trim()}`);
    if (idea.notes.trim()) lines.push(`补充：${idea.notes.trim()}`);
    lines.push(`（状态：${statusLabel(idea.status)}）`);
    return lines.join('\n');
  });

  const parts = [header, '', '原始记录：', blocks.join('\n\n'), ''];
  if (instruction) parts.push(instruction);
  return parts.join('\n').trim();
}

/** 平台的提示词链接；不支持返回 null。 */
export function toolPromptLink(toolId: AiToolId, prompt: string): string | null {
  const tool = getAiTool(toolId);
  if (!tool || !tool.supportsPromptLink || !tool.promptUrl) return null;
  return tool.promptUrl(prompt);
}

/** 复制到剪贴板。http 环境或旧内核下 Clipboard API 可能不可用，这里做兜底。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续尝试兜底方案。
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** 系统分享（iOS Safari / Android Chrome 支持时可用）。 */
export async function shareText(title: string, text: string): Promise<'shared' | 'unsupported' | 'failed'> {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
      return 'unsupported';
    }
    await navigator.share({ title, text });
    return 'shared';
  } catch {
    // 用户取消分享也会走到这里：不当作错误弹提示，交给调用方决定。
    return 'failed';
  }
}
