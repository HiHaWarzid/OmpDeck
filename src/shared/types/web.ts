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
