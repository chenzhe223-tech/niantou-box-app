/**
 * 品牌标志（念头盒 NianBox）：品牌紫圆角方底 + 白色星形。
 *
 * 为什么必须是 SVG：
 * `✳`(U+2733)、`✱`(U+2731)、`✦`(U+2726) 这类字符在 iOS Safari 与
 * 微信内置浏览器里会落到系统 emoji 字体上，渲染成彩色 Emoji，甚至在部分
 * Android 机型上显示为绿色「米字」。品牌标志一旦依赖系统字体，跨端就不可控，
 * 因此这里使用内联 SVG，几何形状与 `public/favicon.svg`、
 * `scripts/generate-icons.mjs` 以及官网 niantou-box 的头图完全一致。
 *
 * 换算关系：官网 favicon 使用 64×64 视口，这里与 Ticker/收尾区块统一使用
 * 96×96 视口，路径坐标一一对应，缩放时形状不会变形。
 */

/** 品牌星形路径（96×96 视口，实心闭合多边形）。 */
export const BRAND_STAR_PATH =
  'M48 5 57 35 86 23 64 48 86 73 57 61 48 91 39 61 10 73 32 48 10 23 39 35Z';

/**
 * 星形相对于外框的缩放。路径自身只占 96 视口的 89.6%，再乘 0.72 后，
 * 星形约为外框边长的 64%，与 `public/favicon.svg`、`public/icons/*.png`
 * 以及官网头图保持同一套视觉比例。
 */
export const BRAND_STAR_SCALE = 0.72;

export interface BrandMarkProps {
  /** 外框边长（px），默认与顶栏一致。 */
  size?: number;
  className?: string;
}

export function BrandMark({ size = 30, className }: BrandMarkProps) {
  return (
    <span
      className={['nb-brand__mark', className].filter(Boolean).join(' ')}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 96 96" focusable="false" aria-hidden="true">
        <g
          transform={`translate(48 48) scale(${BRAND_STAR_SCALE}) translate(-48 -48)`}
        >
          <path d={BRAND_STAR_PATH} />
        </g>
      </svg>
    </span>
  );
}
