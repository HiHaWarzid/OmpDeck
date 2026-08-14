import type { PiDesktopApi } from "../../shared/api";

declare global {
  interface Window {
    piDesktop: PiDesktopApi;
  }
}

export {};

/** <webview> 是 Electron 的自定义元素，React JSX 需要显式声明类型。 */
declare namespace JSX {
	interface IntrinsicElements {
		webview: React.DetailedHTMLProps<
			React.HTMLAttributes<HTMLElement> & {
				src?: string;
				allowpopups?: boolean;
			},
			HTMLElement
		>;
	}
}
