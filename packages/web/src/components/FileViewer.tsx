// 右侧面板文件 tab 内容。
// 文件夹：面包屑（tab 根目录 → 当前目录）+ 单层列表导航（点击 dir 进子级、
// 点击 file 经 onOpenPath 新开/激活文件 tab）；文件：按扩展名分派——
// 图片走 blob objectURL 预览、文本 pre 展示、白名单外占位。
// 目录导航态存本组件，App 以 tab.path 为 key 重置（切 tab/会话归零）。

import { ChevronRight, FileText, Folder, Loader2 } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { baseName, isImageFileName, isTextFileName } from "@/lib/local-path";
import { cn } from "@/lib/utils";
import {
	type FsEntry,
	fetchViewerRaw,
	listViewerDir,
	readViewerText,
} from "../api.ts";

// 右侧文件 tab 描述：path 为绝对路径（stat 判型），kind 决定渲染分支
export interface FileViewerTab {
	path: string;
	kind: "file" | "dir";
}

interface FileViewerProps {
	sessionId: string;
	tab: FileViewerTab;
	// 文件夹视图里点文件：App 侧新开/激活文件 tab
	onOpenPath: (path: string) => void;
}

export function FileViewer({
	sessionId,
	tab,
	onOpenPath,
}: FileViewerProps): ReactElement {
	return (
		<div className="flex h-full min-h-0 flex-col">
			{tab.kind === "dir" ? (
				<FolderView
					sessionId={sessionId}
					root={tab.path}
					onOpenPath={onOpenPath}
				/>
			) : (
				<FileView sessionId={sessionId} path={tab.path} />
			)}
		</div>
	);
}

// 三态占位：loading（转圈）/ error（服务端 message）
function StateBox({
	loading,
	text,
}: {
	loading?: boolean;
	text: string;
}): ReactElement {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
			{loading === true && <Loader2 className="size-4 animate-spin" />}
			<span className="break-all text-center">{text}</span>
		</div>
	);
}

// 面包屑：root 打头（点击回根），其后为相对 root 的逐段路径（点击回跳该层）
function Breadcrumbs({
	root,
	current,
	onNavigate,
}: {
	root: string;
	current: string;
	onNavigate: (path: string) => void;
}): ReactElement {
	// current 不是 root 前缀时（异常路径）只显示 root 段，避免切片错位
	const prefix = root.endsWith("/") ? root : `${root}/`;
	const segments =
		current === root
			? []
			: current.startsWith(prefix)
				? current.slice(root.length).split("/").filter(Boolean)
				: [];
	let acc = root;
	const crumbs: { name: string; path: string }[] = [
		{ name: baseName(root) || root, path: root },
	];
	for (const seg of segments) {
		acc = `${acc}/${seg}`;
		crumbs.push({ name: seg, path: acc });
	}
	return (
		<div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b px-3 py-2 text-xs">
			{crumbs.map((c, i) => (
				<span key={c.path} className="flex items-center gap-0.5">
					{i > 0 && <ChevronRight className="size-3 text-muted-foreground" />}
					<button
						type="button"
						title={c.path}
						onClick={() => {
							onNavigate(c.path);
						}}
						className={cn(
							"max-w-32 truncate rounded px-1 py-0.5 hover:bg-secondary",
							i === crumbs.length - 1
								? "font-medium text-foreground"
								: "text-muted-foreground",
						)}
					>
						{c.name}
					</button>
				</span>
			))}
		</div>
	);
}

// 文件夹视图：单层列表 + 面包屑进入子文件夹（不做内联展开树）
function FolderView({
	sessionId,
	root,
	onOpenPath,
}: {
	sessionId: string;
	root: string;
	onOpenPath: (path: string) => void;
}): ReactElement {
	const [current, setCurrent] = useState(root);
	const [entries, setEntries] = useState<FsEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setEntries(null);
		setError(null);
		listViewerDir(sessionId, current).then(
			(list) => {
				if (!cancelled) setEntries(list);
			},
			(err: unknown) => {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : String(err));
				}
			},
		);
		return () => {
			cancelled = true;
		};
	}, [sessionId, current]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<Breadcrumbs
				root={root}
				current={current}
				onNavigate={(p) => {
					setCurrent(p);
				}}
			/>
			{error !== null ? (
				<StateBox text={error} />
			) : entries === null ? (
				<StateBox loading text="加载目录…" />
			) : entries.length === 0 ? (
				<StateBox text="空目录" />
			) : (
				<ul className="min-h-0 flex-1 overflow-y-auto py-1">
					{entries.map((e) => (
						<li key={e.path}>
							<button
								type="button"
								title={e.path}
								onClick={() => {
									if (e.kind === "dir") {
										setCurrent(e.path);
									} else {
										onOpenPath(e.path);
									}
								}}
								className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs hover:bg-secondary/70"
							>
								{e.kind === "dir" ? (
									<Folder className="size-3.5 shrink-0 text-muted-foreground" />
								) : (
									<FileText className="size-3.5 shrink-0 text-muted-foreground" />
								)}
								<span className="truncate">{e.name}</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

// 文件视图：按扩展名分派渲染
function FileView({
	sessionId,
	path,
}: {
	sessionId: string;
	path: string;
}): ReactElement {
	const name = baseName(path);
	if (isImageFileName(name)) {
		return <ImageView sessionId={sessionId} path={path} />;
	}
	if (isTextFileName(name)) {
		return <TextView sessionId={sessionId} path={path} />;
	}
	return (
		<StateBox
			text={`暂不支持预览 .${name.includes(".") ? name.split(".").pop() : ""} 文件`}
		/>
	);
}

// 图片预览：fetchViewerRaw 拿 Blob 转 objectURL（<img> 带不了 Bearer），
// 卸载/换图时 revoke 防泄漏
function ImageView({
	sessionId,
	path,
}: {
	sessionId: string;
	path: string;
}): ReactElement {
	const [url, setUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		let objectUrl: string | null = null;
		setUrl(null);
		setError(null);
		fetchViewerRaw(sessionId, path).then(
			(blob) => {
				if (cancelled) return;
				objectUrl = URL.createObjectURL(blob);
				setUrl(objectUrl);
			},
			(err: unknown) => {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : String(err));
				}
			},
		);
		return () => {
			cancelled = true;
			if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
		};
	}, [sessionId, path]);

	if (error !== null) return <StateBox text={error} />;
	if (url === null) return <StateBox loading text="加载图片…" />;
	return (
		<div className="min-h-0 flex-1 overflow-auto p-3">
			<img
				src={url}
				alt={baseName(path)}
				className="mx-auto h-auto max-h-full w-auto max-w-full rounded-md border"
			/>
		</div>
	);
}

// 文本预览：readViewerText（扩展名白名单 + 1MB 上限由服务端把关）
function TextView({
	sessionId,
	path,
}: {
	sessionId: string;
	path: string;
}): ReactElement {
	const [content, setContent] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setContent(null);
		setError(null);
		readViewerText(sessionId, path).then(
			(r) => {
				if (!cancelled) setContent(r.content);
			},
			(err: unknown) => {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : String(err));
				}
			},
		);
		return () => {
			cancelled = true;
		};
	}, [sessionId, path]);

	if (error !== null) return <StateBox text={error} />;
	if (content === null) return <StateBox loading text="加载文件…" />;
	return (
		<pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">
			{content}
		</pre>
	);
}
