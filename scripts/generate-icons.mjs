/**
 * 生成 PWA 所需的 PNG 图标。
 *
 * 只依赖 Node 内置模块（zlib），不需要浏览器、不需要 Playwright，
 * 因此在离线环境与 CI 中都可以直接运行：
 *
 *   node scripts/generate-icons.mjs
 *
 * 图形与 public/favicon.svg 保持一致（同一个墨绿盒子标记），
 * 只是按不同用途栅格化成不同尺寸的 PNG：
 *
 *   - icon-192.png / icon-512.png  : 圆角图形，四周透明，用于 manifest "any"
 *   - maskable-512.png             : 背景铺满，图形缩进安全区，用于 "maskable"
 *   - apple-touch-icon.png         : 背景铺满且不透明（iOS 会自行裁圆角）
 *
 * 输出目录：public/icons/
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';

const projectRoot = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const outputDir = path.join(projectRoot, 'public', 'icons');

/** 品牌色：墨绿底 + 暖白线条。 */
const ACCENT = [47, 109, 91]; // #2F6D5B
const INK = [246, 242, 233]; // #F6F2E9

/* -------------------------------------------------------------------------- */
/* 图形：全部在 512×512 的坐标系里描述，按目标尺寸等比缩放。                   */
/* -------------------------------------------------------------------------- */

const VIEW = 512;
const CORNER_RADIUS = 112;
const STROKE = 26;

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lengthSq = vx * vx + vy * vy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lengthSq));
  return Math.hypot(wx - t * vx, wy - t * vy);
}

/** 盒子的图形：矩形描边 + 顶盖分隔线 + 取物口。 */
function insideMark(x, y) {
  const half = STROKE / 2;
  if (Math.abs(sdRoundRect(x, y, 256, 284, 138, 98, 32)) <= half) return true;
  if (sdSegment(x, y, 118, 254, 394, 254) <= half) return true;
  if (sdSegment(x, y, 226, 300, 286, 300) <= half) return true;
  return false;
}

/**
 * 栅格化一个图标。
 * @param {number} size 输出边长（像素）
 * @param {{ bleed: boolean, contentScale: number }} options
 *   bleed = true 时铺满整块画布（不裁圆角、不留透明边），
 *   contentScale 控制图形相对画布的大小。
 */
function renderIcon(size, { bleed, contentScale }) {
  const samples = 4; // 每轴 4× 超采样，得到平滑边缘
  const pixel = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let sumAlpha = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = ((px + (sx + 0.5) / samples) / size) * VIEW;
          const y = ((py + (sy + 0.5) / samples) / size) * VIEW;

          const onBackground = bleed || sdRoundRect(x, y, 256, 256, 256, 256, CORNER_RADIUS) <= 0;
          if (!onBackground) continue;

          // 把采样点映射回图形自身的坐标，实现整体缩放。
          const mx = 256 + (x - 256) / contentScale;
          const my = 256 + (y - 256) / contentScale;
          const color = insideMark(mx, my) ? INK : ACCENT;

          sumAlpha += 1;
          sumR += color[0];
          sumG += color[1];
          sumB += color[2];
        }
      }

      const total = samples * samples;
      const offset = (py * size + px) * 4;
      if (sumAlpha === 0) {
        pixel[offset] = 0;
        pixel[offset + 1] = 0;
        pixel[offset + 2] = 0;
        pixel[offset + 3] = 0;
      } else {
        // 图形内部颜色恒定，只有边缘的覆盖率在变化，因此直接取未预乘的通道均值。
        pixel[offset] = Math.round(sumR / sumAlpha);
        pixel[offset + 1] = Math.round(sumG / sumAlpha);
        pixel[offset + 2] = Math.round(sumB / sumAlpha);
        pixel[offset + 3] = Math.round((sumAlpha / total) * 255);
      }
    }
  }

  return pixel;
}

/* -------------------------------------------------------------------------- */
/* 极简 PNG 编码器（RGBA / 8bit / 无隔行）                                     */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  ihdr[10] = 0; // 压缩方式
  ihdr[11] = 0; // 过滤方式
  ihdr[12] = 0; // 是否隔行

  // 每行前面加一个 filter 字节（0 = None）。
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */

const targets = [
  { file: 'icon-192.png', size: 192, bleed: false, contentScale: 1 },
  { file: 'icon-512.png', size: 512, bleed: false, contentScale: 1 },
  { file: 'apple-touch-icon.png', size: 180, bleed: true, contentScale: 0.84 },
  { file: 'maskable-512.png', size: 512, bleed: true, contentScale: 0.78 },
];

async function main() {
  await mkdir(outputDir, { recursive: true });
  for (const target of targets) {
    const rgba = renderIcon(target.size, target);
    const png = encodePng(target.size, rgba);
    const output = path.join(outputDir, target.file);
    await writeFile(output, png);
    console.log(
      `已生成 ${path.relative(projectRoot, output)} (${target.size}×${target.size}, ${png.length} 字节)`,
    );
  }
}

await main();
