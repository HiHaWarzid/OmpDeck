import { useRef } from "react";

type AnyHandler = (...args: never[]) => unknown;

/**
 * 把一组每帧重建的回调转成引用恒定的转发器（供 memo 边界使用）。
 *
 * 场景：`SidebarTree` / `GitPanel` 等是 `memo` 边界，但 App 里传给它们的处理函数
 * 每次渲染都是新函数，浅比较必失败——流式 token、输入框打字等无关更新会重算
 * 整棵侧栏/Git 面板。原实现是在组件里手写 `latestXxxHandlersRef` + `useMemo`
 * 逐项转发，同一模式在 App 里出现了三份（侧栏 17 项、Git 5 项、文件 3 项），
 * 每加一个回调都要改三处。
 *
 * 契约：
 * - 调用方每次渲染传入**当前**实现对象；hook 在渲染期同步更新 ref，
 *   因此转发器总是调用最新实现（不存在闭包过期）。
 * - 返回对象的身份在组件生命周期内恒定，值类型/键集合以**首次渲染**为准——
 *   键集合必须稳定（新增/删除回调要改代码，不能按条件拼装）。
 * - 转发器参数原样透传，`this` 不保留（这些回调都是无绑定函数）。
 */
export function useStableHandlers<T extends Record<string, AnyHandler>>(handlers: T): T {
  const latestRef = useRef(handlers);
  // 渲染期同步：与迁移前的 `latestRef.current = {...}` 语义一致，
  // 保证同一帧内的调用（事件处理器）看到的就是本次渲染的实现。
  latestRef.current = handlers;

  const stableRef = useRef<T | null>(null);
  if (!stableRef.current) {
    const stable: Record<string, AnyHandler> = {};
    for (const key of Object.keys(handlers)) {
      stable[key] = (...args: never[]) => latestRef.current[key](...args);
    }
    stableRef.current = stable as T;
  }
  return stableRef.current;
}
