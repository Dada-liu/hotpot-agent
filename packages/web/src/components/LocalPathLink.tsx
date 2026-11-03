// 会话区本地路径的可点击渲染：点击经 OpenLocalPathContext 调 App 的 openLocalPath，
// 在右侧面板新开/激活预览 tab。Markdown 行内 code 与普通文本共用。

import {
	createContext,
	type ReactElement,
	type ReactNode,
	useContext,
} from "react";
import { cn } from "@/lib/utils";

// App 根组件提供实际实现；默认空操作（单测/组件独立渲染时不炸）
export const OpenLocalPathContext = createContext<(path: string) => void>(
	() => undefined,
);

export function LocalPathLink({
	path,
	className,
	children,
}: {
	path: string;
	// 场景化样式覆写（如行内 code 的 mono 字号），缺省按正文链接样式
	className?: string;
	children?: ReactNode;
}): ReactElement {
	const openLocalPath = useContext(OpenLocalPathContext);
	return (
		<button
			type="button"
			title={path}
			onClick={() => {
				openLocalPath(path);
			}}
			className={cn(
				"cursor-pointer text-brand underline decoration-dotted underline-offset-2 hover:opacity-80",
				className,
			)}
		>
			{children ?? path}
		</button>
	);
}
