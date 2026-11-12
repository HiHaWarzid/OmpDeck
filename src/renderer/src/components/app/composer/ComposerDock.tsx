/**
 * composer 上方的统一面板 dock：TODO / 子代理 / 待发送三块共享一行 chip，手风琴展开。
 *
 * 为什么合并：三块面板各自撑高时最坏叠加约 700px（TODO 190 + 子代理 247 + 队列 125 +
 * 输入框 175），时间线会被压成一条缝。dock 常驻只有一行 chip，展开块共享同一个高度上限。
 *
 * 布局技巧：`DockSection` 用 `display: contents` 打散，body 用 `order: -1` + 整行宽度
 * 排到 chips 上方，chips 按 DOM 顺序在下方成行。这样 section 可以自己订阅数据
 * （子代理切片约 150ms 一批，不能挂到 App 根组件），又不需要 portal 把 chip 和 body
 * 拆进两个容器。
 */
import { ChevronDown } from "lucide-react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type CSSProperties,
	type KeyboardEvent,
	type ReactNode,
	type Ref,
} from "react";

type DockSectionId = string;

type ComposerDockContextValue = {
	openId: DockSectionId | null;
	toggle: (id: DockSectionId) => void;
	/** 分区被 hidden 后收起：否则同一分区重新出现时会带着旧的展开态自动撑开。 */
	close: (id: DockSectionId) => void;
};

const ComposerDockContext = createContext<ComposerDockContextValue | null>(null);

export function ComposerDock({
	children,
	maxBodyHeight,
	containerRef,
}: {
	children: ReactNode;
	/** 展开块的高度上限，由 App 按“时间线最小高度 + 输入框最小高度”的剩余空间算出。 */
	maxBodyHeight: number;
	/** App 用它测量 dock 实际高度（从 chrome 里扣除，算其它面板占用的空间）。 */
	containerRef?: Ref<HTMLDivElement>;
}) {
	const [openId, setOpenId] = useState<DockSectionId | null>(null);
	// 手风琴：点已展开的 chip = 收起，点另一块 = 替换展开项，保证同一时刻最多一块占用高度。
	const toggle = useCallback((id: DockSectionId) => {
		setOpenId((current) => (current === id ? null : id));
	}, []);
	const close = useCallback((id: DockSectionId) => {
		setOpenId((current) => (current === id ? null : current));
	}, []);
	const value = useMemo(() => ({ openId, toggle, close }), [openId, toggle, close]);
	// 展开块占着时间线空间时，Esc 先收起它，不再往上冒泡去关抽屉/弹层。
	// 焦点在展开块内的输入框（子代理 steer 草稿）时不收：那会把正在写的草稿一起丢掉。
	const onKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (event.key !== "Escape" || !openId) return;
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, textarea, [contenteditable='true']")) return;
			event.stopPropagation();
			setOpenId(null);
		},
		[openId],
	);
	return (
		<ComposerDockContext.Provider value={value}>
			<div
				className="composer-dock"
				ref={containerRef}
				onKeyDown={onKeyDown}
				style={{ "--dock-max-height": `${maxBodyHeight}px` } as CSSProperties}
			>
				{children}
			</div>
		</ComposerDockContext.Provider>
	);
}

export type DockChipTone = "neutral" | "info" | "danger";

/**
 * dock 里的一个分区。`hidden` 由调用方按“该块是否有内容”决定：没有内容的块
 * 连 chip 一起消失，避免出现点了没反应的空白 chip。
 */
export function DockSection(props: {
	id: DockSectionId;
	icon: ReactNode;
	label: string;
	/** chip 右侧的状态摘要（数量/进度），为空时只显示标签。 */
	meta?: string;
	tone?: DockChipTone;
	hidden?: boolean;
	children: ReactNode;
}) {
	const context = useContext(ComposerDockContext);
	const hidden = !context || Boolean(props.hidden);
	// 分区因为没内容而 hidden 时必须丢弃展开态：否则数据回来时 body 会自己撑开，
	// 与“点 chip 才展开”的约定相反，还会白占 dock 的高度预算。
	useEffect(() => {
		if (hidden) context?.close(props.id);
	}, [context, hidden, props.id]);
	if (!context || props.hidden) return null;
	const open = context.openId === props.id;
	const bodyId = `composer-dock-body-${props.id}`;
	return (
		<div className="composer-dock-section">
			{open && (
				<div className="composer-dock-body" id={bodyId} role="region" aria-label={props.label}>
					{props.children}
				</div>
			)}
			<button
				type="button"
				className={`composer-dock-chip tone-${props.tone ?? "neutral"}${open ? " is-open" : ""}`}
				onClick={() => context.toggle(props.id)}
				aria-expanded={open}
				aria-controls={open ? bodyId : undefined}
				// 窄布局下 meta 会被省略号截断，title 兜住完整信息。
				title={props.meta ? `${props.label} · ${props.meta}` : undefined}
			>
				<span className="composer-dock-chip-icon" aria-hidden="true">
					{props.icon}
				</span>
				<span className="composer-dock-chip-label">{props.label}</span>
				{props.meta ? <span className="composer-dock-chip-meta">{props.meta}</span> : null}
				<ChevronDown
					size={12}
					strokeWidth={2}
					className={`composer-dock-chip-chevron${open ? " is-open" : ""}`}
					aria-hidden="true"
				/>
			</button>
		</div>
	);
}
