import { composerSlice, type ComposerState } from "./slices/composerSlice";
import { thinkingSlice, type ThinkingState } from "./slices/thinkingSlice";

/**
 * 会话工作区（SessionWorkspace）——渲染层深模块核心（切片 0，纯逻辑，零 React）。
 *
 * 领域术语见 CONTEXT.md「会话工作区」节。设计定案（C+B 混合）：
 * - 单一 store 实例（工厂创建，默认单例由上层挂载），内部 reducer 分片；
 * - Focus：单一选中态。用户意图操作绑定焦点、不带 key；事件驱动操作带显式 key
 *   （后台 tab 也在流式，事件不能只落在焦点上）；
 * - SessionEntry：按规范键登记的条目，生命周期绑定 agent tab 成员关系
 *   （join/leave 由适配器在成员变化时调用），条目消失即 dispose；
 * - 每条目状态由静态切片清单 workspaceSlices 分片持有，切片互不感知对方实现。
 *
 * 不变式：
 * 1. Focus 永远指向存在的条目——activate/focusProject 对未知 key 返回 false，
 *    聚焦条目 leave 时焦点清空。不存在"聚焦但无条目"的帧。
 * 2. 切片 reduce 必须纯归约：未处理或结果未变时返回原引用。引用相等即"无变更"
 *    信号，dispatch 不会因此替换条目、通知订阅者。
 * 3. 快照引用在两次真实变更之间保持稳定（getSnapshot 供 useSyncExternalStore，
 *    热路径 20Hz thinking 归约不得唤醒无关订阅者）。
 * 4. dispatch 返回 false 仅表示"目标不存在"（未知 key / 无焦点），不抛错。
 *
 * 本文件刻意不用运行时切片注册表：workspaceSlices 是静态清单，新关注点落地 =
 * 新切片文件 + 本清单加一行 + seedData 同步，编译期即可见全貌。
 */

/** 规范键：tab 条目 = 活体 agent tab id（随成员关系生灭）；project 条目 = `project:${projectId}`。 */
export type WorkspaceKey = string;

/** project 条目的键规则：加前缀避免与任意 sessionPath 碰撞。 */
export function projectKey(projectId: string): WorkspaceKey {
  return `project:${projectId}`;
}

export function isProjectKey(key: WorkspaceKey): boolean {
  return key.startsWith("project:");
}

/** 条目类别：tab = agent 会话条目；project = 项目空态作用域（无 agent 时的终端/抽屉宿主）。 */
export type EntryKind = "tab" | "project";

/** 单一选中态。tab：会话条目；project：项目作用域（空态查看器）。 */
export type WorkspaceFocus =
  | { kind: "tab"; sessionKey: WorkspaceKey }
  | { kind: "project"; projectId: string };

/** 由 Focus 推导条目 key（focus 永远指向存在的条目，见不变式 1）。 */
export function focusKey(focus: WorkspaceFocus): WorkspaceKey {
  return focus.kind === "tab" ? focus.sessionKey : projectKey(focus.projectId);
}

/**
 * 工作区动作：type 前缀命名（`<slice>/<verb>`）。各切片 reducer 自行收窄；
 * 未知 type 的动作为全切片忽略（返回原引用）。
 */
export interface WorkspaceAction {
  type: string;
}

/**
 * 切片定义。seed 在条目 join 时执行；reduce 每次 dispatch 对所有切片各跑一遍，
 * 由切片自行判断是否与自己相关。
 */
export interface WorkspaceSlice<S> {
  readonly name: string;
  seed(kind: EntryKind): S;
  reduce(state: S, action: WorkspaceAction): S;
}

/** 静态切片清单（manifest）：新关注点在此登记。 */
export const workspaceSlices = {
  composer: composerSlice,
  thinking: thinkingSlice,
} as const;

type Slices = typeof workspaceSlices;

/**
 * 切片名 → 状态类型。新切片在此登记（同时登记 workspaceSlices 与 seedEntryData），
 * 状态类型由切片模块自己命名导出，避免下游从实现函数反推契约。
 */
export type SliceStateMap = {
  composer: ComposerState;
  thinking: ThinkingState;
};

/** 切片名（manifest 的键集合）：订阅与读取都按它定位。 */
export type SliceName = keyof Slices;
type SliceStateOf<K extends SliceName> = SliceStateMap[K];

/**
 * 编译期守卫：manifest 切片名与 SliceStateMap 必须一一对应。
 * 新增切片只登记一处时（漏了另一处）此处报错，避免运行时才暴露 undefined 状态。
 */
type AssertSlicesCovered = SliceName extends keyof SliceStateMap
  ? keyof SliceStateMap extends SliceName
    ? true
    : false
  : false;
const _slicesCovered: AssertSlicesCovered = true;
void _slicesCovered;

/** 每条目的分片状态聚合（-readonly：reduce 惰性拷贝时原地换片）。 */
export type EntryData = { -readonly [K in keyof Slices]: SliceStateOf<K> };

/** 条目：登记键 + 类别 + 全部分片状态。条目替换不可变，leave 即整体移除。 */
export interface SessionEntry {
  readonly key: WorkspaceKey;
  readonly kind: EntryKind;
  readonly data: EntryData;
}

/**
 * 条目在快照里的呈现：只有结构（键 + 类别），不带切片状态。
 * 切片状态经 getSlice/subscribeSlice 读取——快照不随热路径切片变化而失效，
 * 这样根组件订阅快照就永远不会被 20Hz 流式更新唤醒，也读不到过期数据。
 */
export interface WorkspaceEntryRef {
  readonly key: WorkspaceKey;
  readonly kind: EntryKind;
}

/** 对外只读快照：订阅者/选择器只依赖引用相等。 */
export interface WorkspaceSnapshot {
  readonly revision: number;
  readonly entries: ReadonlyMap<WorkspaceKey, WorkspaceEntryRef>;
  readonly focus: WorkspaceFocus | null;
}

export interface SessionWorkspaceStore {
  /** 当前快照；两次真实变更之间引用稳定（uSES 契约）。 */
  getSnapshot(): WorkspaceSnapshot;
  /**
   * 结构性订阅：**仅在焦点变化或条目增删时**触发，切片状态变化不触发。
   * 根组件据此渲染全局 chrome（焦点条目、成员集合），不会因 20Hz 流式切片被唤醒。
   */
  subscribe(listener: () => void): () => void;
  /**
   * 按 (key, slice) 订阅：该条目的该切片状态变化时触发；条目被移除也触发
   * （订阅者随后 getSlice 得到 undefined，据此回退默认值）。
   * 这是热路径（20Hz thinking）唯一该走的订阅面。
   */
  subscribeSlice(key: WorkspaceKey, slice: SliceName, listener: () => void): () => void;
  /** 读取某条目的某切片状态；条目不存在返回 undefined。引用稳定。 */
  getSlice<K extends SliceName>(key: WorkspaceKey, slice: K): SliceStateOf<K> | undefined;

  // ── 生命周期（成员关系适配器调用）────────────────────
  /** 登记 tab 条目并 seed 全部分片。已存在返回 false 且不重置（幂等）。 */
  joinTab(sessionKey: string): boolean;
  /** 登记 project 条目。已存在返回 false 且不重置。 */
  joinProject(projectId: string): boolean;
  /** 移除条目（dispose）。聚焦该条目时焦点一并清空。不存在返回 false。 */
  leave(key: WorkspaceKey): boolean;
  has(key: WorkspaceKey): boolean;

  // ── 焦点（用户意图）────────────────────────────────
  /** 聚焦已存在的 tab 条目；未知 key 返回 false（先 join 再 activate）。 */
  activate(sessionKey: string): boolean;
  /** 聚焦已存在的 project 条目；未知 key 返回 false。 */
  focusProject(projectId: string): boolean;
  clearFocus(): void;

  // ── dispatch ──────────────────────────────────────
  /** 绑定焦点：作用于焦点条目。无焦点返回 false。 */
  dispatchActive(action: WorkspaceAction): boolean;
  /** 显式 key：作用于后台条目（事件驱动）。条目不存在返回 false。 */
  dispatchTo(key: WorkspaceKey, action: WorkspaceAction): boolean;
}

/** 按 kind seed 全部分片；条目 join 时调用。与 workspaceSlices 同步维护。 */
function seedEntryData(kind: EntryKind): EntryData {
  return {
    composer: composerSlice.seed(kind),
    thinking: thinkingSlice.seed(kind),
  } as EntryData;
}

/** 把动作喂给全部分片；只有确实变化的切片名会被收集，用于精确唤醒订阅者。 */
function reduceEntryData(
  data: EntryData,
  action: WorkspaceAction,
): { data: EntryData; changedSlices: SliceName[] } {
  let next: EntryData | null = null;
  let changedSlices: SliceName[] | null = null;
  for (const name of Object.keys(workspaceSlices) as SliceName[]) {
    const slice = workspaceSlices[name];
    const current = data[name];
    const reduced = slice.reduce(current as never, action) as SliceStateOf<SliceName>;
    if (reduced === current) continue;
    // 惰性分配：只在确实有切片变化时创建数组/浅拷贝，热路径空转零成本
    changedSlices ??= [];
    changedSlices.push(name);
    next ??= { ...data };
    (next as EntryData)[name] = reduced as never;
  }
  return next && changedSlices ? { data: next, changedSlices } : { data, changedSlices: [] };
}

/** 工厂：单测/隔离各造新 store；App 层持默认单例。 */
export function createSessionWorkspaceStore(): SessionWorkspaceStore {
  let revision = 0;
  let entries = new Map<WorkspaceKey, SessionEntry>();
  /** 快照里的结构视图：只在结构变化时重建，切片变化不碰。 */
  let entryRefs = new Map<WorkspaceKey, WorkspaceEntryRef>();
  let focus: WorkspaceFocus | null = null;
  let snapshot: WorkspaceSnapshot | null = null;
  /** 结构订阅者：焦点/成员变化时唤醒（根组件）。 */
  const listeners = new Set<() => void>();
  /** 切片订阅者：key → slice → listeners（热路径精确唤醒）。 */
  const sliceListeners = new Map<WorkspaceKey, Map<SliceName, Set<() => void>>>();

  function currentSnapshot(): WorkspaceSnapshot {
    // 快照缓存：真实结构变更间引用稳定（不变式 3），subscribe 只在替换后触发
    return (snapshot ??= { revision, entries: entryRefs, focus });
  }

  /** 唤醒该 key 指定切片的订阅者（叶子组件）。 */
  function notifySlices(key: WorkspaceKey, changedSlices: SliceName[] | "all") {
    const byKey = sliceListeners.get(key);
    if (!byKey) return;
    if (changedSlices === "all") {
      for (const set of byKey.values()) for (const listener of [...set]) listener();
      return;
    }
    for (const name of changedSlices) {
      const set = byKey.get(name);
      if (!set) continue;
      for (const listener of [...set]) listener();
    }
  }

  /** 结构变化（焦点/成员）：替换快照 + 唤醒结构订阅者。 */
  function commitStructure(nextEntries: Map<WorkspaceKey, SessionEntry>, nextFocus: WorkspaceFocus | null) {
    entries = nextEntries;
    entryRefs = new Map();
    for (const [key, entry] of nextEntries) entryRefs.set(key, { key: entry.key, kind: entry.kind });
    focus = nextFocus;
    revision += 1;
    snapshot = null;
    for (const listener of listeners) listener();
  }

  function applyToEntry(key: WorkspaceKey, action: WorkspaceAction): boolean {
    const entry = entries.get(key);
    if (!entry) return false; // 不变式 4：目标不存在 = false，不抛错
    const { data, changedSlices } = reduceEntryData(entry.data, action);
    if (changedSlices.length === 0) return true; // 有效 dispatch 但无实际变更：不替换、不通知
    const nextEntries = new Map(entries);
    nextEntries.set(key, { ...entry, data });
    // 切片变化不产生新结构、不 bump revision：快照引用保持稳定，
    // 结构订阅者（根组件）不被热路径唤醒，只有该切片的订阅者收到通知。
    entries = nextEntries;
    notifySlices(key, changedSlices);
    return true;
  }

  return {
    getSnapshot: currentSnapshot,

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    subscribeSlice(key: WorkspaceKey, slice: SliceName, listener: () => void): () => void {
      let byKey = sliceListeners.get(key);
      if (!byKey) {
        byKey = new Map();
        sliceListeners.set(key, byKey);
      }
      let set = byKey.get(slice);
      if (!set) {
        set = new Set();
        byKey.set(slice, set);
      }
      set.add(listener);
      return () => {
        const current = sliceListeners.get(key)?.get(slice);
        current?.delete(listener);
        // 清空空集合，避免长会话里每个历史 key 常驻空 Map
        if (current && current.size === 0) sliceListeners.get(key)?.delete(slice);
        if (sliceListeners.get(key)?.size === 0) sliceListeners.delete(key);
      };
    },

    getSlice<K extends SliceName>(key: WorkspaceKey, slice: K): SliceStateOf<K> | undefined {
      return entries.get(key)?.data[slice] as SliceStateOf<K> | undefined;
    },

    joinTab(sessionKey: string): boolean {
      if (entries.has(sessionKey)) return false;
      const nextEntries = new Map(entries);
      nextEntries.set(sessionKey, {
        key: sessionKey,
        kind: "tab",
        data: seedEntryData("tab"),
      });
      commitStructure(nextEntries, focus);
      notifySlices(sessionKey, "all");
      return true;
    },

    joinProject(projectId: string): boolean {
      const key = projectKey(projectId);
      if (entries.has(key)) return false;
      const nextEntries = new Map(entries);
      nextEntries.set(key, { key, kind: "project", data: seedEntryData("project") });
      commitStructure(nextEntries, focus);
      notifySlices(key, "all");
      return true;
    },

    leave(key: WorkspaceKey): boolean {
      if (!entries.has(key)) return false;
      const nextEntries = new Map(entries);
      nextEntries.delete(key);
      // 不变式 1：聚焦条目消失 → 清焦点，不留悬空引用
      const nextFocus = focus && focusKey(focus) === key ? null : focus;
      commitStructure(nextEntries, nextFocus);
      // 条目消失对每个切片都是变化：订阅者 getSlice 得 undefined，自行回退默认值
      notifySlices(key, "all");
      return true;
    },

    has(key: WorkspaceKey): boolean {
      return entries.has(key);
    },

    activate(sessionKey: string): boolean {
      const entry = entries.get(sessionKey);
      if (!entry || entry.kind !== "tab") return false;
      if (focus?.kind === "tab" && focus.sessionKey === sessionKey) return true;
      commitStructure(entries, { kind: "tab", sessionKey });
      return true;
    },

    focusProject(projectId: string): boolean {
      const entry = entries.get(projectKey(projectId));
      if (!entry || entry.kind !== "project") return false;
      if (focus?.kind === "project" && focus.projectId === projectId) return true;
      commitStructure(entries, { kind: "project", projectId });
      return true;
    },

    clearFocus(): void {
      if (!focus) return;
      commitStructure(entries, null);
    },

    dispatchActive(action: WorkspaceAction): boolean {
      if (!focus) return false;
      return applyToEntry(focusKey(focus), action);
    },

    dispatchTo(key: WorkspaceKey, action: WorkspaceAction): boolean {
      return applyToEntry(key, action);
    },
  };
}
