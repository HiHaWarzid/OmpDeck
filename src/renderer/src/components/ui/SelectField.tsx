import { useRef, type ReactNode } from "react";
import { Listbox, type ListboxOption } from "./Listbox";

export type SelectFieldOption = ListboxOption;

/**
 * 带标签的下拉选择器。ARIA 结构、键盘行为与关闭逻辑全在 `Listbox`（详见该模块注释），
 * 本组件只负责「标签 + 说明文字」这层表单外壳，不再自己挂 document 监听。
 */
export function SelectField(props: {
	label: ReactNode;
	value: string;
	options: SelectFieldOption[];
	onChange: (value: string) => void;
	className?: string;
	description?: ReactNode;
	disabled?: boolean;
}) {
	const containerRef = useRef<HTMLDivElement>(null);

	return (
		<div
			ref={containerRef}
			className={["ui-field ui-select-field", props.className]
				.filter(Boolean)
				.join(" ")}
		>
			<span className="ui-field-label">{props.label}</span>
			<Listbox
				containerRef={containerRef}
				value={props.value}
				options={props.options}
				onSelect={props.onChange}
				disabled={props.disabled}
				triggerClassName="ui-select-control"
				valueClassName="ui-select-value"
				menuClassName="ui-select-menu"
				optionClassName="ui-select-option"
				chevronSize={15}
				// 与旧实现一致：值不在选项里时回退到第一个选项的标签，
				// 而不是显示原始 value（20 个调用点的空值显示保持原样）。
				fallbackLabel={props.options[0]?.label}
			/>
			{props.description && (
				<small className="ui-field-description">{props.description}</small>
			)}
		</div>
	);
}
