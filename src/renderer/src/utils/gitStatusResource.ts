import type { PiDesktopApi } from "../../../shared/api";
import type { GitBranchInfo, GitResourceGroups } from "../../../shared/types";
import { sameResourceGroups } from "./gitResourceGroups";

/**
 * Git 面板的状态资源（status / branches 的生命周期 module）。
 *
 * 为什么把它抽出来：面板此前同时持有 5 个 ref 与 7 个 state 来维护「拉取中/已作废/
 * mutation 在跑/面板是否可见」，两段 30s 轮询各自复制了一份 visibilitychange + focus
 * 绑定。四条互相依赖的隐式规则散在 300 行里，任何一条改错都只表现为「列表偶尔不更新」
 * 或「后台疯狂 spawn git」，没有可测的接缝。这里把**状态 + 拉取 + 陈旧守卫 + 变更门 +
 * 轮询调度**收进同一个 module，外面只订阅快照、发意图：
 *
 * - 陈旧守卫：世代号 + 请求号，项目切换/卸载后迟到的响应一律丢弃；
 * - 单飞：静默拉取在 mutation 或在途请求期间不新开请求（合并到在途 promise），
 *   否则慢于 30s 的 status 会彼此作废，列表永久停在旧值；
 * - 变更门：同一时刻只允许一个 mutation，且旧项目的 mutation 收尾不能解锁新项目；
 * - 轮询：一份调度同时覆盖 status 与 branches，可见性 = 面板在视口内（IntersectionObserver）
 *   + 文档可见（visibilitychange）+ CSS 可见（checkVisibility），焦点/重新可见即刻补一次。
 */

/** 可见状态下的兜底轮询间隔：焦点、重新可见、git 操作后都会立即刷新，
 *  30s 只兜底外部编辑器/终端里发生的改动，避免面板可见时高频 spawn git。 */
export const GIT_POLL_INTERVAL_MS = 30_000;

/** 共享空分组：快照默认值/错误回退必须是稳定引用，否则每次落地都换新对象，
 *  整棵资源树（大仓库数千行）会跟着无意义地重渲染。 */
const EMPTY_GROUPS: GitResourceGroups = Object.freeze({
	merge: [],
	index: [],
	workingTree: [],
	untracked: [],
}) as GitResourceGroups;

const EMPTY_BRANCH_INFO: GitBranchInfo = Object.freeze({
	current: null,
	branches: Object.freeze([]) as unknown as string[],
}) as GitBranchInfo;

/** 面板需要的最小 git 门面：只取 status/branches/probe，避免整个 PiDesktopApi 漂移。 */
export type GitStatusSource = Pick<
	PiDesktopApi["git"],
	"status" | "probe" | "branches"
>;

/** 面板渲染所需的全部状态；引用在内容变化时才替换（配合 useSyncExternalStore）。 */
export type GitStatusSnapshot = {
	groups: GitResourceGroups;
	branchInfo: GitBranchInfo;
	/** 仅非静默拉取为 true：静默拉取不显示 loading、不打断阅读。 */
	loading: boolean;
	error: string | null;
	/** 是否有 mutation（stage/commit/push/pull…）在跑。 */
	mutating: boolean;
	notAGitRepo: boolean;
	gitNotInstalled: boolean;
};

/** 变更门票据：不透明，只能原样交回 endMutation。 */
export type GitMutationTicket = { readonly id: number };

/** 一次 mutation 的收尾结果：调用方据此决定提示与状态复位，不必自己判定「是否过期」。 */
export type GitMutationOutcome<T> =
	| { kind: "ok"; value: T }
	/** 门被占：本次意图被丢弃，调用方不得改动任何状态（连 spinner 都不该亮）。 */
	| { kind: "skipped" }
	/** 执行期间项目被切走：结果作废，且没有触碰新项目的门与状态。 */
	| { kind: "stale" }
	/** 失败：错误已写进快照，`onNotice` 已按调用方意图调用。 */
	| { kind: "failed"; errorMessage: string };

export type GitStatusResourceOptions = {
	/** 每次请求时读一次：git 门面由 App 注入，重渲染后引用可能被替换。 */
	git: () => GitStatusSource;
	projectId: string;
	/** 首帧种子（App 统一 store 的最新分支信息），避免面板打开时分支栏空白。 */
	initialBranchInfo?: GitBranchInfo;
};

export type GitStatusResource = {
	getSnapshot(): GitStatusSnapshot;
	subscribe(listener: () => void): () => void;
	/** 拉取工作区状态。silent 用于轮询：不显示 loading、不覆盖错误、可与在途请求合并。 */
	refresh(options?: { silent?: boolean }): Promise<void>;
	/**
	 * 单独拉取分支列表（commit/checkout 只需分支，不必重跑整棵 status）。
	 * force：mutation 后的意图刷新不得被在途读取合并。
	 */
	refreshBranches(options?: { force?: boolean }): Promise<void>;
	/**
	 * 执行一次 mutation（占门 → 跑 → 作废旧项目结果 → 刷新 → 解锁）。
	 *
	 * 为什么放在 module 而不在面板：面板里 stage/discard/commit/push/pull 四条路径
	 * 此前各抄了一遍「beginMutation、捕获 projectId、失败映射、endMutation、复位
	 * 各自的 spinner」。门锁在 module 里而骨架在面板里，等于把同一套规则切两半——
	 * 新增一条 mutation 就得再抄一遍，抄漏 `projectId !== projectIdRef.current`
	 * 就会让旧项目的结果写进新项目。
	 *
	 * 结果区分四种收尾：`skipped`（门被占，调用方不该改任何状态）、`stale`
	 * （跑到一半项目切走，结果丢弃且不 unlock 新项目）、`failed`（错误已写入快照，
	 * `onNotice` 由调用方决定是否弹全局提示）、`ok`。
	 */
	runMutation<T>(options: {
		run: (projectId: string) => Promise<T>;
		/** 成功后的刷新策略；默认只刷 status。 */
		refresh?: "status" | "status+branches" | "none";
		onNotice?: (message: string) => void;
	}): Promise<GitMutationOutcome<T>>;
	setError(message: string | null): void;
	/** 采纳 App 侧 checkout/create 返回的分支信息，省掉一次自拉取。 */
	setBranchInfo(info: GitBranchInfo): void;
	/** init 成功后立刻清掉「不是仓库/没装 git」提示位，不必等下一次 status 成功。 */
	clearRepoFlags(): void;
	/** 项目切换：作废在途请求与 mutation，清空状态，然后拉一次 status 与 branches。 */
	setProject(projectId: string, initialBranchInfo?: GitBranchInfo): void;
	/** 安装轮询（可见性 + 焦点 + 30s 兜底）；返回 dispose。重复安装会先卸掉旧的。 */
	install(element: HTMLElement | null): () => void;
};

/**
 * 面板在 DOM 中是否真的可见。
 * 抽屉的 diff 视图用 `visibility: hidden` 覆盖源码面板：布局盒还在，IntersectionObserver
 * 仍会报告相交，只有 checkVisibility 能看到这层 CSS 可见性。用于轮询触发前的最后一道判断，
 * 避免用户看不到面板时仍然 spawn git。
 */
function panelActuallyVisible(element: HTMLElement | null): boolean {
	if (!element) return false;
	if (typeof element.checkVisibility === "function") {
		return element.checkVisibility({ checkVisibilityCSS: true });
	}
	return getComputedStyle(element).visibility !== "hidden";
}

export function createGitStatusResource(
	options: GitStatusResourceOptions,
): GitStatusResource {
	let projectId = options.projectId;
	let snapshot: GitStatusSnapshot = {
		groups: EMPTY_GROUPS,
		branchInfo: options.initialBranchInfo ?? EMPTY_BRANCH_INFO,
		loading: false,
		error: null,
		mutating: false,
		notAGitRepo: false,
		gitNotInstalled: false,
	};
	const listeners = new Set<() => void>();

	const publish = (patch: Partial<GitStatusSnapshot>): void => {
		// 全部字段 Object.is 相等时不动快照：useSyncExternalStore 用 Object.is 比较快照，
		// 每次轮询都换新信封会让整棵资源树（含文件树与 git 图）白白重渲染。
		let changed = false;
		for (const key of Object.keys(patch) as (keyof GitStatusSnapshot)[]) {
			if (!Object.is(snapshot[key], patch[key])) {
				changed = true;
				break;
			}
		}
		if (!changed) return;
		snapshot = { ...snapshot, ...patch };
		for (const listener of [...listeners]) listener();
	};

	/**
	 * 世代号：项目切换/卸载时自增，让在途响应整体作废。
	 * 单靠请求号不够——项目切换不会重置请求号，旧项目里更晚发出的请求在序号上
	 * 看起来仍然「最新」。
	 */
	let generation = 0;
	let statusRequestId = 0;
	/** 分支读取的请求号：分支栏的意图刷新要能作废更早发出的在途读取。 */
	let branchRequestId = 0;
	/** 在途 status 请求：静默拉取（轮询/重新可见）合并到它，而不是另开一次。 */
	let statusInFlight: { promise: Promise<void> } | null = null;
	let branchesInFlight: Promise<void> | null = null;
	let mutationTicket: GitMutationTicket | null = null;
	let mutationSequence = 0;
	let installed: { dispose(): void } | null = null;

	const invalidateRequests = (): void => {
		generation += 1;
		statusRequestId += 1;
		branchRequestId += 1;
		statusInFlight = null;
		branchesInFlight = null;
	};

	async function runStatus(
		requestId: number,
		requestGeneration: number,
		requestProjectId: string,
		silent: boolean,
	): Promise<void> {
		const git = options.git();
		try {
			const next = await git.status(requestProjectId);
			if (requestId !== statusRequestId || requestGeneration !== generation) return;
			// 内容未变时保留旧引用：轮询是兜底通道，工作区没变就别让整棵资源树重渲染。
			publish({
				groups: sameResourceGroups(snapshot.groups, next)
					? snapshot.groups
					: next,
				// 状态成功即证明 git 可用且目录是仓库：两个提示位必须随之清零。
				gitNotInstalled: false,
				notAGitRepo: false,
			});
		} catch (caught) {
			// 静默失败不影响已展示的旧分组数据；不做任何 UI 状态变更。
			if (
				silent ||
				requestId !== statusRequestId ||
				requestGeneration !== generation
			)
				return;
			publish({ groups: EMPTY_GROUPS });
			// 失败分类不在渲染层猜：两种可恢复原因（没装 git / 不是仓库）由主进程 probe 直接回答。
			// 此前靠正则匹配命令失败的英文文案，文案一变安装指引就会静默消失。
			try {
				const probe = await git.probe(requestProjectId);
				if (
					requestId !== statusRequestId ||
					requestGeneration !== generation
				) {
					return;
				}
				publish({
					gitNotInstalled: !probe.gitAvailable,
					notAGitRepo: probe.gitAvailable && !probe.isRepo,
					// probe 说仓库正常：这次的失败就是普通命令错误，直接展示干净 message。
					error:
						probe.gitAvailable && probe.isRepo
							? caught instanceof Error
								? caught.message
								: String(caught)
							: "",
				});
			} catch {
				if (
					requestId !== statusRequestId ||
					requestGeneration !== generation
				) {
					return;
				}
				// probe 自身失败（项目被移除等）：退回显示干净的错误信息。
				publish({
					error: caught instanceof Error ? caught.message : String(caught),
				});
			}
		}
	}

	function refresh(requestOptions: { silent?: boolean } = {}): Promise<void> {
		const silent = requestOptions.silent === true;
		// 单飞：静默拉取在 mutation 或在途请求期间不再新开请求。mutation 结束后
		// 调用方本来就会拉一次；而在途请求期间再开一个只会让两个慢请求彼此作废。
		if (silent) {
			if (mutationTicket) return Promise.resolve();
			if (statusInFlight) return statusInFlight.promise;
		}
		const requestId = ++statusRequestId;
		const requestGeneration = generation;
		const requestProjectId = projectId;
		if (!silent) publish({ loading: true, error: null });
		// runStatus 是 async，永远不会同步抛出：finally 回调里的 promise 引用已初始化。
		const promise = runStatus(
			requestId,
			requestGeneration,
			requestProjectId,
			silent,
		).finally(() => {
			if (statusInFlight?.promise === promise) statusInFlight = null;
			if (!silent && requestId === statusRequestId && requestGeneration === generation) {
				publish({ loading: false });
			}
		});
		statusInFlight = { promise };
		return promise;
	}

	function refreshBranches(requestOptions: { force?: boolean } = {}): Promise<void> {
		// 单飞：挂载、轮询 sync、窗口 focus 可能在同一帧连续触发，合并成一次 IPC。
		// force 例外：mutation 之后的意图刷新（提交可能删掉已合并分支、切出 detached HEAD）
		// 一旦被合并进 mutation 之前发出的在途读取，就会拿回 mutation 前的分支列表，
		// 分支栏要等下一次轮询才纠正。
		if (branchesInFlight && requestOptions.force !== true) return branchesInFlight;
		const requestId = ++branchRequestId;
		const requestGeneration = generation;
		const requestProjectId = projectId;
		const promise = (async () => {
			try {
				const next = await options.git().branches(requestProjectId);
				// 请求号 + 世代号：本地采纳的 checkout/create 结果与更新的刷新都能作废本响应，
				// 否则更早发出的读取晚到时会把分支栏翻回旧分支。
				if (requestId !== branchRequestId || requestGeneration !== generation) return;
				// 分支可能在外部终端/IDE 中切换：只在状态真的变化时更新，避免无意义重渲染。
				const current = snapshot.branchInfo;
				if (
					current.current === next.current &&
					current.branches.join("\n") === next.branches.join("\n")
				) {
					return;
				}
				publish({ branchInfo: next });
			} catch {
				if (requestId !== branchRequestId || requestGeneration !== generation) return;
				publish({ branchInfo: EMPTY_BRANCH_INFO });
			}
		})().finally(() => {
			if (branchesInFlight === promise) branchesInFlight = null;
		});
		branchesInFlight = promise;
		return promise;
	}

	function beginMutation(): GitMutationTicket | null {
		// 变更门：同一时刻只允许一个 mutation，避免 stage/commit/push 交叉改写工作区。
		if (mutationTicket) return null;
		const ticket: GitMutationTicket = { id: ++mutationSequence };
		mutationTicket = ticket;
		publish({ mutating: true });
		return ticket;
	}

	function endMutation(ticket: GitMutationTicket): void {
		// 引用比较（而非 id 比较）：项目切换会清空 ticket，旧 mutation 的收尾
		// 不能解锁新项目刚开始的 mutation。
		if (mutationTicket !== ticket) return;
		mutationTicket = null;
		publish({ mutating: false });
	}

	/**
	 * 一次 mutation 的完整生命周期。面板里所有会改写工作区的操作都必须走这里：
	 * 门、世代校验、错误落地、刷新策略、解锁只有一份实现。
	 */
	async function runMutation<T>(mutation: {
		run: (projectId: string) => Promise<T>;
		refresh?: "status" | "status+branches" | "none";
		onNotice?: (message: string) => void;
	}): Promise<GitMutationOutcome<T>> {
		const ticket = beginMutation();
		// 门被占：调用方连 spinner 都不该亮，所以这里不做任何状态改动。
		if (!ticket) return { kind: "skipped" };
		// 失败后要不要补一次静默刷新：必须在门释放后做（见 finally），故先记意图。
		let failureRefreshNeeded = false;
		// 项目 id 在开跑时捕获：跑完再读会拿到切换后的新项目。
		const requestProjectId = projectId;
		const requestGeneration = generation;
		// 开跑即清上一轮错误：操作已经重新发起，旧报错留在面板上会被误读成这次的结果。
		// （失败路径自己会写回新错误，close 顺序不影响可读性。）
		setError(null);
		try {
			const value = await mutation.run(requestProjectId);
			// 世代号是「是否还是同一项目」的唯一判据：项目切走再切回同一 id 时 id 相同、
			// 世代号不同，结果仍然必须作废。
			if (requestGeneration !== generation) return { kind: "stale" };
			switch (mutation.refresh ?? "status") {
				case "status":
					await refresh();
					break;
				case "status+branches":
					await refresh();
					// force：不能合并进 mutation 之前发出的在途读取，否则拿回的是改前的分支表。
					void refreshBranches({ force: true });
					break;
				case "none":
					break;
			}
			return { kind: "ok", value };
		} catch (caught) {
			// 项目已切走：错误属于旧项目，写进新项目快照就是串味。
			if (requestGeneration !== generation) return { kind: "stale" };
			const message = caught instanceof Error ? caught.message : String(caught);
			setError(message);
			mutation.onNotice?.(message);
			// mutation 期间被丢弃的静默轮询没人补偿：失败也可能是「一半已应用」
			// （commit 失败但 stageAll 成功、pull 冲突等），不刷新就会让面板停在
			// 改动前的分组上，最长 30s 或直到用户手动刷新。
			// 这里只记意图：mutationTicket 到 finally 才释放，此刻调 refresh 会被单飞门
			// 直接返回（见 refresh 的 silent 分支），是一句看起来有效、实际什么都不做的代码。
			failureRefreshNeeded = true;
			return { kind: "failed", errorMessage: message };
		} finally {
			// 项目已切换时 ticket 已被作废，这次收尾是 no-op（见 endMutation 的引用比较）。
			endMutation(ticket);
			// 静默模式不写 error/loading，不会冲掉刚落的错误文案。
			if (failureRefreshNeeded) void refresh({ silent: true });
		}
	}

	function setError(message: string | null): void {
		if (snapshot.error === message) return;
		publish({ error: message });
	}

	function setBranchInfo(info: GitBranchInfo): void {
		// 本地采纳的结果（checkout / create）就是最新事实：作废在途的分支读取，
		// 否则更早发出的读取晚到会把分支栏翻回旧分支。
		branchRequestId += 1;
		// 同时丢掉在途记录：否则下一次 force=false 的刷新会被合并进这个注定作废的
		// promise —— 它既不发 IPC 也不会 publish，等于白扔一个轮询周期。
		branchesInFlight = null;
		const current = snapshot.branchInfo;
		if (
			current.current === info.current &&
			current.branches.join("\n") === info.branches.join("\n")
		) {
			return;
		}
		publish({ branchInfo: info });
	}

	function clearRepoFlags(): void {
		if (!snapshot.notAGitRepo && !snapshot.gitNotInstalled) return;
		publish({ notAGitRepo: false, gitNotInstalled: false });
	}

	function setProject(
		nextProjectId: string,
		initialBranchInfo?: GitBranchInfo,
	): void {
		projectId = nextProjectId;
		invalidateRequests();
		mutationTicket = null;
		publish({
			groups: EMPTY_GROUPS,
			// initialBranchInfo 只作为项目切换时的种子；之后由自拉取维护。
			branchInfo: initialBranchInfo ?? EMPTY_BRANCH_INFO,
			loading: false,
			error: null,
			mutating: false,
			notAGitRepo: false,
			gitNotInstalled: false,
		});
		void refreshBranches();
		void refresh();
	}

	function install(element: HTMLElement | null): () => void {
		installed?.dispose();

		// 观察者首帧回调前按可见处理：首屏必须照常拉一次。
		let panelVisible = true;
		let timer: number | undefined;

		const stopTimer = (): void => {
			if (timer === undefined) return;
			window.clearInterval(timer);
			timer = undefined;
		};

		/** 不可见就停表；可见就立刻补一次（焦点/重新可见要求即刻刷新）并保证有 30s 兜底。 */
		const sync = (): void => {
			if (!panelVisible || document.visibilityState !== "visible") {
				stopTimer();
				return;
			}
			void refreshBranches();
			void refresh({ silent: true });
			if (timer === undefined) {
				timer = window.setInterval(() => {
					// 抽屉用 visibility:hidden 覆盖面板时布局盒仍在、IntersectionObserver 仍报相交；
					// checkVisibility 是 spawn git 前的最后一道判断。
					if (!panelActuallyVisible(element)) return;
					void refreshBranches();
					void refresh({ silent: true });
				}, GIT_POLL_INTERVAL_MS);
			}
		};

		let observer: IntersectionObserver | null = null;
		if (element && typeof IntersectionObserver !== "undefined") {
			observer = new IntersectionObserver((entries) => {
				const entry = entries[entries.length - 1];
				if (!entry) return;
				panelVisible = entry.isIntersecting;
				sync();
			});
			observer.observe(element);
		}

		document.addEventListener("visibilitychange", sync);
		window.addEventListener("focus", sync);
		sync();

		const handle = {
			dispose: (): void => {
				stopTimer();
				observer?.disconnect();
				document.removeEventListener("visibilitychange", sync);
				window.removeEventListener("focus", sync);
				// 卸载/重装后作废在途响应：面板已经不可见，迟到的结果没有消费者。
				invalidateRequests();
				if (installed === handle) installed = null;
			},
		};
		installed = handle;
		return handle.dispose;
	}

	return {
		getSnapshot: () => snapshot,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		refresh,
		refreshBranches,
		runMutation,
		setError,
		setBranchInfo,
		clearRepoFlags,
		setProject,
		install,
	};
}
