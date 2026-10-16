/**
 * 数据变更广播。
 *
 * 念头、项目、作品都写在同一套 IndexedDB 里，界面靠这个广播知道「该重新读了」。
 * 单独抽成一个模块，是为了让 storage（念头 / 项目）与 works（作品）都能触发广播，
 * 又不会互相 import 形成环。
 */

type ChangeListener = () => void;

const changeListeners = new Set<ChangeListener>();
let changeVersion = 0;

export function subscribeToChanges(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

export function getChangeVersion(): number {
  return changeVersion;
}

export function emitChange(): void {
  changeVersion += 1;
  for (const listener of [...changeListeners]) {
    try {
      listener();
    } catch {
      // 单个订阅者出错不应影响其他订阅者。
    }
  }
}
