/**
 * FileAdapter -- 会话扫描的跨环境文件访问 seam。
 *
 * 两个实现：LocalFileAdapter（node:fs/promises）和 WslFileAdapter（wsl.exe）。
 * SessionScanner 通过 configureWsl() 注入适配器，业务代码不再按环境分支。
 *
 * 方法集由 SessionScanner 的实际文件操作推导，两个实现都覆盖。
 * 参与扫描超时的操作（read/readHead/stat/exists/collectJsonl）接受 AbortSignal。
 */

export type FileVersion = { mtimeMs: number; size: number };

export interface FileAdapter {
	/** 读取文件全部内容 */
	read(path: string, signal?: AbortSignal): Promise<string>;
	/** 只读取文件头部（避免大型 JSONL 全量传输） */
	readHead(path: string, maxBytes: number, signal?: AbortSignal): Promise<string>;
	/** 写入文件内容 */
	write(path: string, content: string): Promise<void>;
	/** 获取修改时间和大小（缓存指纹） */
	stat(path: string, signal?: AbortSignal): Promise<FileVersion>;
	/** 检查文件是否存在 */
	exists(path: string, signal?: AbortSignal): Promise<boolean>;
	/** 检查目录是否存在 */
	existsDir(path: string): Promise<boolean>;
	/** 删除文件 */
	rm(path: string): Promise<void>;
	/** 递归删除目录 */
	rmDir(path: string): Promise<void>;
	/** 复制文件 */
	copy(src: string, dst: string): Promise<void>;
	/** 递归查找目录下所有 *.jsonl 文件 */
	collectJsonl(dir: string, signal?: AbortSignal): Promise<string[]>;
}
