/**
 * 外部服务适配层的单元测试（不需要任何真实密钥，也不发任何真实请求）。
 *
 * 这一层的价值全在「换一家服务商不用改代码」和「出错时如实报错」两件事上，
 * 所以测试也只盯这两件事：参数形状对不对、失败路径有没有假装成功。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  aiConfig,
  buildMailRequest,
  bytesToBase64,
  capabilities,
  clampTemperature,
  imageConfig,
  mailConfig,
  parseJsonLoose,
  posterSizeFor,
  resolveMailProvider,
  resolveProvider,
  sendMail,
  upstreamMessage,
} from './cloud-worker.js';

describe('服务商识别', () => {
  it('按域名认得出智谱', () => {
    expect(resolveProvider('', 'https://open.bigmodel.cn/api/paas/v4')).toBe('zhipu');
  });

  it('显式配置优先于域名（自建代理也能走对分支）', () => {
    expect(resolveProvider('zhipu', 'https://my-proxy.example.com/v1')).toBe('zhipu');
  });

  it('认不出来时按 OpenAI 兼容处理', () => {
    expect(resolveProvider('', 'https://api.example.com/v1')).toBe('openai');
    expect(resolveProvider('', '')).toBe('openai');
  });
});

describe('温度夹紧', () => {
  it('把 0 抬到 0.01（智谱不接受 0，会直接 400）', () => {
    expect(clampTemperature(0)).toBe(0.01);
  });

  it('把过大的值压到 1', () => {
    expect(clampTemperature(2)).toBe(1);
  });

  it('正常值原样返回，非法值退回默认', () => {
    expect(clampTemperature(0.7)).toBe(0.7);
    expect(clampTemperature(undefined, 0.5)).toBe(0.5);
    expect(clampTemperature('abc', 0.3)).toBe(0.3);
  });
});

describe('宽松 JSON 解析', () => {
  it('认干净的 JSON', () => {
    expect(parseJsonLoose('{"category":"app"}')).toEqual({ category: 'app' });
  });

  it('认被 ```json 围栏包住的 JSON', () => {
    expect(parseJsonLoose('```json\n{"category":"web"}\n```')).toEqual({ category: 'web' });
  });

  it('认前后多了一句话的 JSON', () => {
    expect(parseJsonLoose('好的，结果是：{"category":"life"} 就这样')).toEqual({ category: 'life' });
  });

  it('真的不是 JSON 时返回 null，而不是抛错', () => {
    expect(parseJsonLoose('完全不是 JSON')).toBeNull();
    expect(parseJsonLoose('')).toBeNull();
  });
});

describe('海报尺寸', () => {
  it('智谱的 3:4 用 768x1344（1024x1365 它不认）', () => {
    expect(posterSizeFor('zhipu', '3:4')).toBe('768x1344');
  });

  it('OpenAI 的 3:4 用 1024x1365', () => {
    expect(posterSizeFor('openai', '3:4')).toBe('1024x1365');
  });

  it('不认识的比例退回正方形，绝不发一个必然 400 的尺寸', () => {
    expect(posterSizeFor('zhipu', '7:5')).toBe('1024x1024');
    expect(posterSizeFor('unknown-vendor', '1:1')).toBe('1024x1024');
  });
});

describe('配置解析', () => {
  it('智谱只给一把 key 就够：地址与模型名都有默认值', () => {
    const cfg = aiConfig({ AI_PROVIDER: 'zhipu', AI_API_KEY: 'k' });
    expect(cfg.ready).toBe(true);
    expect(cfg.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(cfg.model).toBe('glm-5.3');
  });

  it('只填 AI_API_KEY、别的都不填，也按智谱默认值配好', () => {
    const cfg = aiConfig({ AI_API_KEY: 'k' });
    expect(cfg.provider).toBe('zhipu');
    expect(cfg.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(cfg.model).toBe('glm-5.3');
    expect(cfg.ready).toBe(true);
  });

  it('给了别的地址就以地址为准，不会被默认智谱顶掉', () => {
    const cfg = aiConfig({ AI_API_KEY: 'k', AI_BASE_URL: 'https://api.deepseek.com/v1' });
    expect(cfg.provider).toBe('openai');
    expect(cfg.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(cfg.ready).toBe(false);
  });

  it('显式写的模型名不会被默认值覆盖', () => {
    expect(aiConfig({ AI_PROVIDER: 'zhipu', AI_API_KEY: 'k', AI_MODEL: 'glm-4.6' }).model).toBe('glm-4.6');
  });

  it('没有 key 就是没配好 —— 不会伪造可用', () => {
    expect(aiConfig({ AI_PROVIDER: 'zhipu' }).ready).toBe(false);
    expect(aiConfig({}).ready).toBe(false);
  });

  it('图像配置可以复用同一把智谱 key', () => {
    const cfg = imageConfig({ AI_PROVIDER: 'zhipu', AI_API_KEY: 'k' });
    expect(cfg.ready).toBe(true);
    expect(cfg.model).toBe('cogview-4-250304');
  });

  it('图像同样只靠一把 key 就配好（不填 IMAGE_* 也行）', () => {
    const cfg = imageConfig({ AI_API_KEY: 'k' });
    expect(cfg.provider).toBe('zhipu');
    expect(cfg.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(cfg.model).toBe('cogview-4-250304');
    expect(cfg.ready).toBe(true);
  });

  it('OpenAI 形状没有默认模型名，必须显式配', () => {
    const cfg = imageConfig({ IMAGE_API_KEY: 'k', IMAGE_BASE_URL: 'https://api.openai.com/v1' });
    expect(cfg.ready).toBe(false);
  });

  it('邮件服务商按域名识别，默认按 Resend 形状', () => {
    expect(resolveMailProvider('', 'https://api.sendgrid.com')).toBe('sendgrid');
    expect(resolveMailProvider('', 'https://api.resend.com')).toBe('resend');
    expect(resolveMailProvider('', 'https://mail.example.com')).toBe('resend');
    expect(mailConfig({ MAIL_API_BASE: 'https://api.resend.com', MAIL_API_KEY: 'k' }).ready).toBe(false);
    expect(
      mailConfig({ MAIL_API_BASE: 'https://api.resend.com', MAIL_API_KEY: 'k', MAIL_FROM: 'a@b.com' }).ready,
    ).toBe(true);
  });

  it('capabilities 如实反映「配了哪几项」', () => {
    const bare = capabilities({});
    expect(bare).toMatchObject({
      classify: false,
      abstract: false,
      image: false,
      mail: false,
      passwordReset: false,
      aiProvider: '',
      aiModel: '',
    });

    const withZhipu = capabilities({
      AI_PROVIDER: 'zhipu',
      AI_API_KEY: 'k',
      AI_PROVIDER_LABEL: '智谱 GLM',
      MAIL_API_BASE: 'https://api.resend.com',
      MAIL_API_KEY: 'k',
      MAIL_FROM: 'a@b.com',
    });
    expect(withZhipu.classify).toBe(true);
    expect(withZhipu.image).toBe(true);
    expect(withZhipu.passwordReset).toBe(true);
    expect(withZhipu.aiProvider).toBe('智谱 GLM');
    expect(withZhipu.aiModel).toBe('glm-5.3');
    expect(withZhipu.mailProvider).toBe('resend');

    // 「我只填了一把 GLM key」是最容易踩的配置方式，必须一次点亮分类与生图。
    const onlyKey = capabilities({ AI_API_KEY: 'k' });
    expect(onlyKey.classify).toBe(true);
    expect(onlyKey.abstract).toBe(true);
    expect(onlyKey.image).toBe(true);
    expect(onlyKey.aiModel).toBe('glm-5.3');
    expect(onlyKey.imageModel).toBe('cogview-4-250304');
    expect(onlyKey.mail).toBe(false);
  });
});

describe('邮件请求形状', () => {
  const base = { apiKey: 'k', from: 'box@nianbox.dev', fromName: '念头盒' };

  it('Resend：to 是数组，from 带显示名', () => {
    const request = buildMailRequest({ ...base, provider: 'resend', baseUrl: 'https://api.resend.com' }, {
      to: 'me@example.com',
      subject: '主题',
      text: '正文',
    });
    expect(request.url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(request.body)).toEqual({
      from: '念头盒 <box@nianbox.dev>',
      to: ['me@example.com'],
      subject: '主题',
      text: '正文',
    });
  });

  it('SendGrid：personalizations 结构', () => {
    const request = buildMailRequest(
      { ...base, provider: 'sendgrid', baseUrl: 'https://api.sendgrid.com' },
      { to: 'me@example.com', subject: '主题', text: '正文' },
    );
    expect(request.url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(JSON.parse(request.body)).toMatchObject({
      personalizations: [{ to: [{ email: 'me@example.com' }] }],
      from: { email: 'box@nianbox.dev', name: '念头盒' },
      content: [{ type: 'text/plain', value: '正文' }],
    });
  });

  it('Mailgun：表单编码 + Basic 认证', () => {
    const request = buildMailRequest(
      { ...base, provider: 'mailgun', baseUrl: 'https://api.mailgun.net/v3/nianbox.dev' },
      { to: 'me@example.com', subject: '主题', text: '正文' },
    );
    expect(request.url).toBe('https://api.mailgun.net/v3/nianbox.dev/messages');
    expect(request.headers.authorization).toBe(`Basic ${btoa('api:k')}`);
    expect(new URLSearchParams(request.body).get('to')).toBe('me@example.com');
  });
});

describe('发信失败必须如实报错', () => {
  const env = {
    MAIL_API_BASE: 'https://api.resend.com',
    MAIL_API_KEY: 'k',
    MAIL_FROM: 'box@nianbox.dev',
  };

  it('没配置时明确说没配置，不假装已发送', async () => {
    const result = await sendMail({}, { to: 'a@b.com', subject: 's', text: 't' });
    expect(result.configured).toBe(false);
    expect(result.sent).toBe(false);
  });

  it('成功了才返回 sent:true，并带回服务商 id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 })),
    );
    const result = await sendMail(env, { to: 'a@b.com', subject: 's', text: 't' });
    expect(result).toMatchObject({ configured: true, sent: true, id: 'msg_123' });
    vi.unstubAllGlobals();
  });

  it('服务商报错时 sent:false，并把原话留在 detail 里供排障', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: 'domain is not verified' }), { status: 403 }),
      ),
    );
    const result = await sendMail(env, { to: 'a@b.com', subject: 's', text: 't' });
    expect(result.sent).toBe(false);
    expect(result.detail).toContain('http-403');
    expect(result.detail).toContain('domain is not verified');
    vi.unstubAllGlobals();
  });
});

describe('工具函数', () => {
  it('bytesToBase64 与大图分块一致', () => {
    const bytes = new Uint8Array(70000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
    const encoded = bytesToBase64(bytes);
    // 510 是 3 的倍数，前缀的 base64 才会是整体 base64 的前缀。
    const head = btoa(String.fromCharCode(...bytes.slice(0, 510)));
    expect(encoded.startsWith(head)).toBe(true);
    expect(encoded.length).toBe(Math.ceil(bytes.length / 3) * 4);
    const decoded = atob(encoded);
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.charCodeAt(0)).toBe(bytes[0]);
    expect(decoded.charCodeAt(65536)).toBe(bytes[65536]);
    expect(decoded.charCodeAt(bytes.length - 1)).toBe(bytes[bytes.length - 1]);
  });

  it('upstreamMessage 会从各家不同的错误体里抠出同一句话', () => {
    expect(upstreamMessage('{"error":{"message":"模型不存在"}}')).toBe('模型不存在');
    expect(upstreamMessage('{"message":"bad key"}')).toBe('bad key');
    expect(upstreamMessage('plain text')).toBe('plain text');
  });
});
