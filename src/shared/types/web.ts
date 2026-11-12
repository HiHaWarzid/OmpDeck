/**
 * Web 服务对外状态：设置页与浏览器客户端共用。
 *
 * 只暴露可用于连接/排障的字段，不回传会话路径等本机隐私。
 */
export type WebServiceStatus = {
	/** 当前是否真的有 server 在监听 */
	running: boolean;
	/** 监听地址（实际绑定值） */
	host: string;
	/** 监听端口（0 表示尚未启动） */
	port: number;
	/** 访问令牌；仅本机设置页读取，浏览器客户端不依赖该字段 */
	token: string | null;
	/** 令牌生成时间（毫秒时间戳） */
	tokenGeneratedAt: number | null;
	/** 令牌过期时间（毫秒时间戳）；null 表示永不过期 */
	tokenExpiresAt: number | null;
	/** 当前请求是否来自回环地址（回环请求可免令牌） */
	loopback: boolean;
	/**
	 * 可直接在手机浏览器打开的地址。host 为 0.0.0.0 时使用第一个非内部
	 * IPv4 地址，保证手机上拿到的是可路由地址而不是 0.0.0.0。
	 */
	url: string;
	/** 所有可路由的局域网地址；多网卡时供设置页选择实际可达的地址。 */
	lanUrls: string[];
};

/** Tailscale Serve 远程访问失败分类；设置页按 code 映射本地化文案。 */
export type RemoteAccessErrorCode =
	| "not-installed"
	| "not-logged-in"
	| "serve-not-enabled"
	| "web-service-off"
	| "port-conflict"
	| "start-failed"
	| "unknown";

/**
 * Tailscale Serve 远程访问状态。
 *
 * 该功能只配置本机 Tailscale CLI，不额外启动代理；`url` 是 tailnet 内的
 * HTTPS 地址，仍需配合 WebServiceStatus.token 才能访问 OmpDeck。
 */
export type RemoteAccessStatus = {
	/** 用户是否启用了远程访问（持久化设置值） */
	enabled: boolean;
	state: "off" | "starting" | "running" | "error";
	provider: "tailscale" | null;
	/** Tailscale CLI 是否找到 */
	installed: boolean;
	/** Tailscale 是否已登录且后端运行中 */
	loggedIn: boolean;
	/** tailnet HTTPS 地址；未运行时为 null */
	url: string | null;
	/** Tailscale 自报的 DNS 名称（不含末尾点） */
	hostname: string | null;
	/** Serve 使用的 HTTPS 端口 */
	httpsPort: number;
	/** 解析到的 CLI 路径，便于排障 */
	binaryPath: string | null;
	/** 失败分类；成功或关闭时为 null */
	errorCode: RemoteAccessErrorCode | null;
	/** 原始错误信息（可能包含 Tailscale 输出）；UI 优先展示 errorCode 文案 */
	error: string | null;
};
