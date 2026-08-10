// ── 桌面宠物类型 ──

/** 宠物聚合动画状态；映射到 spritesheet 的行号。
 *  前 7 个为业务态（由 PetStateBridge 聚合 Agent 状态产出）；
 *  running-right / running-left / review 为本期启用的预留行——
 *  巡游方向帧由 PetPatrol 引擎直接推送，review 由「任务完成」转换触发。 */
export type PetMode =
	| "idle"
	| "running"
	| "failed"
	| "waiting"
	| "waving"
	| "hidden"
	| "jumping"
	| "running-right" // 行1 巡游向右（PetPatrol 驱动）
	| "running-left" // 行2 巡游向左（PetPatrol 驱动）
	| "review"; // 行8 任务完成庆祝（running→idle 转换触发）

/** 多 Agent 聚合后的全局宠物状态，由 PetStateBridge 计算并推送给宠物窗 */
export type PetAggregateState = {
	mode: PetMode;
	/** 当前 running 的 Agent 数 */
	runningCount: number;
	/** 当前 error 的 Agent 数（>0 则 mode=failed，优先级最高） */
	errorCount: number;
	/** 点击宠物跳转目标 Agent id；无活跃 Agent 时为 null */
	activeAgentId: string | null;
	timestamp: number;
};

/** 宠物包清单项，合并内置包与 petdex 社区包后去重得到 */
export type PetManifest = {
	id: string;
	displayName: string;
	description?: string;
	/** 来源：builtin 随应用打包，petdex 扫描自 ~/.codex/pets/ */
	source: "builtin" | "petdex";
	/** 渲染层可加载的 spritesheet URL（内置走打包资源，petdex 走 file://） */
	spritesheetUrl: string;
};


/** 三端宠物窗能力探测结果（设计文档第 5.2 节降级形态） */
export type PetWindowCaps = {
	/** 是否支持透明背景（Linux 部分 WM 不支持） */
	transparent: boolean;
	/** 是否支持点击穿透（MVP 不用，预留） */
	clickThrough: boolean;
	/** 是否支持自由绝对坐标定位（Wayland 受限） */
	freePosition: boolean;
};

/** 宠物通知气泡：出错/完成时在宠物头顶弹出 */
export type PetNotification = {
	type: "error" | "done";
	text: string;
	/** 出错时关联的 Agent id */
	agentId?: string;
	timestamp: number;
};
