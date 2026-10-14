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
}

/** 导出并下载备份文件，返回实际使用的文件名，便于界面提示。 */
export async function downloadBackup(): Promise<DownloadedBackup> {
  const backup = await exportBackup();
  const filename = backupFileName(new Date());
  downloadTextFile(filename, serializeBackup(backup));
  return {
    filename,
    ideaCount: backup.ideas.length,
    projectCount: backup.projects.length,
  };
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
