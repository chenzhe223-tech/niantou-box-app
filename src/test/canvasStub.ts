/**
 * 受控的 Canvas 2D 替身（仅测试使用）。
 *
 * jsdom 没有安装 node 的 canvas 包，`getContext('2d')` 会返回 null 并往虚拟
 * 控制台抛一条「Not implemented」。本机卡片与本机海报都真的走 Canvas，
 * 如果测试里放着不管，就只能断言「画不出来」，等于什么都没验证。
 *
 * 这里的替身做两件事，都不涉及伪造结果：
 *   1. 忠实记录每一次绘制调用（画了什么字、走了几个顶点、画了几张图），
 *      于是可以断言「图上真的出现了品牌文字与用户选定的文案」；
 *   2. `toDataURL` 返回一段格式合法的 data: URL，让「保存到 IndexedDB」
 *      这条链路能被真实校验（作品库会用正则检查 data: 前缀）。
 *
 * 它**不会**生成看起来像图片的假图：应用拿到的是一个固定字符串，
 * 断言里也从不把它当成「生成了内容」的证据。
 */

export interface RecordedFillText {
  text: string;
  x: number;
  y: number;
  fillStyle: string;
  font: string;
  textAlign: string;
}

export interface CanvasRecorder {
  /** 按调用顺序记录 fillText，用于验证图上出现的文字。 */
  texts: RecordedFillText[];
  moveTo: number;
  lineTo: number;
  arc: number;
  fillRect: number;
  drawImage: number;
}

export interface CanvasStubHandle {
  recorder: CanvasRecorder;
  /** 还原被替换掉的原型方法。 */
  restore: () => void;
}

/** 固定的一段 PNG 前缀 + 填充数据；只要求通过 data: URL 的格式校验。 */
const STUB_DATA_URL = `data:image/png;base64,${'A'.repeat(64)}`;

function createRecorder(): CanvasRecorder {
  return { texts: [], moveTo: 0, lineTo: 0, arc: 0, fillRect: 0, drawImage: 0 };
}

/** 只要应用用得到的那部分 API；字体宽度按字符数线性估算，够换行逻辑跑起来。 */
function createContext(recorder: CanvasRecorder): CanvasRenderingContext2D {
  let fillStyle = 'transparent';
  let font = '10px sans-serif';
  let textAlign = 'start';

  const context = {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string) {
      fillStyle = value;
    },
    globalAlpha: 1,
    get font() {
      return font;
    },
    set font(value: string) {
      font = value;
    },
    get textAlign() {
      return textAlign;
    },
    set textAlign(value: string) {
      textAlign = value;
    },
    textBaseline: 'alphabetic',
    beginPath() {},
    closePath() {},
    fill() {},
    arc() {
      recorder.arc += 1;
    },
    moveTo() {
      recorder.moveTo += 1;
    },
    lineTo() {
      recorder.lineTo += 1;
    },
    fillRect() {
      recorder.fillRect += 1;
    },
    drawImage() {
      recorder.drawImage += 1;
    },
    measureText(text: string) {
      return { width: text.length * 20 };
    },
    fillText(text: string, x: number, y: number) {
      recorder.texts.push({ text, x, y, fillStyle, font, textAlign });
    },
  };

  return context as unknown as CanvasRenderingContext2D;
}

/**
 * 装上一个记录型的 2D 上下文。返回 recoder 与还原函数。
 * 用 beforeAll / afterAll 成对调用，避免影响别的测试文件。
 */
export function installCanvasStub(): CanvasStubHandle {
  const recorder = createRecorder();
  const proto = HTMLCanvasElement.prototype;
  const originalGetContext = proto.getContext;
  const originalToDataURL = proto.toDataURL;

  proto.getContext = function getContext(this: HTMLCanvasElement, contextId: string) {
    if (contextId !== '2d') return null;
    return createContext(recorder);
  } as unknown as typeof proto.getContext;

  proto.toDataURL = function toDataURL(this: HTMLCanvasElement) {
    return STUB_DATA_URL;
  };

  return {
    recorder,
    restore: () => {
      proto.getContext = originalGetContext;
      proto.toDataURL = originalToDataURL;
    },
  };
}

/** 品牌星形路径里的顶点数；测试用它核对画出来的多边形确实来自同一段路径。 */
export function countPathPoints(path: string): number {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g) ?? [];
  return Math.floor(numbers.length / 2);
}
