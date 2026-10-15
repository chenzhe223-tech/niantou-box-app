/**
 * 订阅云端同步状态。
 *
 * 同步状态保存在服务层（cloudSync.ts）的单一快照里，界面只读不写；
 * 这样多个页面（顶栏提示、收件箱、设置、云端页）看到的一定是同一份事实。
 */

import { useEffect, useState } from 'react';
import { getCloudState, subscribeCloudState, type CloudSyncState } from '../services/cloud/cloudSync';

export function useCloudSync(): CloudSyncState {
  const [state, setState] = useState<CloudSyncState>(() => getCloudState());

  useEffect(() => subscribeCloudState(setState), []);

  return state;
}

/**
 * 某条记录是否还只在本地（没进云端）。
 * 用于在列表上标注「仅本地」，让用户一眼看出哪些内容还没同步出去。
 */
export function isIdeaPending(state: CloudSyncState, ideaId: string): boolean {
  return state.pendingKeys.includes(`idea:${ideaId}`);
}
