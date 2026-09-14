/** 输入建议浮层：按 composer trigger 渲染命令与模板建议。 */
import { useEffect, useRef } from "react";
import { type SuggestionItem } from "../AppUtils";
import { Folder, X } from "lucide-react";
import { t } from "../../../i18n";
import { IconButton } from "../../ui/IconButton";

export function PromptSuggestions(props: {
	prompt: string;
	items: SuggestionItem[];
	selectedIndex: number;
	onSelectedIndexChange: (index: number) => void;
	onClose: () => void;
	onPick: (value: string) => void;
	/** 菜单锚定位置（屏幕坐标），未传则使用默认居中定位 */
	anchorStyle?: React.CSSProperties;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	// 头部标题类型由选中项推导:光标相关触发后,第一个候选的 value 前缀即代表当前是命令还是文件。
	const isCommand = props.items[0]?.value.startsWith("/") ?? false;
	const isSession = props.items[0]?.value.startsWith("&") ?? false;
	const headerLabel = isCommand ? t("prompt.commands") : isSession ? t("prompt.sessions") : t("prompt.files");

	// 滚动到选中项
	useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const item = list.children[props.selectedIndex] as HTMLElement;
		if (item) {
			item.scrollIntoView({ block: "nearest" });
		}
	}, [props.selectedIndex]);

	if (props.items.length === 0) return null;

	// 阻止 mousedown 冒泡到 RichInput，避免点击面板时触发 blur 关闭面板，
	// 但保留各按钮的 onClick 正常工作。
	return (
		<div
			className="command-palette"
			style={props.anchorStyle}
			onMouseDown={(e) => e.preventDefault()}
		>
			<div className="command-palette-header">
				<span>{headerLabel}</span>
				<IconButton
					className="command-palette-close"
					label={t("common.close")}
					onClick={props.onClose}
				>
					<X size={16} strokeWidth={2.2} aria-hidden="true" />
				</IconButton>
			</div>
			<div className="command-palette-list" ref={listRef}>
				{props.items.map((item, index) => {
				const indent = item.treeDepth != null ? `${item.treeDepth * 20}px` : "0px";
			if (item.disabled) {
					// 不可选分组头（保留兼容）；目录本身已改为可选建议项
					return (
						<div
							key={item.key}
							className={`command-palette-tree-dir${index === props.selectedIndex ? " selected" : ""}`}
							style={{ paddingLeft: `calc(12px + ${indent})` }}
							onMouseEnter={() => props.onSelectedIndexChange(index)}
						>
							<Folder size={12} aria-hidden="true" />
							<span>{item.label}</span>
						</div>
					);
				}
				return (
					<button
						key={item.key}
						className={`command-palette-item${item.isDirectory ? " is-directory" : ""}${index === props.selectedIndex ? " selected" : ""}`}
						style={{ paddingLeft: `calc(12px + ${indent})` }}
						onMouseEnter={() => props.onSelectedIndexChange(index)}
						onClick={() => props.onPick(item.value)}
					>
						{item.isDirectory ? (
							<span className="command-palette-label command-palette-dir-label">
								<Folder size={13} strokeWidth={1.8} aria-hidden="true" />
								{item.label}
							</span>
						) : (
							<span className="command-palette-label">{item.label}</span>
						)}
						<span className="command-palette-desc">{item.description}</span>
					</button>
				);
			})}
			</div>
			<div className="command-palette-footer">
				<span>{t("prompt.selectHint")}</span>
				<span>{t("prompt.confirmHint")}</span>
				<span>{t("prompt.closeHint")}</span>
			</div>
		</div>
	);
}
