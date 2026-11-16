import {
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
	type ReactNode,
	type RefObject,
} from "react";
import { ChevronDown } from "lucide-react";
import { useDismissableLayer } from "./useDismissableLayer";

/**
 * 列表选择原语（listbox）：触发器 + 弹出选项的唯一实现。
 *
 * 此前是两份几乎逐字重复的实现（`SelectField` 与 Git 面板的 `GitCompactFilter`），
 * 而 AGENTS.md 为「SelectField 不满足需求时」写了一条手工配方：`button + role="listbox"`、
 * `ChevronDown`、Esc 关闭、点击外部关闭、方向键打开。配方本身就是这个 module 缺席的证据。
 * 现在 ARIA 结构与键盘行为只写一次，选择逻辑与关闭层（`dismissableLayer`）分开：
 * 本组件只负责「选项怎么被选中」，关闭与焦点归还由关闭层负责。
 */

export type ListboxOption = {
	value: string;
	label: ReactNode;
	disabled?: boolean;
};

export type ListboxProps = {
	value: string;
	options: ListboxOption[];
	onSelect: (value: string) => void;
	/** 同时包含触发器与弹层的容器：落在它内部的指针事件不算「点外部」。 */
	containerRef: RefObject<HTMLElement | null>;
	/** 触发器的可访问名（无可见 label 时必填）。 */
	ariaLabel?: string;
	disabled?: boolean;
	triggerClassName: string;
	valueClassName: string;
	menuClassName: string;
	optionClassName: string;
	activeOptionClassName?: string;
	chevronSize?: number;
	/** 展开状态影响样式时使用（Git 面板的 chevron 会旋转）。 */
	chevronClassName?: string | ((open: boolean) => string);
	/** 触发器里值文本之后的额外交互元素（如 Git 面板的计数徽标）。 */
	triggerExtra?: ReactNode;
	/** 选中项右侧的装饰（如 Git 面板的对勾）。 */
	renderOptionTrailing?: (option: ListboxOption, selected: boolean) => ReactNode;
	/** 无匹配选项时显示在触发器里的文本。 */
	fallbackLabel?: ReactNode;
};

/**
 * 触发器与弹层共用一套状态：open / 最近一次打开方式（决定要不要把焦点移进选项）/ 键盘导航下标。
 * 关闭走 `dismissableLayer`，Esc 与外部点击不在这里重复实现。
 */
export function Listbox(props: ListboxProps) {
	const [open, setOpen] = useState(false);
	const [focusIndex, setFocusIndex] = useState(-1);
	const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const listboxId = useId();
	const selected = props.options.find((option) => option.value === props.value);

	const close = useCallback(() => setOpen(false), []);

	useDismissableLayer({
		open,
		elementRef: props.containerRef,
		onDismiss: close,
		// Esc 前焦点在选项上时归还给触发器；鼠标点外部时关闭层不会抢焦点。
		returnFocusRef: triggerRef,
	});

	// 键盘打开才把焦点移进选项：鼠标点击时焦点留在触发器上，与原生 select 一致。
	useEffect(() => {
		if (!open || focusIndex < 0) return;
		optionRefs.current[focusIndex]?.focus();
	}, [open, focusIndex]);

	const selectedIndex = Math.max(
		0,
		props.options.findIndex((option) => option.value === props.value),
	);

	const openWithKeyboard = () => {
		if (props.disabled) return;
		setFocusIndex(selectedIndex);
		setOpen(true);
	};

	const moveFocus = (delta: number) => {
		const count = props.options.length;
		if (count === 0) return;
		const start = focusIndex < 0 ? selectedIndex : focusIndex;
		let next = start;
		for (let step = 0; step < count; step += 1) {
			next = (next + delta + count) % count;
			if (!props.options[next]?.disabled) break;
		}
		setFocusIndex(next);
	};

	const select = (option: ListboxOption) => {
		if (props.disabled || option.disabled) return;
		props.onSelect(option.value);
		setOpen(false);
		// 选完后焦点回触发器：否则焦点随卸载的选项一起消失，下一个 Tab 从文档头开始。
		triggerRef.current?.focus();
	};

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				className={props.triggerClassName}
				disabled={props.disabled}
				aria-label={props.ariaLabel}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? listboxId : undefined}
				onClick={() => {
					if (props.disabled) return;
					setFocusIndex(-1);
					setOpen((current) => !current);
				}}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						openWithKeyboard();
						return;
					}
					if (event.key === "Enter" || event.key === " ") {
						// Enter/Space 由 button 自身的 click 处理，这里只需保证不会顺带提交表单。
						if (open) event.preventDefault();
					}
				}}
			>
				<span className={props.valueClassName}>
					{selected?.label ?? props.fallbackLabel ?? props.value}
				</span>
				{props.triggerExtra}
				<ChevronDown
					size={props.chevronSize ?? 15}
					strokeWidth={2.2}
					className={
						typeof props.chevronClassName === "function"
							? props.chevronClassName(open)
							: props.chevronClassName
					}
					aria-hidden="true"
				/>
			</button>
			{open && !props.disabled && (
				<div
					id={listboxId}
					className={props.menuClassName}
					role="listbox"
					onKeyDown={(event) => {
						switch (event.key) {
							case "ArrowDown":
								event.preventDefault();
								moveFocus(1);
								return;
							case "ArrowUp":
								event.preventDefault();
								moveFocus(-1);
								return;
							case "Home":
								event.preventDefault();
								setFocusIndex(0);
								return;
							case "End":
								event.preventDefault();
								setFocusIndex(props.options.length - 1);
								return;
							case "Tab":
								// 焦点留在菜单里会随菜单卸载一起丢失（下一个 Tab 从文档头开始），
								// 所以显式收回触发器，再让用户自己按下一次 Tab 继续。
								event.preventDefault();
								triggerRef.current?.focus();
								setOpen(false);
								return;
							default:
								return;
						}
					}}
				>
					{props.options.map((option, index) => {
						const isSelected = option.value === props.value;
						return (
							<button
								key={option.value}
								ref={(node) => {
									optionRefs.current[index] = node;
								}}
								type="button"
								className={[
									props.optionClassName,
									isSelected ? props.activeOptionClassName ?? "active" : "",
								]
									.filter(Boolean)
									.join(" ")}
								role="option"
								aria-selected={isSelected}
								disabled={option.disabled}
								tabIndex={-1}
								onClick={() => select(option)}
								onKeyDown={(event) => {
									if (event.key !== "Enter" && event.key !== " ") return;
									event.preventDefault();
									select(option);
								}}
							>
								{option.label}
								{props.renderOptionTrailing?.(option, isSelected)}
							</button>
						);
					})}
				</div>
			)}
		</>
	);
}
