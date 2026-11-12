// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStableHandlers } from "./useStableHandlers";

// React 18+ 的 act 环境标记：与仓库其它组件测试一致，避免 IS_REACT_ACT_ENVIRONMENT 警告
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("useStableHandlers", () => {
	it("引用恒定，但调用落到最近一次渲染的实现", () => {
		const seen: string[] = [];
		let forwarded: { run: (value: string) => void } | null = null;
		function Probe({ label }: { label: string }) {
			forwarded = useStableHandlers({
				run: (value: string) => {
					seen.push(`${label}:${value}`);
				},
			});
			return null;
		}

		act(() => root.render(<Probe label="first" />));
		const first = forwarded!;
		act(() => first.run("a"));

		act(() => root.render(<Probe label="second" />));
		const second = forwarded!;

		expect(second).toBe(first);
		act(() => second.run("b"));
		expect(seen).toEqual(["first:a", "second:b"]);
	});

	it("参数原样透传（含多个参数与返回值）", () => {
		let sum: ((a: number, b: number) => number) | null = null;
		function Probe() {
			sum = useStableHandlers({ run: (a: number, b: number) => a + b }).run;
			return null;
		}
		act(() => root.render(<Probe />));
		expect(sum!(2, 3)).toBe(5);
	});
});
