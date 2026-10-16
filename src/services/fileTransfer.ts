/**
 * 浏览器文件读写的薄封装：导出下载备份、读取用户选择的 JSON 文件。
 * 数据始终在本地浏览器中处理，不会上传到任何服务器。
 */

import { backupFileName, exportBackup, serializeBackup } from './backup';

export function downloadTextFile(
  filename: string,
  text: string,
  mime = 'application/json',
): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // 立即释放会让部分浏览器来不及下载，放到下一个事件循环。
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export interface DownloadedBackup {
  filename: string;
  ideaCount: number;
  projectCount: number;
  /** 一并导出的本机作品件数（含关联念头在回收站里的作品）。 */
  workCount: number;
  /** 一并导出的作品图片张数。 */
  imageCount: number;
  /** 导出文件的大致体积（字节）。作品图片会让备份明显变大，提前说清楚。 */
  sizeBytes: number;
}

/** 导出并下载备份文件，返回实际使用的文件名与件数，便于界面如实提示。 */
export async function downloadBackup(): Promise<DownloadedBackup> {
  const backup = await exportBackup();
  const filename = backupFileName(new Date());
  const text = serializeBackup(backup);
  downloadTextFile(filename, text);
  return {
    filename,
    ideaCount: backup.ideas.length,
    projectCount: backup.projects.length,
    workCount: backup.works.length,
    imageCount: backup.workImages.length,
    // UTF-8 下用 Blob 量一次最接近实际落盘体积；环境不支持时退回字符数估算。
    sizeBytes: estimateTextBytes(text),
  };
}

function estimateTextBytes(text: string): number {
  try {
    return new Blob([text]).size;
  } catch {
    return text.length;
  }
}

/** 把字节数说成人话，用于导出 / 导入的提示文案。 */
export function humanFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} 字节`;
}

export interface PickedFile {
  name: string;
  text: string;
}

function readFileAsText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

/** 打开系统文件选择器，读取用户选中的 JSON 文件；用户取消时返回 null。 */
export function pickJsonFile(): Promise<PickedFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    input.setAttribute('aria-hidden', 'true');

    const cleanup = () => {
      input.remove();
      window.removeEventListener('focus', onFocus);
    };

    const onFocus = () => {
      // 用户可能取消了选择，稍等片刻再清理输入框。
      setTimeout(() => {
        if (!input.files || input.files.length === 0) {
          cleanup();
          resolve(null);
        }
      }, 500);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        cleanup();
        resolve(null);
        return;
      }
      readFileAsText(file)
        .then((text) => {
          cleanup();
          resolve({ name: file.name, text });
        })
        .catch((error: unknown) => {
          cleanup();
          reject(error);
        });
    });

    document.body.appendChild(input);
    window.addEventListener('focus', onFocus, { once: true });
    input.click();
  });
}
