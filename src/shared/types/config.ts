/**
 * 配置保存的「已保存，但有降级」提示。
 *
 * models.json 与 models.yml 是同一份模型配置的两种表示：OmpDeck 读 JSON，
 * pi 侧读 YAML。两文件无法做成单个原子操作，所以镜像写失败时既不能谎报「保存失败」
 * （JSON 确实已落盘），也不能像以前那样 `.catch(() => undefined)` 吞掉——那样两份
 * 表示会静默分叉，pi 继续用旧配置而用户毫无察觉。
 *
 * 因此失败以**结构化提示码**返回：code 供渲染层映射 i18n 文案（可见文本不跨边界
 * 传自由文本），detail 是技术细节，用于让用户/日志定位原因。
 */
export type ConfigSaveWarningCode =
	| "models-yml-mirror-failed"
	| "models-json-mirror-failed";

export type ConfigSaveWarning = {
	code: ConfigSaveWarningCode;
	detail: string;
};

/**
 * config.yml 点路径补丁（omp 全局设置的权威源）。
 *
 * 键 = `omp config list --json` 里的键路径（`retry.maxRetries`、`enabledModels` ...）。
 * 渲染层只提交用户改动过的键，主进程在最新文档上做一次 read-modify-write，
 * 这样注释、schema 外键（modelRoles 等）和其它设置不会被整文件覆盖。
 */
export type OmpConfigSetEntry = {
	/** 点分键路径；每一段对应一层映射键。 */
	path: string;
	/** 省略 / undefined = 删除该键（回到 omp 默认）。 */
	value?: unknown;
};

export type OmpConfigPatch = {
	set?: OmpConfigSetEntry[];
	unset?: string[];
};
