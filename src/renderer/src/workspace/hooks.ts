import { useCallback, useSyncExternalStore } from "react";
import { sessionWorkspaceStore } from "./store";
import type {
  SessionWorkspaceStore,
  SliceName,
  SliceStateMap,
  WorkspaceKey,
} from "./sessionWorkspace";

/**
 * 读取某条目的某个切片状态，只在该切片变化（或条目被移除）时唤醒本组件。
 *
 * 这是热路径的唯一正确入口：store.subscribe 只报结构变化（焦点/成员），
 * 因此把 20Hz 的流式切片读进根组件会挂错订阅面——应交给真正渲染它的叶子组件。
 *
 * @param key 条目键；undefined 表示当前无焦点条目（返回 undefined，不订阅）。
 * @param store 测试注入用；生产走默认单例。
 */
export function useWorkspaceSlice<K extends SliceName>(
  key: WorkspaceKey | undefined,
  slice: K,
  store: SessionWorkspaceStore = sessionWorkspaceStore,
): SliceStateMap[K] | undefined {
  const subscribe = useCallback(
    (listener: () => void) =>
      key === undefined ? () => {} : store.subscribeSlice(key, slice, listener),
    [store, key, slice],
  );
  const getSnapshot = useCallback(
    () => (key === undefined ? undefined : store.getSlice(key, slice)),
    [store, key, slice],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
