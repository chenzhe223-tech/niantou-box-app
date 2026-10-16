/**
 * 一键生图的数据契约测试。
 *
 * 这一层测的是「服务端说什么，客户端就照实转达什么」：
 *   - 服务端明确说「没有生成」→ requestPoster 必须返回 null，由界面改走本机绘制，
 *     绝不能自己编一张「AI 生成」的图；
 *   - 服务端在隐私检查里拦下内容（422）→ 如实抛出，由界面显示「已停止生成」；
 *   - 风格与分类的默认匹配、比例、下载与分享的降级路径都要可验证。
 *
 * 网络层被打桩，断言的是真实的请求体与返回值解析，不发任何真实请求。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudError, cloudRequest } from './cloud/cloudClient';
import {
  POSTER_ASPECTS,
  POSTER_STYLES,
  PRIMARY_STYLE_ORDER,
  SECONDARY_STYLE_ORDER,
  STYLE_TONE_LABEL,
  abstractionInput,
  autoStyleFor,
  downloadPoster,
  getPosterStyle,
  requestAbstraction,
  requestPoster,
  sharePoster,
  type PosterStyleId,
} from './poster';

vi.mock('./cloud/cloudClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cloud/cloudClient')>();
  return { ...actual, cloudRequest: vi.fn() };
});

const mockedRequest = vi.mocked(cloudRequest);

const SAMPLE_ABSTRACTION = {
  theme: '寻找空位',
  mood: ['着急', '释然'],
  metaphor: '一格一格亮起来的车位灯',
  visuals: ['温暖的光点', '俯视网格'],
};

beforeEach(() => {
  mockedRequest.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('生图：风格与默认匹配', () => {
  it('首屏四类风格与「更多风格」不重叠，并集正好覆盖全部六种', () => {
    const all = [...PRIMARY_STYLE_ORDER, ...SECONDARY_STYLE_ORDER];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(POSTER_STYLES.map((style) => style.id).sort());
    expect(PRIMARY_STYLE_ORDER).toHaveLength(4);
  });

  it('每种风格都有面向用户的分类名，且首屏四类就是 PRD 里的四类', () => {
    for (const style of POSTER_STYLES) {
      expect(STYLE_TONE_LABEL[style.id]).toBeTruthy();
    }
    expect(PRIMARY_STYLE_ORDER.map((id) => STYLE_TONE_LABEL[id])).toEqual([
      '灵感海报',
      '趣味插画',
      '情绪卡片',
      '创意概念图',
    ]);
  });

  it('默认风格按分类自动匹配：产品类给创意概念图，其余给灵感海报', () => {
    expect(autoStyleFor({ category: 'app' })).toBe('future');
    expect(autoStyleFor({ category: 'web' })).toBe('future');
    expect(autoStyleFor({ category: 'skill' })).toBe('future');
    expect(autoStyleFor({ category: 'life' })).toBe('brand');
    expect(autoStyleFor({ category: 'other' })).toBe('brand');
    expect(autoStyleFor({ category: null })).toBe('brand');
  });

  it('未知风格 id 回落到第一种风格，而不是抛错', () => {
    expect(getPosterStyle('not-a-style' as PosterStyleId).id).toBe(POSTER_STYLES[0].id);
  });

  it('只提供 3:4 竖版与 1:1 方形两种比例', () => {
    expect(POSTER_ASPECTS.map((item) => item.value)).toEqual(['3:4', '1:1']);
  });
});

describe('生图：发给服务端的内容', () => {
  it('抽象请求只带念头本身的文字，不带标签或其它字段', () => {
    const text = abstractionInput({
      title: '车位雷达',
      content: '地下车库入口没有实时空位提示',
      category: 'app',
    });
    expect(text).toBe('车位雷达\n地下车库入口没有实时空位提示\n（分类：App / 产品创意）');
  });

  it('没有标题时不会留下空行', () => {
    expect(abstractionInput({ title: '   ', content: '一句话念头', category: null })).toBe(
      '一句话念头',
    );
  });

  it('抽象结果里的主题、情绪、隐喻与视觉元素都如实回传给界面', async () => {
    mockedRequest.mockResolvedValueOnce({
      source: 'ai',
      service: 'glm-5.3-flash',
      abstraction: SAMPLE_ABSTRACTION,
      privacy: { safe: true, violations: [] },
    });

    const result = await requestAbstraction('地下车库入口没有实时空位提示');

    expect(result.source).toBe('ai');
    expect(result.service).toBe('glm-5.3-flash');
    expect(result.abstraction).toEqual(SAMPLE_ABSTRACTION);
    expect(result.privacy.safe).toBe(true);
    expect(mockedRequest).toHaveBeenCalledWith(
      '/ai/abstract',
      expect.objectContaining({ method: 'POST', body: { content: '地下车库入口没有实时空位提示' } }),
    );
  });

  it('服务端说隐私检查没过时，客户端不会把它当成安全', async () => {
    mockedRequest.mockResolvedValueOnce({
      source: 'local',
      abstraction: SAMPLE_ABSTRACTION,
      privacy: { safe: false, violations: ['疑似手机号'] },
    });

    const result = await requestAbstraction('我的手机号是 13800000000');

    expect(result.privacy.safe).toBe(false);
    expect(result.privacy.violations).toEqual(['疑似手机号']);
  });

  it('隐私检查返回 422 时如实抛错，由界面显示「已停止生成」', async () => {
    mockedRequest.mockRejectedValueOnce(
      new CloudError('bad-request', '未通过隐私检查，已停止生成。', {
        status: 422,
        detail: JSON.stringify({ privacy: { violations: ['疑似手机号'] } }),
      }),
    );

    await expect(requestAbstraction('含个人信息的念头')).rejects.toBeInstanceOf(CloudError);
  });
});

describe('生图：图像结果解析', () => {
  it('把服务端返回的 base64 转成可直接预览的 data: URL，并带上实际模型信息', async () => {
    mockedRequest.mockResolvedValueOnce({
      configured: true,
      generated: true,
      provider: '智谱',
      base64: 'QUJD',
      prompt: 'theme: 寻找空位',
      privacy: { safe: true, violations: [] },
    });

    const result = await requestPoster({
      style: 'future',
      aspect: '3:4',
      abstraction: SAMPLE_ABSTRACTION,
      original: '地下车库入口没有实时空位提示',
    });

    expect(result?.render).toBe('ai');
    expect(result?.dataUrl).toBe('data:image/png;base64,QUJD');
    expect(result?.provider).toBe('智谱');
    expect(result?.promptPreview).toBe('theme: 寻找空位');
    expect(mockedRequest).toHaveBeenCalledWith(
      '/ai/poster',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ style: 'future', aspect: '3:4' }),
      }),
    );
  });

  it('已经是 data: URL 的返回值原样透传', async () => {
    mockedRequest.mockResolvedValueOnce({ generated: true, base64: 'data:image/jpeg;base64,QUJD' });

    const result = await requestPoster({
      style: 'brand',
      aspect: '1:1',
      abstraction: SAMPLE_ABSTRACTION,
    });

    expect(result?.dataUrl).toBe('data:image/jpeg;base64,QUJD');
  });

  it('服务端只给了图片地址时也能当预览用', async () => {
    mockedRequest.mockResolvedValueOnce({ generated: true, url: 'https://example.test/a.png' });

    const result = await requestPoster({
      style: 'brand',
      aspect: '3:4',
      abstraction: SAMPLE_ABSTRACTION,
    });

    expect(result?.dataUrl).toBe('https://example.test/a.png');
  });

  it('服务端明确说「没有生成」时返回 null，不伪造图片', async () => {
    mockedRequest.mockResolvedValueOnce({
      configured: false,
      generated: false,
      message: '服务端尚未配置图像生成服务',
    });

    await expect(
      requestPoster({ style: 'brand', aspect: '3:4', abstraction: SAMPLE_ABSTRACTION }),
    ).resolves.toBeNull();
  });

  it('服务端说生成成功但没给任何图片数据时同样返回 null', async () => {
    mockedRequest.mockResolvedValueOnce({ generated: true, base64: '' });

    await expect(
      requestPoster({ style: 'brand', aspect: '3:4', abstraction: SAMPLE_ABSTRACTION }),
    ).resolves.toBeNull();
  });
});

describe('生图：保存与分享', () => {
  it('保存图片会真的触发一次带文件名的下载', () => {
    const clicked: HTMLAnchorElement[] = [];
    const spy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this);
      });

    try {
      downloadPoster('data:image/png;base64,QUJD', 'nianbox-poster-test.png');

      expect(clicked).toHaveLength(1);
      expect(clicked[0].download).toBe('nianbox-poster-test.png');
      expect(clicked[0].href).toBe('data:image/png;base64,QUJD');
      // 下载用的临时链接不会留在页面上。
      expect(document.querySelectorAll('a[download]')).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('设备不支持系统分享时返回 unsupported，界面据此提示先保存图片', async () => {
    expect(await sharePoster('data:image/png;base64,QUJD', 'x.png', '文字')).toBe('unsupported');
  });

  it('用户在系统分享面板里取消时返回 failed，而不是假装分享成功', async () => {
    const share = vi.fn().mockRejectedValue(new Error('AbortError'));
    Object.defineProperty(navigator, 'share', { configurable: true, writable: true, value: share });

    try {
      expect(await sharePoster('data:image/png;base64,QUJD', 'x.png', '文字')).toBe('failed');
      expect(share).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(navigator, 'share');
    }
  });

  it('支持分享文件的设备上把图片一起分享出去', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { configurable: true, writable: true, value: share });
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      writable: true,
      value: () => true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ blob: async () => new Blob(['x'], { type: 'image/png' }) })),
    );

    try {
      expect(await sharePoster('data:image/png;base64,QUJD', 'x.png', '文字')).toBe('shared');
      const payload = share.mock.calls[0][0] as { files: File[]; text: string };
      expect(payload.files).toHaveLength(1);
      expect(payload.text).toBe('文字');
    } finally {
      Reflect.deleteProperty(navigator, 'share');
      Reflect.deleteProperty(navigator, 'canShare');
    }
  });
});